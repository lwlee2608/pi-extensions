import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { Launch } from "./profiles.ts";
import type { Run, Snapshot } from "./manager.ts";
import { isBuiltinExtension } from "./extensions.ts";

export interface Prerequisites { files: Record<string, string>; cwd: { dev: number; ino: number } }
export interface SavedWorker {
  version: 1; parentId: string; view: Snapshot; launch: Launch; runs: Run[]; generation: string;
  prerequisites: Prerequisites; reported: string[]; ownership: "closed" | "owned";
}
const workerId = /^w-[a-f0-9-]{36}$/;
const runId = /^r-[a-f0-9-]{36}$/;
function digest(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
export function prerequisites(launch: Launch): Prerequisites {
  const files: Record<string, string> = {};
  for (const path of [launch.profile.path, ...launch.extensions.filter(path => !isBuiltinExtension(path))]) {
    if (!isAbsolute(path) || !statSync(path).isFile()) throw new Error(`Missing recovery prerequisite: ${path}`);
    files[path] = digest(path);
  }
  const cwd = statSync(launch.cwd);
  if (!cwd.isDirectory()) throw new Error(`Missing worker cwd: ${launch.cwd}`);
  return { files, cwd: { dev: cwd.dev, ino: cwd.ino } };
}
export function verifyPrerequisites(saved: SavedWorker, approvedExtensions: string[], trustedProjectRoots: string[]): void {
  if (saved.launch.profile.trustedProjectRoot && !trustedProjectRoots.includes(saved.launch.profile.trustedProjectRoot)) throw new Error("Recovery project-profile trust was revoked");
  const current = prerequisites(saved.launch);
  if (JSON.stringify(current) !== JSON.stringify(saved.prerequisites)) throw new Error("Recovery prerequisites changed (cwd/profile/extension); restore the saved resources, do not substitute");
  const missingSkill = saved.launch.skills.find(path => !existsSync(path));
  if (missingSkill) throw new Error(`Recovery skill is missing: ${missingSkill}`);
  if (saved.launch.extensions.some(path => !approvedExtensions.includes(path))) throw new Error("Recovery provider/tool extension is no longer approved");
  if (!saved.view.sessionFile || !statSync(saved.view.sessionFile).isFile()) throw new Error("Recovery session file is missing");
  const fd = openSync(saved.view.sessionFile, "r");
  let header: string;
  try {
    const prefix = Buffer.alloc(16_384);
    const bytes = readSync(fd, prefix, 0, prefix.length, 0);
    const newline = prefix.subarray(0, bytes).indexOf(10);
    if (newline < 0) throw new Error("Missing or oversized recovery session header");
    header = prefix.subarray(0, newline).toString("utf8");
  } finally { closeSync(fd); }
  const first = JSON.parse(header);
  if (first.type !== "session" || first.id !== saved.view.sessionId || first.cwd !== saved.view.cwd) throw new Error("Recovery session identity changed");
}
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === "object" && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === "string"); }
function validResult(value: unknown): boolean {
  if (!object(value) || !["completed", "failed", "interrupted"].includes(value.outcome) || typeof value.text !== "string" || !Number.isFinite(value.endedAt)) return false;
  const usage = value.usage;
  return object(usage) && object(usage.cost) && ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every(k => Number.isFinite(usage[k]) && usage[k] >= 0)
    && ["input", "output", "cacheRead", "cacheWrite", "total"].every(k => Number.isFinite(usage.cost[k]) && usage.cost[k] >= 0);
}
function validate(value: unknown, parentId: string, id: string, directory: string): asserts value is SavedWorker {
  const fail = () => { throw new Error(`Corrupt or foreign subagent metadata: ${id}`); };
  if (!object(value) || value.version !== 1 || value.parentId !== parentId || !object(value.view) || !object(value.launch)) return fail();
  const { view, launch } = value;
  if (view.workerId !== id || !runId.test(view.runId) || typeof view.sessionId !== "string" || !/^[a-zA-Z0-9-]+$/.test(view.sessionId)
    || !["once", "retained"].includes(view.lifetime) || !["queued", "working", "blocked", "idle", "closed"].includes(view.state)
    || !["owned", "closed"].includes(value.ownership) || typeof value.generation !== "string"
    || ![view.label, view.cwd, view.model, view.effort, view.activity, view.output].every(v => typeof v === "string") || !Number.isFinite(view.startedAt)) return fail();
  if (view.sessionFile !== undefined && (typeof view.sessionFile !== "string" || dirname(resolve(view.sessionFile)) !== resolve(directory))) return fail();
  if (!object(launch.profile) || ![launch.cwd, launch.agentDir, launch.provider, launch.model, launch.profile.name, launch.profile.path, launch.profile.prompt].every(v => typeof v === "string")
    || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(launch.effort) || !strings(launch.extensions) || !strings(launch.skills) || !strings(launch.profile.tools)
    || !object(launch.providerContract) || typeof launch.providerContract.api !== "string" || typeof launch.providerContract.baseUrl !== "string" || typeof launch.providerContract.registered !== "boolean"
    || (launch.profile.trustedProjectRoot !== undefined && (typeof launch.profile.trustedProjectRoot !== "string" || !isAbsolute(launch.profile.trustedProjectRoot)))
    || launch.cwd !== view.cwd || `${launch.provider}/${launch.model}` !== view.model || launch.effort !== view.effort) return fail();
  if (!Array.isArray(value.runs) || !value.runs.length || value.runs.length > 2048 || value.runs.some(r => !object(r) || r.workerId !== id || !runId.test(r.runId) || typeof r.label !== "string" || !Number.isFinite(r.startedAt) || (r.result !== undefined && !validResult(r.result)))
    || !value.runs.some(r => r.runId === view.runId) || new Set(value.runs.map(r => r.runId)).size !== value.runs.length || !strings(value.reported)) return fail();
  if (!object(value.prerequisites) || !object(value.prerequisites.files) || !object(value.prerequisites.cwd)
    || !Object.entries(value.prerequisites.files).every(([path, hash]) => isAbsolute(path) && typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))
    || !Number.isFinite(value.prerequisites.cwd.dev) || !Number.isFinite(value.prerequisites.cwd.ino)) return fail();
  if (!Array.isArray(view.questions) || view.questions.length > 128 || view.questions.some(q => !object(q) || q.workerId !== id || !runId.test(q.runId)
    || typeof q.questionId !== "string" || !/^q-[a-f0-9-]{36}$/.test(q.questionId) || ![q.requestId, q.generation, q.question].every(v => typeof v === "string") || !["pending", "answered", "cancelled"].includes(q.state))) return fail();
}

