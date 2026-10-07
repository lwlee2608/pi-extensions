import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { Launch } from "./profiles.ts";
import { launchChild, literalInput, type Child, type ChildEvent } from "./rpc.ts";
import { loadConfig } from "./profiles.ts";
import { Store, prerequisites, verifyPrerequisites, type Prerequisites } from "./store.ts";

export type Outcome = "completed" | "failed" | "interrupted";
export interface Result { outcome: Outcome; text: string; error?: string; endedAt: number; usage: Usage }
export interface Run { runId: string; workerId: string; label: string; startedAt: number; result?: Result }
export interface Question { questionId: string; workerId: string; runId: string; generation: string; requestId: string; question: string; state: "pending" | "answered" | "cancelled" }
export interface Snapshot {
  workerId: string; runId: string; state: "queued" | "working" | "blocked" | "idle" | "closed"; lifetime: "once" | "retained";
  label: string; cwd: string; model: string; effort: string; pid?: number; processAlive?: boolean; sessionId: string; sessionFile?: string;
  activity: string; output: string; startedAt: number; result?: Result; error?: string; questions?: Question[]; recoverable?: boolean;
}
interface Worker {
  view: Snapshot; launch: Launch; directory: string; child?: Child; run: Run; lock: Promise<unknown>;
  accepted: boolean; settled: boolean; last?: Pick<AssistantMessage, "stopReason" | "errorMessage">;
  usage: Usage; stopping: boolean; reservation: boolean; recoveryError?: string;
  task: string; slot: boolean; generation: string; activeTools: Map<string, string>; ready: boolean; prerequisites: Prerequisites; uncertain: boolean;
}
export interface WaitResult { reason: "completed" | "timeout" | "attention"; runs: Run[]; workers: Snapshot[]; pendingQuestionIds: string[] }
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
  private maxActive: number;
  private questions = new Map<string, Question>();
  private store: Store;
  private shutdownPromise?: Promise<void>;
  private usageWarning?: string;
  private spawn: typeof launchChild;
  constructor(options: { root: string; parentId: string; maxWorkers?: number; maxActive?: number; spawn?: typeof launchChild }) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,150}$/.test(options.parentId)) throw new Error("Invalid parent session ID");
    this.root = join(options.root, options.parentId);
    this.maxWorkers = options.maxWorkers ?? 16;
    this.maxActive = options.maxActive ?? 4;
    this.spawn = options.spawn ?? launchChild;
    this.events.setMaxListeners(0);
    this.store = new Store(options.root, options.parentId);
    try {
      for (const id of this.store.readReported()) this.reported.add(id);
      for (const saved of this.store.readAll()) {
        const run = saved.runs.find(r => r.runId === saved.view.runId)!;
        for (const history of saved.runs) this.runs.set(history.runId, history);
        for (const id of saved.reported) this.reported.add(id);
        const view = saved.view;
        for (const question of view.questions ?? []) { if (question.state === "pending") question.state = "cancelled"; this.questions.set(question.questionId, question); }
        if (!run.result) run.result = { outcome: "interrupted", text: view.output.slice(-4096), error: "Parent stopped before this run completed; never replayed", endedAt: Date.now(), usage: zeroUsage() };
        view.result = run.result; view.state = "closed";
        const uncertain = saved.ownership !== "closed";
        view.recoverable = !uncertain && view.lifetime === "retained" && !!view.sessionFile;
        if (uncertain) view.error = "Old process ownership is uncertain; recovery refused";
        const worker: Worker = { view, launch: saved.launch, directory: join(this.root, view.workerId), run, lock: Promise.resolve(), accepted: false,
          settled: false, usage: zeroUsage(), stopping: true, reservation: uncertain, task: "", slot: false,
          generation: saved.generation, activeTools: new Map(), ready: false, prerequisites: saved.prerequisites, uncertain };
        this.workers.set(view.workerId, worker);
      }
      if (this.runs.size > 2048) throw new Error("Stored task history exceeds limit");
      for (const worker of this.workers.values()) if (!worker.uncertain) this.save(worker);
    } catch (error) { this.store.close(); throw error; }
  }
  private save(worker: Worker): void {
    try { this.store.save({ version: 1, parentId: this.store.parentId, view: worker.view, launch: worker.launch,
      runs: [...this.runs.values()].filter(r => r.workerId === worker.view.workerId), generation: worker.generation,
      prerequisites: worker.prerequisites, reported: [...this.reported].filter(id => this.runs.get(id)?.workerId === worker.view.workerId),
      ownership: worker.reservation ? "owned" : "closed" }); }
    catch (error) {
      worker.stopping = true;
      worker.view.recoverable = false;
      worker.view.error = `Persistence failed; worker cannot accept work: ${errorText(error)}`;
      if (worker.child && !worker.child.exited) void worker.child.close().catch(error => this.recordError(worker, error));
      throw error;
    }
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
    if (this.runs.size >= 2048) throw new Error("Session history limit reached (2048 tasks); use a new parent session. Saved results remain on disk.");
  }
  private newRun(workerId: string, label: string): Run {
    const run = { workerId, runId: `r-${randomUUID()}`, label, startedAt: Date.now() };
    this.runs.set(run.runId, run);
    return run;
  }
  start(launch: Launch, task: string, lifetime: "once" | "retained" = "once", label = launch.profile.name): Snapshot {
    this.checkTaskSlot();
    launch = structuredClone(launch);
    const required = prerequisites(launch);
    if ([...this.workers.values()].filter(w => w.reservation).length >= this.maxWorkers) throw new Error(`Worker process cap reached (${this.maxWorkers}); stop an idle retained worker`);
    const workerId = `w-${randomUUID()}`, sessionId = randomUUID();
    const run = this.newRun(workerId, label);
    const view: Snapshot = { workerId, runId: run.runId, sessionId, lifetime, label, state: "queued", cwd: launch.cwd,
      model: `${launch.provider}/${launch.model}`, effort: launch.effort, activity: "queued", output: "", startedAt: run.startedAt, questions: [] };
    const worker: Worker = { view, launch, run, directory: join(this.root, workerId), lock: Promise.resolve(),
      accepted: false, settled: false, usage: zeroUsage(), stopping: false, reservation: true, task, slot: false, generation: randomUUID(), activeTools: new Map(), ready: false, prerequisites: required, uncertain: false };
    this.workers.set(workerId, worker);
    try { this.save(worker); }
    catch (error) { this.workers.delete(workerId); this.runs.delete(run.runId); throw error; }
    this.schedule();
    this.changed();
    return structuredClone(view);
  }
  private schedule(): void {
    if (this.closing) return;
    for (const worker of this.workers.values()) {
      if ([...this.workers.values()].filter(w => w.slot).length >= this.maxActive) break;
      if (worker.view.state !== "queued" || worker.stopping) continue;
      worker.slot = true;
      worker.view.state = "working";
      worker.view.activity = worker.child ? "dispatching" : "starting";
      void this.exclusive(worker, () => this.executeTask(worker)).catch(error => this.recordError(worker, error));
    }
  }
  private async executeTask(worker: Worker): Promise<void> {
    try {
      if (worker.stopping) return;
      if (!worker.child) {
        let subscribed = false;
        const own = (child: Child) => {
          worker.child = child;
          worker.view.pid = child.pid;
          worker.view.processAlive = true;
          child.onEvent(event => this.event(worker, event));
          child.onExit(error => this.exited(worker, child, error));
          subscribed = true;
        };
        worker.child = await this.spawn(worker.launch, worker.directory, worker.view.sessionId, own);
        if (!subscribed) own(worker.child);
        const state = (await worker.child.request({ type: "get_state" })).data;
        worker.view.sessionFile = state.sessionFile;
        worker.ready = true;
      }
      this.save(worker);
      if (!worker.stopping) await this.dispatch(worker, worker.task);
    } catch (error) { await this.finish(worker, "failed", errorText(error)); await this.closeWorker(worker); }
  }
  private async dispatch(worker: Worker, task: string): Promise<void> {
    const response = await worker.child!.request({ type: "prompt", message: literalInput(task) });
    if (response.data.disposition !== "started") throw new Error(`Prompt was ${response.data.disposition}, not accepted as a task`);
    worker.accepted = true;
    if (worker.view.state !== "blocked" && !worker.activeTools.size) worker.view.activity = worker.settled ? "settling" : "working";
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
        let result;
        try { result = await worker.child!.request({ type: "steer", message: literalInput(message) }); }
        catch (error) {
          worker.stopping = true;
          try { await this.closeWorker(worker); }
          finally { await this.finish(worker, "interrupted", `Steering delivery uncertain: ${errorText(error)}`); }
          throw new Error(`Steering delivery uncertain; worker closed or requires cleanup: ${errorText(error)}`);
        }
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
    Object.assign(worker.view, { runId: worker.run.runId, label: worker.run.label, state: "queued", startedAt: worker.run.startedAt,
      result: undefined, error: undefined, output: "", activity: "dispatching" });
    worker.accepted = false; worker.settled = false; worker.last = undefined; worker.recoveryError = undefined; worker.usage = zeroUsage();
    worker.task = message;
    worker.view.activity = "queued";
    try { this.save(worker); }
    catch (error) { worker.stopping = true; void this.stop(id).catch(error => this.recordError(worker, error)); throw error; }
    this.schedule();
    this.changed();
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
      case "subagent_question": {
        if (!worker.ready || worker.view.questions!.length >= 128 || worker.view.questions!.some(q => q.requestId === event.requestId)) {
          void this.stop(worker.view.workerId).catch(error => this.recordError(worker, error));
          break;
        }
        const question: Question = { questionId: `q-${randomUUID()}`, workerId: worker.view.workerId, runId: worker.run.runId,
          generation: worker.generation, requestId: event.requestId, question: event.question, state: "pending" };
        this.questions.set(question.questionId, question); worker.view.questions!.push(question);
        worker.view.state = "blocked"; worker.view.activity = "awaiting parent reply";
        try { this.save(worker); }
        catch (error) { this.recordError(worker, error); void this.stop(worker.view.workerId).catch(error => this.recordError(worker, error)); }
        break;
      }
      case "message_update":
        if (event.assistantMessageEvent.type === "text_delta") worker.view.output = (worker.view.output + event.assistantMessageEvent.delta).slice(-8192);
        break;
      case "message_end":
        if (event.message.role === "assistant") {
          worker.last = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage };
          if (event.message.stopReason === "stop") worker.recoveryError = undefined;
          worker.view.output = event.message.content.filter(c => c.type === "text").map(c => c.text).join("\n").slice(-8192);
          addUsage(worker.usage, event.message.usage);
        } else if (event.message.role === "toolResult") addUsage(worker.usage, event.message.usage);
        break;
      case "compaction_end":
        addUsage(worker.usage, event.result?.usage);
        if (event.errorMessage || event.aborted) worker.recoveryError = event.errorMessage ?? "Child recovery was aborted";
        break;
      case "auto_retry_end":
        if (!event.success) worker.recoveryError = event.finalError ?? "Child retries failed";
        break;
      case "tool_execution_start":
        worker.activeTools.set(event.toolCallId, event.toolName);
        if (worker.view.state !== "blocked") worker.view.activity = `tool: ${[...worker.activeTools.values()].join(", ")}`;
        break;
      case "tool_execution_end":
        worker.activeTools.delete(event.toolCallId);
        if (worker.view.state !== "blocked") worker.view.activity = worker.activeTools.size ? `tool: ${[...worker.activeTools.values()].join(", ")}` : event.isError ? `tool failed: ${event.toolName}` : "working";
        break;
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
    let cleared;
    try { cleared = await worker.child!.request({ type: "clear_queue" }); }
    catch (error) {
      worker.stopping = true;
      try { await this.closeWorker(worker); }
      finally { await this.finish(worker, "failed", `Could not settle child queue: ${errorText(error)}`); }
      return;
    }
    if (cleared.data.steering.length || cleared.data.followUp.length) worker.view.error = "Child settled with unconsumed guidance; cleared it instead of forwarding to another run";
    const last = worker.last;
    const error = worker.view.error ?? worker.recoveryError ?? last?.errorMessage;
    const outcome: Outcome = last?.stopReason === "aborted" ? "interrupted" : error || !last || !["stop", "length"].includes(last.stopReason) ? "failed" : "completed";
    await this.finish(worker, outcome, outcome === "completed" ? undefined : error ?? "Child settled without a successful final response");
    if (worker.view.lifetime === "once") await this.closeWorker(worker);
  }
  private async finish(worker: Worker, outcome: Outcome, error?: string): Promise<void> {
    if (worker.run.result) return;
    const result: Result = { outcome, ...(error === undefined ? {} : { error }), text: worker.view.output.slice(-4096), endedAt: Date.now(), usage: structuredClone(worker.usage) };
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
    worker.slot = false;
    this.cancelQuestions(worker);
    try { this.save(worker); }
    finally { this.schedule(); this.changed(); }
  }
  private exited(worker: Worker, child: Child, error: Error): void {
    if (worker.child !== child) return;
    this.cancelQuestions(worker);
    worker.reservation = false;
    worker.view.processAlive = false;
    worker.view.state = "closed";
    void this.exclusive(worker, async () => {
      if (worker.child !== child) return;
      if (!worker.run.result) await this.finish(worker, worker.stopping ? "interrupted" : "failed", errorText(error));
      worker.view.state = "closed";
      worker.view.recoverable = worker.view.lifetime === "retained" && !!worker.view.sessionFile;
      this.save(worker);
      this.changed();
    }).catch(error => this.recordError(worker, error));
    this.changed();
  }
  private recordError(worker: Worker, error: unknown): void { worker.view.error = errorText(error); this.changed(); }
  private async closeWorker(worker: Worker): Promise<void> {
    worker.stopping = true;
    this.cancelQuestions(worker);
    if (worker.child) await worker.child.close();
    worker.view.processAlive = false;
    worker.reservation = false;
    worker.view.state = "closed";
    worker.view.recoverable = worker.view.lifetime === "retained" && !!worker.view.sessionFile;
    this.save(worker);
    this.changed();
  }
  async stop(id: string): Promise<Snapshot> {
    const worker = this.worker(id);
    if (worker.uncertain) throw new Error("Old process ownership is uncertain; refusing to claim successful stop");
    worker.stopping = true;
    this.cancelQuestions(worker);
    return this.exclusive(worker, async () => {
      await this.closeWorker(worker);
      await this.finish(worker, "interrupted", "Stopped by parent");
      return structuredClone(worker.view);
    });
  }
  async recover(id: string): Promise<Snapshot> {
    const worker = this.worker(id);
    return this.exclusive(worker, async () => {
      if (this.closing || worker.uncertain || worker.reservation || worker.view.state !== "closed" || worker.view.lifetime !== "retained") throw new Error("Recovery requires a closed retained worker with certain ownership in the original parent");
      if ([...this.workers.values()].filter(w => w.reservation).length >= this.maxWorkers) throw new Error("Worker process cap reached");
      worker.reservation = true;
      worker.stopping = false;
      try {
        const config = await loadConfig(worker.launch.agentDir);
        const saved = { version: 1 as const, parentId: this.store.parentId, view: worker.view, launch: worker.launch,
          runs: [worker.run], generation: worker.generation, prerequisites: worker.prerequisites, reported: [], ownership: "closed" as const };
        verifyPrerequisites(saved, Object.values(config.extensions), config.trustedProjectRoots);
        if (worker.stopping || this.closing) throw new Error("Recovery cancelled during prerequisite validation");
        worker.generation = randomUUID(); worker.ready = false; worker.settled = false; worker.accepted = false;
        worker.view.recoverable = false; worker.view.error = undefined;
        this.save(worker);
        const own = (child: Child) => {
          worker.child = child; worker.view.pid = child.pid; worker.view.processAlive = true;
          child.onEvent(event => this.event(worker, event)); child.onExit(error => this.exited(worker, child, error));
        };
        worker.child = await this.spawn(worker.launch, worker.directory, worker.view.sessionId, own, worker.view.sessionFile);
        if (worker.stopping || this.closing) throw new Error("Recovery cancelled during child startup");
        worker.ready = true;
        worker.view.state = "idle"; worker.view.activity = "recovered; awaiting an explicit new task";
        this.save(worker); this.changed();
        return structuredClone(worker.view);
      } catch (error) {
        worker.view.error = errorText(error);
        await this.closeWorker(worker);
        throw error;
      }
    });
  }
  private cancelQuestions(worker: Worker): void {
    for (const question of worker.view.questions ?? []) if (question.state === "pending") question.state = "cancelled";
    this.changed();
  }
  async reply(id: string, message?: string, cancelled = false): Promise<{ questionId: string; delivered: boolean; cancelled: boolean }> {
    const question = this.questions.get(id);
    if (!question || question.state !== "pending") throw new Error("Unknown, stale or already answered question");
    const worker = this.worker(question.workerId);
    if (question.generation !== worker.generation || question.runId !== worker.run.runId || worker.stopping || !worker.child || worker.child.exited) throw new Error("Question no longer belongs to a live child generation");
    if (cancelled) { await this.stop(worker.view.workerId); return { questionId: id, delivered: false, cancelled: true }; }
    if (typeof message !== "string" || !message.trim()) throw new Error("A reply requires a nonblank message");
    return this.exclusive(worker, async () => {
      if (question.state !== "pending" || worker.stopping) throw new Error("Stale or duplicate reply");
      try { await worker.child!.reply(question.requestId, message); }
      catch (error) {
        worker.stopping = true;
        try { await this.closeWorker(worker); } finally { await this.finish(worker, "interrupted", `Reply delivery uncertain: ${errorText(error)}`); }
        throw error;
      }
      question.state = "answered";
      this.save(worker);
      if (!worker.view.questions!.some(q => q.state === "pending")) { worker.view.state = "working"; worker.view.activity = "working"; }
      this.changed();
      return { questionId: id, delivered: true, cancelled: false };
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
        resolve({ reason, runs, workers: [...new Set(runs.map(r => r.workerId))].flatMap(id => this.status(id)), pendingQuestionIds: [...this.questions.values()].filter(q => q.state === "pending").map(q => q.questionId) });
      };
      const check = () => {
        if ([...this.questions.values()].some(q => q.state === "pending")) { done("attention"); return; }
        const terminal = runIds.map(id => !!this.runs.get(id)!.result);
        if (mode === "all" ? terminal.every(Boolean) : terminal.some(Boolean)) done("completed");
      };
      const cancel = () => { cleanup(); reject(signal?.reason ?? new Error("Wait cancelled")); };
      const timer = setTimeout(() => done("timeout"), timeoutMs);
      this.events.on("change", check);
      signal?.addEventListener("abort", cancel, { once: true });
      check();
    });
  }
  takeUsage(): Usage | undefined {
    const usage = zeroUsage(), pending: string[] = [];
    for (const [id, run] of this.runs) if (run.result && !this.reported.has(id)) {
      pending.push(id); addUsage(usage, run.result.usage);
    }
    if (!pending.length) return;
    try { this.usageWarning = this.store.checkpointUsage([...this.reported, ...pending]); }
    catch (error) {
      this.usageWarning = `Usage remains pending after checkpoint failure: ${errorText(error)}`;
      return;
    }
    for (const id of pending) this.reported.add(id);
    return usage;
  }
  takeUsageWarning(): string | undefined { const warning = this.usageWarning; this.usageWarning = undefined; return warning; }
  shutdown(): Promise<void> { return this.shutdownPromise ??= this.closeAll(); }
  private async closeAll(): Promise<void> {
    this.closing = true;
    const results = await Promise.allSettled([...this.workers.keys()].map(id => this.stop(id)));
    const failures = results.filter(r => r.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(r => r.reason), "Subagent cleanup failed; ownership lock retained");
    this.store.close();
  }
}
