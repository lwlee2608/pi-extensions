import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, type JsonAgentSessionEvent, type RpcCommand, type RpcResponse, type RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type { Launch } from "./profiles.ts";

export type ChildEvent = JsonAgentSessionEvent | RpcExtensionUIRequest | { type: "extension_error"; error: string };
type Response<T extends RpcCommand["type"]> = Extract<RpcResponse, { success: true; command: T }>;
export interface Child {
  readonly pid?: number;
  readonly exited: boolean;
  onEvent(listener: (event: ChildEvent) => void): () => void;
  onExit(listener: (error: Error) => void): () => void;
  request<T extends RpcCommand["type"]>(command: Extract<RpcCommand, { type: T }>, timeoutMs?: number): Promise<Response<T>>;
  close(): Promise<void>;
}
const limit = 4 * 1024 * 1024;
export class RpcProcess implements Child {
  private child: ChildProcess;
  private events = new EventEmitter();
  private pending = new Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = "";
  private stderr = "";
  private closePromise?: Promise<void>;
  private exitPromise: Promise<void>;
  private resolveExit!: () => void;
  private ready: Promise<void>;
  private startupError?: Error;
  private registeredProviders: string[] = [];
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  exited = false;
  get pid(): number | undefined { return this.child.pid; }
  constructor(cli: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, token: string) {
    this.exitPromise = new Promise(resolve => { this.resolveExit = resolve; });
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch(() => {});
    this.child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe", "ipc"] });
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.read(chunk));
    this.child.stderr!.on("data", (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-16_384); });
    this.child.stdin!.on("error", error => this.fail(error));
    this.child.on("message", value => {
      const message = value as { type?: string; token?: string; error?: string; registeredProviders?: string[] };
      if (message?.type !== "subagent_ready" || message.token !== token) return;
      if (message.error) this.rejectReady(new Error(message.error));
      else { this.registeredProviders = message.registeredProviders ?? []; this.resolveReady(); }
    });
    this.child.once("error", error => { this.fail(error); });
    this.child.once("close", (code, signal) => {
      this.exited = true;
      const error = new Error(`RPC child exited (${code ?? signal}): ${this.stderr}`);
      this.fail(error);
      this.resolveExit();
      this.events.emit("exit", error);
      this.events.removeAllListeners();
    });
  }
  async initialize(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([this.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Child bootstrap timed out: ${this.stderr}`)), 20_000); })]);
    } finally { clearTimeout(timer); }
  }
  onEvent(listener: (event: ChildEvent) => void): () => void { this.events.on("event", listener); return () => this.events.off("event", listener); }
  checkStartup(launch: Launch): void {
    if (this.startupError) throw this.startupError;
    if (launch.providerContract.registered && !this.registeredProviders.includes(launch.provider)) throw new Error(`Required child provider override did not register: ${launch.provider}`);
  }
  onExit(listener: (error: Error) => void): () => void { this.events.on("exit", listener); return () => this.events.off("exit", listener); }
  private fail(error: Error): void {
    this.rejectReady(error);
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
  }
  private read(chunk: string): void {
    this.buffer += chunk;
    let end: number;
    while ((end = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, "");
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      try {
        if (line.length > limit) throw new Error("RPC record exceeds 4 MiB");
        const record = JSON.parse(line) as RpcResponse | ChildEvent;
        if (!record || typeof record.type !== "string") throw new Error("Invalid RPC record");
        if (record.type === "response") {
          const pending = record.id ? this.pending.get(record.id) : undefined;
          if (pending) {
            this.pending.delete(record.id!); clearTimeout(pending.timer);
            if (record.success) pending.resolve(record); else pending.reject(new Error(record.error));
          }
        } else {
          if (record.type === "extension_error") this.startupError ??= new Error(`Child extension failed: ${record.error}`);
          if (record.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(record.method)) this.startupError ??= new Error(`Unexpected child UI ${record.method}: refused`);
          this.events.emit("event", record);
        }
      } catch (error) { this.fail(error as Error); void this.close().catch(() => {}); return; }
    }
    if (this.buffer.length > limit) { this.fail(new Error("RPC record exceeds 4 MiB")); void this.close().catch(() => {}); }
  }
  request<T extends RpcCommand["type"]>(command: Extract<RpcCommand, { type: T }>, timeoutMs = 20_000): Promise<Response<T>> {
    if (this.exited || this.child.stdin!.destroyed) return Promise.reject(new Error("RPC child is closed"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC ${command.type} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: response => {
        if (response.command !== command.type) reject(new Error("Mismatched RPC response"));
        else resolve(response as Response<T>);
      }, reject, timer });
      // The callback waits for the write to flush, including stdin backpressure.
      this.child.stdin!.write(`${JSON.stringify({ ...command, id })}\n`, error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
      });
    });
  }
  close(): Promise<void> {
    if (this.exited) return Promise.resolve();
    return this.closePromise ??= this.closeOwned();
  }
  private async waitExit(ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([this.exitPromise.then(() => true), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }
  private async closeOwned(): Promise<void> {
    try { await this.request({ type: "clear_queue" }, 500); } catch { /* Escalation below owns cleanup. */ }
    try { await this.request({ type: "abort" }, 1000); } catch { /* A wedged provider must not block shutdown. */ }
    this.child.stdin?.end();
    if (await this.waitExit(1000)) return;
    this.child.kill("SIGTERM");
    if (await this.waitExit(1500)) return;
    this.child.kill("SIGKILL");
    if (await this.waitExit(1500)) return;
    this.closePromise = undefined;
    throw new Error(`Cleanup failed: child ${this.pid} has not confirmed exit`);
  }
}
export async function launchChild(launch: Launch, directory: string, sessionId: string, onSpawn?: (child: Child) => void): Promise<Child> {
  if (process.platform !== "linux") throw new Error("Subagent owned cleanup is currently supported on Linux only");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const promptPath = join(directory, "profile.md");
  await writeFile(promptPath, launch.profile.prompt, { mode: 0o600 });
  const token = randomUUID();
  const args = ["--mode", "rpc", "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-approve",
    "--provider", launch.provider, "--model", launch.model, "--thinking", launch.effort,
    "--session-dir", directory, "--session-id", sessionId, "--tools", launch.profile.tools.join(","),
    "--append-system-prompt", promptPath,
    ...launch.extensions.flatMap(path => ["--extension", path]),
    "--extension", fileURLToPath(new URL("./bootstrap.ts", import.meta.url)),
    ...launch.skills.flatMap(path => ["--skill", path])];
  const child = new RpcProcess(join(getPackageDir(), "dist/cli.js"), args, launch.cwd, {
    ...process.env, PI_CODING_AGENT_DIR: launch.agentDir, PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
    PI_SUBAGENT_TOKEN: token, PI_SUBAGENT_TOOLS: JSON.stringify(launch.profile.tools),
    PI_SESSION_ID: undefined, PI_SESSION_FILE: undefined, PI_PROVIDER: undefined, PI_MODEL: undefined, PI_REASONING_LEVEL: undefined,
  }, token);
  onSpawn?.(child);
  try {
    await child.initialize();
    const state = (await child.request({ type: "get_state" })).data;
    if (state.model?.provider !== launch.provider || state.model.id !== launch.model || state.thinkingLevel !== launch.effort || state.sessionId !== sessionId
      || state.model.api !== launch.providerContract.api || state.model.baseUrl !== launch.providerContract.baseUrl) throw new Error("Child provider/model/effort/session differs from resolved launch contract");
    const available = (await child.request({ type: "get_available_models" })).data.models;
    if (!available.some(model => model.provider === launch.provider && model.id === launch.model)) throw new Error(`Child provider unavailable: ${launch.provider}/${launch.model}; configure its extension allowlist/authentication`);
    child.checkStartup(launch);
    return child;
  } catch (error) {
    try { await child.close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Child launch and cleanup failed"); }
    throw error;
  }
}

// RPC has no raw-input flag. A fixed non-command prefix prevents slash dispatch
// without escaping or expanding any of the task/guidance text.
export function literalInput(message: string): string { return `Delegated input (literal task or guidance):\n\n${message}`; }