export class Store {
  readonly directory: string;
  readonly parentId: string;
  private lockPath: string;
  private token = randomUUID();
  private closed = false;
  constructor(root: string, parentId: string) {
    this.parentId = parentId;
    this.directory = join(root, parentId);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error("Refusing symlinked parent storage");
    this.lockPath = join(this.directory, "owner.json");
    try {
      const fd = openSync(this.lockPath, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify({ token: this.token, pid: process.pid })); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) { throw new Error(`Parent storage is owned or ownership is uncertain: ${this.lockPath}. Confirm old parent/children exited before resolving its lock. ${error}`); }
  }
  readAll(): SavedWorker[] {
    const records: SavedWorker[] = [];
    for (const id of readdirSync(this.directory)) {
      if (!workerId.test(id)) continue;
      const directory = join(this.directory, id), path = join(directory, "worker.json");
      if (lstatSync(directory).isSymbolicLink()) throw new Error(`Symlinked worker storage: ${id}`);
      if (!existsSync(path)) throw new Error(`Incomplete worker metadata: ${id}`);
      if (lstatSync(path).isSymbolicLink() || statSync(path).size > 20 * 1024 * 1024) throw new Error(`Invalid worker metadata file: ${id}`);
      const value: unknown = JSON.parse(readFileSync(path, "utf8"));
      validate(value, this.parentId, id, directory);
      records.push(value);
      if (records.length > 2048) throw new Error("Stored worker history exceeds limit");
    }
    return records;
  }
  save(record: SavedWorker): void {
    if (this.closed || JSON.parse(readFileSync(this.lockPath, "utf8")).token !== this.token) throw new Error("Lost parent storage ownership");
    const directory = join(this.directory, record.view.workerId);
    validate(record, this.parentId, record.view.workerId, directory);
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 20 * 1024 * 1024) throw new Error("Worker metadata exceeds storage bound");
    const initial = !existsSync(directory);
    const target = initial ? join(this.directory, `.admit-${randomUUID()}`) : directory;
    const path = join(target, "worker.json"), temp = `${path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      mkdirSync(target, { recursive: true, mode: 0o700 });
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      const dir = openSync(target, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
      if (initial) renameSync(target, directory);
      committed = true;
      const parent = openSync(this.directory, "r"); try { fsyncSync(parent); } finally { closeSync(parent); }
    } catch (error) {
      // Initial admission cannot have spawned a child yet, so its installed
      // directory is safe to roll back even if the parent fsync failed.
      if (initial) rmSync(committed ? directory : target, { recursive: true, force: true });
      else rmSync(temp, { force: true });
      throw error;
    }
  }
  readReported(): string[] {
    const path = join(this.directory, "reported.json");
    if (!existsSync(path)) return [];
    if (statSync(path).size > 200_000) throw new Error("Usage checkpoint exceeds bound");
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!strings(value) || value.length > 2048 || value.some(id => !runId.test(id))) throw new Error("Corrupt usage checkpoint");
    return value;
  }
  checkpointUsage(ids: string[]): string | undefined {
    if (this.closed || JSON.parse(readFileSync(this.lockPath, "utf8")).token !== this.token) throw new Error("Lost usage checkpoint ownership");
    const path = join(this.directory, "reported.json"), temp = `${path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, JSON.stringify(ids)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temp, path);
      committed = true;
      const dir = openSync(this.directory, "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) {
      rmSync(temp, { force: true });
      if (committed) return `Usage checkpoint installed but directory sync failed: ${error}`;
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    if (JSON.parse(readFileSync(this.lockPath, "utf8")).token !== this.token) throw new Error("Lost parent storage ownership; lock retained");
    rmSync(this.lockPath);
    this.closed = true;
  }
}
