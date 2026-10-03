import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { safeText, type Activity } from "./state.ts";

export const HEARTBEAT_MS = 5_000;
export const UNKNOWN_MS = 20_000;
export const HIDE_MS = 300_000;
const MAX_BYTES = 32_768;

export interface Metadata extends Activity {
  sessionId: string;
  name: string;
  cwd: string;
}
export interface Presence extends Metadata {
  version: 1;
  registrationId: string;
  startedAt: number;
  heartbeatAt: number;
}
export interface Row extends Omit<Presence, "status"> {
  status: Presence["status"] | "unknown";
}

export function visibleRecord(record: Presence, now: number): Row | undefined {
  const age = now - record.heartbeatAt;
  if (age >= HIDE_MS) return undefined;
  return { ...record, status: age >= UNKNOWN_MS ? "unknown" : record.status };
}

function valid(value: unknown): value is Presence {
  if (!value || typeof value !== "object") return false;
  const r = value as Presence;
  return r.version === 1 && typeof r.registrationId === "string" && /^[a-f0-9-]{36}$/.test(r.registrationId)
    && [r.sessionId, r.name, r.cwd].every(v => typeof v === "string" && v.length <= 4096)
    && [r.startedAt, r.heartbeatAt, r.statusSince].every(v => Number.isSafeInteger(v) && v >= 0)
    && ["idle", "working", "needs-input", "failed"].includes(r.status)
    && (r.tools === undefined || (Array.isArray(r.tools) && r.tools.length <= 8 && r.tools.every(v => typeof v === "string" && v.length <= 128)))
    && (r.activity === undefined || ["ready", "generating", "compacting", "aborted"].includes(r.activity))
    && (r.waitingUnavailable === undefined || typeof r.waitingUnavailable === "boolean");
}

export async function readRows(root: string, now = Date.now()): Promise<Row[]> {
  let names: string[];
  try { names = await readdir(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const rows: Row[] = [];
  for (const name of names) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    try {
      const file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_BYTES) continue;
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_BYTES) continue;
        const record: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString());
        if (!valid(record) || name !== `${record.registrationId}.json`) continue;
        const row = visibleRecord(record, now);
        if (row) rows.push(row);
      } finally { await file.close(); }
    } catch (error) {
      if (error instanceof SyntaxError || ["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
  }
  return rows.sort((a, b) => a.startedAt - b.startedAt || a.registrationId.localeCompare(b.registrationId));
}

export class Registration {
  readonly id = randomUUID();
  private startedAt: number;
  private closed = false;
  private pending = Promise.resolve();
  private next: Presence | undefined;
  private writing = false;
  private path: string;

  private root: string;
  private clock: () => number;

  constructor(root: string, clock = Date.now) {
    this.root = root;
    this.clock = clock;
    this.startedAt = clock();
    this.path = join(root, `${this.id}.json`);
  }

  publish(metadata: Metadata): Promise<void> {
    if (this.closed) return Promise.resolve();
    const record: Presence = {
      version: 1, registrationId: this.id, startedAt: this.startedAt,
      heartbeatAt: this.clock(), sessionId: safeText(metadata.sessionId),
      name: safeText(metadata.name), cwd: safeText(metadata.cwd, 4096),
      status: metadata.status, statusSince: metadata.statusSince,
      tools: metadata.tools?.slice(0, 8).map(name => safeText(name, 128)),
      activity: metadata.activity, waitingUnavailable: metadata.waitingUnavailable,
    };
    this.next = record;
    if (this.writing) return this.pending;
    this.writing = true;
    this.pending = (async () => {
      try {
        while (this.next && !this.closed) {
          const latest = this.next;
          this.next = undefined;
          await mkdir(this.root, { recursive: true, mode: 0o700 });
          if (!(await lstat(this.root)).isDirectory()) throw new Error("Invalid registry directory");
          await chmod(this.root, 0o700);
          const temp = `${this.path}.${randomUUID()}.tmp`;
          try {
            const file = await open(temp, "wx", 0o600);
            try { await file.writeFile(JSON.stringify(latest)); }
            finally { await file.close(); }
            await rename(temp, this.path);
          } finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
        }
      } finally { this.writing = false; }
    })();
    return this.pending;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.next = undefined;
    await this.pending.catch(() => {});
    await unlink(this.path).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}
