import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { Launch } from "./profiles.ts";
import { launchChild, literalInput, type Child, type ChildEvent } from "./rpc.ts";

export type Outcome = "completed" | "failed" | "interrupted";
export interface Result { outcome: Outcome; text: string; error?: string; endedAt: number; usage: Usage }
export interface Run { runId: string; workerId: string; label: string; startedAt: number; result?: Result }
export interface Snapshot {
  workerId: string; runId: string; state: "working" | "idle" | "closed"; lifetime: "once" | "retained";
  label: string; cwd: string; model: string; effort: string; pid?: number; processAlive?: boolean; sessionId: string; sessionFile?: string;
  activity: string; output: string; startedAt: number; result?: Result; error?: string;
}
interface Worker {
  view: Snapshot; launch: Launch; directory: string; child?: Child; run: Run; lock: Promise<unknown>;
  accepted: boolean; settled: boolean; last?: Pick<AssistantMessage, "stopReason" | "errorMessage">;
  usage: Usage; stopping: boolean; reservation: boolean;
}
export interface WaitResult { reason: "completed" | "timeout"; runs: Run[]; workers: Snapshot[]; pendingQuestionIds: string[] }
export function zeroUsage(): Usage { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; }
function addUsage(target: Usage, source?: Usage): void {
  if (!source) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) target[key] += source[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) target.cost[key] += source.cost[key];
}
function errorText(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 4096); }
export class Manager {
  private workers = new Map<string, Worker>();
  private runs = new Map<string, Run>();
  private reported = new Set<string>();
  private events = new EventEmitter();
  private closing = false;
  private root: string;
  private maxWorkers: number;
  private spawn: typeof launchChild;
  constructor(options: { root: string; parentId: string; maxWorkers?: number; spawn?: typeof launchChild }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(options.parentId)) throw new Error("Invalid parent session ID");
    this.root = join(options.root, options.parentId);
    this.maxWorkers = options.maxWorkers ?? 16;
    this.spawn = options.spawn ?? launchChild;
    this.events.setMaxListeners(0);
  }
  onChange(listener: () => void): () => void { this.events.on("change", listener); return () => this.events.off("change", listener); }
  private changed(): void { this.events.emit("change"); }
  private exclusive<T>(worker: Worker, operation: () => Promise<T>): Promise<T> {
    const next = worker.lock.then(operation);
    worker.lock = next.catch(() => {});
    return next;
  }
  private worker(id: string): Worker {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`Unknown worker in this parent: ${id}`);
    return worker;
  }
  private checkTaskSlot(): void {
    if (this.closing) throw new Error("Parent is shutting down");
    if ([...this.workers.values()].some(w => w.view.state === "working")) throw new Error("Phase 1 allows one active task. Wait or stop it first; parallel scheduling arrives in Phase 2.");
    if (this.runs.size >= 2048) throw new Error("Session history limit reached (2048 tasks); use a new parent session. Saved results remain on disk.");
  }
  private newRun(workerId: string, label: string): Run {
    const run = { workerId, runId: `r-${randomUUID()}`, label, startedAt: Date.now() };
    this.runs.set(run.runId, run);
    return run;
  }
  start(launch: Launch, task: string, lifetime: "once" | "retained" = "once", label = launch.profile.name): Snapshot {
    this.checkTaskSlot();
    if ([...this.workers.values()].filter(w => w.reservation).length >= this.maxWorkers) throw new Error(`Worker process cap reached (${this.maxWorkers}); stop an idle retained worker`);
    const workerId = `w-${randomUUID()}`, sessionId = randomUUID();
    const run = this.newRun(workerId, label);
    const view: Snapshot = { workerId, runId: run.runId, sessionId, lifetime, label, state: "working", cwd: launch.cwd,
      model: `${launch.provider}/${launch.model}`, effort: launch.effort, activity: "starting", output: "", startedAt: run.startedAt };
    const worker: Worker = { view, launch, run, directory: join(this.root, workerId), lock: Promise.resolve(),
      accepted: false, settled: false, usage: zeroUsage(), stopping: false, reservation: true };
    this.workers.set(workerId, worker);
    this.changed();
    void this.exclusive(worker, async () => {
      try {
        let subscribed = false;
        const own = (child: Child) => {
          worker.child = child;
          worker.view.pid = child.pid;
          worker.view.processAlive = true;
          child.onEvent(event => this.event(worker, event));
          child.onExit(error => this.exited(worker, error));
          subscribed = true;
        };
        worker.child = await this.spawn(launch, worker.directory, sessionId, own);
        if (!subscribed) own(worker.child);
        const state = (await worker.child.request({ type: "get_state" })).data;
        worker.view.sessionFile = state.sessionFile;
        if (worker.stopping) return;
        await this.dispatch(worker, task);
      } catch (error) { await this.finish(worker, "failed", errorText(error)); await this.closeWorker(worker); }
    }).catch(error => this.recordError(worker, error));
    return structuredClone(view);
  }
  private async dispatch(worker: Worker, task: string): Promise<void> {
    const response = await worker.child!.request({ type: "prompt", message: literalInput(task) });
    if (response.data.disposition !== "started") throw new Error(`Prompt was ${response.data.disposition}, not accepted as a task`);
    worker.accepted = true;
    worker.view.activity = worker.settled ? "settling" : "working";
    if (worker.settled) await this.settle(worker);
    this.changed();
  }
  async message(id: string, message: string, mode: "task" | "steer" = "task", label?: string): Promise<Snapshot> {
    const worker = this.worker(id);
    // Admission checks are synchronous, before waiting on this worker's mutation lock.
    if (mode === "steer") {
      if (worker.view.state !== "working" || !worker.accepted || !worker.child || worker.stopping || worker.settled) throw new Error("Steering requires a working child");
      return this.exclusive(worker, async () => {
        if (worker.view.state !== "working" || worker.settled || worker.stopping) throw new Error("Worker settled before steering could be delivered");
        const result = await worker.child!.request({ type: "steer", message: literalInput(message) });
        if (result.data.disposition !== "queued") throw new Error(`Steer was ${result.data.disposition}, not accepted`);
        if (worker.settled || worker.stopping) {
          await worker.child!.request({ type: "clear_queue" });
          throw new Error("Worker settled during steering; late guidance was cleared, not delivered to another task");
        }
        return structuredClone(worker.view);
      });
    }
    if (worker.view.lifetime !== "retained" || worker.view.state !== "idle" || worker.stopping) throw new Error("New tasks require an idle retained worker; busy tasks are never queued");
    this.checkTaskSlot();
    worker.run = this.newRun(id, label ?? worker.view.label);
    Object.assign(worker.view, { runId: worker.run.runId, label: worker.run.label, state: "working", startedAt: worker.run.startedAt,
      result: undefined, error: undefined, output: "", activity: "dispatching" });
    worker.accepted = false; worker.settled = false; worker.last = undefined; worker.usage = zeroUsage();
    this.changed();
    void this.exclusive(worker, async () => {
      try { if (!worker.stopping) await this.dispatch(worker, message); }
      catch (error) { await this.finish(worker, "failed", errorText(error)); await this.closeWorker(worker); }
    }).catch(error => this.recordError(worker, error));
    return structuredClone(worker.view);
  }
  private event(worker: Worker, event: ChildEvent): void {
    if (worker.run.result) return;
    if (worker.stopping) {
      if (event.type === "message_end" && (event.message.role === "assistant" || event.message.role === "toolResult")) addUsage(worker.usage, event.message.usage);
      if (event.type === "compaction_end") addUsage(worker.usage, event.result?.usage);
      return;
    }
    switch (event.type) {
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") worker.view.output = (worker.view.output + event.assistantMessageEvent.delta).slice(-8192);
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          worker.last = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage };
          worker.view.output = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n").slice(-8192);
          addUsage(worker.usage, event.message.usage);
        } else if (event.message.role === "toolResult") addUsage(worker.usage, event.message.usage);
        break;
      case "compaction_end": addUsage(worker.usage, event.result?.usage); break;
      case "tool_execution_start": worker.view.activity = `tool: ${event.toolName}`; break;
      case "tool_execution_end": worker.view.activity = event.isError ? `tool failed: ${event.toolName}` : "working"; break;
      case "extension_ui_request":
        if (["confirm", "select", "input", "editor"].includes(event.method)) {
          worker.stopping = true;
          void this.exclusive(worker, async () => {
            await this.finish(worker, "failed", `Unexpected child UI ${event.method}: refused, never auto-approved`);
            await this.closeWorker(worker);
          }).catch(error => this.recordError(worker, error));
        }
        break;
      case "extension_error": worker.view.error = event.error.slice(0, 4096); break;
      case "agent_settled":
        worker.settled = true;
        if (worker.accepted) {
          const runId = worker.run.runId;
          void this.exclusive(worker, async () => { if (worker.run.runId === runId) await this.settle(worker); }).catch(error => this.recordError(worker, error));
        }
        break;
    }
    this.changed();
  }
  private async settle(worker: Worker): Promise<void> {
    if (worker.run.result || worker.stopping) return;
    // Pi accepts steer even after its run has ended. Drain before exposing idle.
    const cleared = await worker.child!.request({ type: "clear_queue" });
    if (cleared.data.steering.length || cleared.data.followUp.length) worker.view.error = "Child settled with unconsumed guidance; cleared it instead of forwarding to another run";
    const last = worker.last;
    const error = worker.view.error ?? last?.errorMessage;
    const outcome: Outcome = last?.stopReason === "aborted" ? "interrupted" : error || !last || !["stop", "length"].includes(last.stopReason) ? "failed" : "completed";
    await this.finish(worker, outcome, outcome === "completed" ? undefined : error ?? "Child settled without a successful final response");
    if (worker.view.lifetime === "once") await this.closeWorker(worker);
  }
  private async finish(worker: Worker, outcome: Outcome, error?: string): Promise<void> {
    if (worker.run.result) return;
    const result: Result = { outcome, error, text: worker.view.output.slice(-4096), endedAt: Date.now(), usage: structuredClone(worker.usage) };
    try {
      await mkdir(worker.directory, { recursive: true, mode: 0o700 });
      const path = join(worker.directory, `${worker.run.runId}.json`), temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify({ ...worker.run, result, sessionFile: worker.view.sessionFile }), { mode: 0o600 });
      await rename(temp, path);
    } catch (error) {
      result.outcome = "failed";
      result.error = `Could not persist result: ${errorText(error)}`;
      worker.view.error = result.error;
    }
    worker.run.result = result;
    worker.view.result = result;
    worker.view.state = worker.view.lifetime === "retained" && !worker.stopping && !worker.child?.exited ? "idle" : "closed";
    worker.view.activity = result.outcome;
    this.changed();
  }
  private exited(worker: Worker, error: Error): void {
    worker.reservation = false;
    worker.view.processAlive = false;
    worker.view.state = "closed";
    void this.exclusive(worker, async () => {
      if (!worker.run.result) await this.finish(worker, worker.stopping ? "interrupted" : "failed", errorText(error));
      worker.view.state = "closed";
      this.changed();
    }).catch(error => this.recordError(worker, error));
    this.changed();
  }
  private recordError(worker: Worker, error: unknown): void { worker.view.error = errorText(error); this.changed(); }
  private async closeWorker(worker: Worker): Promise<void> {
    worker.stopping = true;
    if (worker.child) await worker.child.close();
    worker.view.processAlive = false;
    worker.reservation = false;
    worker.view.state = "closed";
    this.changed();
  }
  async stop(id: string): Promise<Snapshot> {
    const worker = this.worker(id);
    worker.stopping = true;
    return this.exclusive(worker, async () => {
      await this.closeWorker(worker);
      await this.finish(worker, "interrupted", "Stopped by parent");
      return structuredClone(worker.view);
    });
  }
  status(id?: string): Snapshot[] { return (id ? [this.worker(id)] : [...this.workers.values()]).map(w => structuredClone(w.view)); }
  async wait(runIds: string[], mode: "all" | "any" = "all", timeoutMs = 30 * 60_000, signal?: AbortSignal): Promise<WaitResult> {
    if (!runIds.length || runIds.some(id => !this.runs.has(id))) throw new Error("Wait requires known run IDs from this parent");
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.events.off("change", check); signal?.removeEventListener("abort", cancel); };
      const done = (reason: WaitResult["reason"]) => {
        cleanup();
        const runs = runIds.map(id => structuredClone(this.runs.get(id)!));
        resolve({ reason, runs, workers: [...new Set(runs.map(r => r.workerId))].flatMap(id => this.status(id)), pendingQuestionIds: [] });
      };
      const check = () => { const terminal = runIds.map(id => !!this.runs.get(id)!.result); if (mode === "all" ? terminal.every(Boolean) : terminal.some(Boolean)) done("completed"); };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("Wait cancelled")); };
      const timer = setTimeout(() => done("timeout"), timeoutMs);
      this.events.on("change", check);
      signal?.addEventListener("abort", cancel, { once: true });
      check();
    });
  }
  takeUsage(): Usage | undefined {
    const usage = zeroUsage(); let found = false;
    for (const [id, run] of this.runs) if (run.result && !this.reported.has(id)) {
      this.reported.add(id); addUsage(usage, run.result.usage); found = true;
    }
    return found ? usage : undefined;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.workers.keys()].map(id => this.stop(id)));
    const failures = results.filter(r => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Subagent cleanup failed");
  }
}
