import { open } from "node:fs/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Manager, Snapshot } from "./manager.ts";
import { display } from "./panel.ts";

export async function transcriptTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 128 * 1024), buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    const lines: string[] = start ? ["[Older output omitted here; full private transcript at the session path]"] : [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line), message = entry.message;
        if (entry.type !== "message" || !message || message.role === "system") continue;
        const content = typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((block: { type: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => block.type === "text" ? block.text : block.type === "thinking" ? "[thinking]" : block.type === "toolCall" ? `[${block.name}] ${JSON.stringify(block.arguments)}` : "[image]").join("\n") : "";
        lines.push(`${message.role}${message.toolName ? ` (${message.toolName})` : ""}: ${content}`);
      } catch { /* A live session can end in an incomplete record. */ }
    }
    return lines.join("\n").slice(-64 * 1024);
  } finally { await file.close(); }
}
function editorDisplay(line: string): string {
  return line.split(/(\x1b\[[\d;:]*m|\x1b_pi:c\x07)/g)
    .map(part => part === CURSOR_MARKER || /^\x1b\[[\d;:]*m$/.test(part) ? part : display(part)).join("");
}
function fit(text: string, width: number): string {
  const line = truncateToWidth(text, width);
  return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
export class Inspector {
  focused = false;
  private manager: Manager;
  private theme: Pick<Theme, "fg">;
  private requestRender: () => void;
  private height: () => number;
  private done: () => void;
  private unsubscribe: () => void;
  private timer?: NodeJS.Timeout;
  private selected?: string;
  private transcript = "";
  private offset = 0;
  private follow = true;
  private capacity = 10;
  private disposed = false;
  private generation = 0;
  private notice = "";
  private editing?: { input: Input; workerId: string; runId: string; kind: "task" | "steer" | "reply"; questionId?: string };
  private confirming?: string;
  private busy = false;
  constructor(manager: Manager, theme: Pick<Theme, "fg">, render: () => void, height: () => number, done: () => void) {
    this.manager = manager; this.theme = theme; this.requestRender = render; this.height = height; this.done = done;
    this.unsubscribe = manager.onChange(() => this.update());
    this.update();
  }
  private worker(): Snapshot | undefined {
    const workers = this.manager.status();
    const selected = workers.find(w => w.workerId === this.selected) ?? workers[0];
    this.selected = selected?.workerId;
    return selected;
  }
  private update(): void {
    if (this.disposed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.refresh(); }, 100);
  }
  private async refresh(): Promise<void> {
    const worker = this.worker(), generation = ++this.generation;
    try {
      const text = worker?.sessionFile ? await transcriptTail(worker.sessionFile) : "No persisted output yet.";
      if (!this.disposed && generation === this.generation && worker?.workerId === this.selected) this.transcript = text;
    } catch (error) { if (!this.disposed && generation === this.generation) this.transcript = `Cannot read transcript: ${error}`; }
    if (!this.disposed) this.requestRender();
  }
  private async submit(): Promise<void> {
    const edit = this.editing;
    if (!edit || this.busy || !edit.input.getValue().trim()) return;
    const value = edit.input.getValue();
    await this.perform(async () => {
      const current = this.manager.status(edit.workerId)[0];
      if (current.runId !== edit.runId) throw new Error("Worker moved to another run; reopen the control");
      if (edit.kind === "reply") await this.manager.reply(edit.questionId!, value);
      else await this.manager.message(edit.workerId, value, edit.kind);
      this.editing = undefined;
    });
  }
  private async perform(action: () => Promise<unknown>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.notice = "Sending…"; this.requestRender();
    try { await action(); this.notice = "Accepted; inspect the run outcome for completion."; }
    catch (error) { this.notice = error instanceof Error ? error.message : String(error); }
    finally { this.busy = false; if (!this.disposed) this.update(); }
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.editing || this.confirming) { this.editing = undefined; this.confirming = undefined; this.notice = ""; this.requestRender(); }
      else this.done();
      return;
    }
    if (this.busy) return;
    if (this.editing) { this.editing.input.handleInput(data); this.requestRender(); return; }
    if (this.confirming) {
      if (matchesKey(data, "y")) { const id = this.confirming; this.confirming = undefined; void this.perform(() => this.manager.stop(id)); }
      else if (matchesKey(data, "n")) { this.confirming = undefined; this.requestRender(); }
      return;
    }
    const workers = this.manager.status(), worker = this.worker();
    if (!worker) return;
    const direction = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
    if (direction) {
      const index = workers.findIndex(w => w.workerId === worker.workerId);
      this.selected = workers[Math.max(0, Math.min(workers.length - 1, index + direction))].workerId;
      this.follow = true; this.offset = 0; this.transcript = "Loading…"; this.generation++; this.update();
    } else if (matchesKey(data, "pageUp")) { this.follow = false; this.offset = Math.max(0, this.offset - this.capacity); }
    else if (matchesKey(data, "pageDown")) this.offset += this.capacity;
    else if (matchesKey(data, "end")) this.follow = true;
    else if (matchesKey(data, "s")) { this.confirming = worker.workerId; }
    else if (matchesKey(data, "c") && worker.recoverable) void this.perform(() => this.manager.recover(worker.workerId));
    else if (matchesKey(data, "m") || matchesKey(data, "r")) {
      const question = worker.questions?.find(q => q.state === "pending");
      const reply = matchesKey(data, "r");
      if (reply && !question) this.notice = "No pending question";
      else if (!reply && !["idle", "working"].includes(worker.state)) this.notice = "Message requires an idle or working worker";
      else {
        const kind = reply ? "reply" : worker.state === "working" ? "steer" : "task";
        const input = new Input({ prompt: `${kind}: ` });
        input.onSubmit = () => { void this.submit(); };
        this.editing = { input, kind, workerId: worker.workerId, runId: worker.runId, questionId: question?.questionId };
        this.notice = "Enter send · Esc cancel";
      }
    }
    this.requestRender();
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(1, this.height());
    const worker = this.worker(), workers = this.manager.status();
    if (height < 10) return [fit("Subagents · enlarge terminal · Esc close", width)];
    const head = ["Subagents · ↑↓ worker · PgUp/PgDn transcript · End live · Esc close"];
    if (!worker) return [...head, "No workers in this parent session."].map(line => fit(display(line), width));
    const index = workers.findIndex(w => w.workerId === worker.workerId);
    const pending = worker.questions?.find(q => q.state === "pending");
    head.push(`${index + 1}/${workers.length} · ${worker.label} · ${worker.state} · ${worker.activity}`,
      `${worker.model}:${worker.effort} · PID ${worker.pid ?? "not spawned"}`, worker.cwd,
      `Session: ${worker.sessionFile ?? "not yet persisted"}`,
      pending ? `Question ${pending.questionId}: ${pending.question}` : `${worker.workerId} · ${worker.runId}`);
    const text = `${this.transcript}\n\nLive: ${worker.output}${worker.toolOutput ? `\nTool output: ${worker.toolOutput}` : ""}`;
    const lines = text.split("\n").flatMap(line => wrapTextWithAnsi(display(line), Math.max(1, width)));
    this.capacity = Math.max(1, height - head.length - 3);
    const last = Math.max(0, lines.length - this.capacity);
    this.offset = this.follow ? last : Math.max(0, Math.min(this.offset, last));
    const body = lines.slice(this.offset, this.offset + this.capacity);
    while (body.length < this.capacity) body.push("");
    if (this.editing) this.editing.input.focused = this.focused;
    const control = this.editing ? editorDisplay(this.editing.input.render(width)[0]) : this.confirming ? "Stop this worker? y confirm · n/Esc cancel (edits are preserved)" : "m task/steer · r reply · s stop · c recover";
    return [...head.map(line => this.theme.fg("accent", display(line))), ...body, this.theme.fg("muted", "─".repeat(width)), control, this.theme.fg("muted", display(this.notice))].map(line => fit(line, width));
  }
  invalidate(): void {}
  dispose(): void { this.disposed = true; this.generation++; clearTimeout(this.timer); this.unsubscribe(); }
}
