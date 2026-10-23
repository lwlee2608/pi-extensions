import { open } from "node:fs/promises";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Manager, Snapshot } from "./manager.ts";
import { active, byState, display, duration, elapsed, icon, named, names, reminded, tree } from "./panel.ts";

const prefix = "Delegated input (literal task or guidance):\n\n";
function first(text: string): string { return text.trim().split("\n")[0] ?? ""; }
function brief(args: unknown): string {
  const values = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const main = ["command", "path", "pattern", "question", "url", "query"].map(key => values[key]).find(v => typeof v === "string") ?? Object.values(values).find(v => typeof v === "string");
  return typeof main === "string" ? first(main) : "";
}
export async function transcriptTail(path: string): Promise<string> {
  const file = await open(path, "r");
  try {
    const { size } = await file.stat();
    const start = Math.max(0, size - 128 * 1024), buffer = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start) text = text.slice(text.indexOf("\n") + 1);
    const lines: string[] = start ? ["[Older output omitted here; full private transcript at the session path]"] : [];
    for (const record of text.split("\n")) {
      if (!record) continue;
      try {
        const entry = JSON.parse(record), message = entry.message;
        if (entry.type !== "message" || !message || message.role === "system") continue;
        const blocks: { type: string; text?: string; name?: string; arguments?: unknown }[] = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
        const body = blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n");
        if (message.role === "user") lines.push("Task", ...body.replace(prefix, "").split("\n").map(l => `  ${l}`));
        else if (message.role === "toolResult") lines.push(`  ${message.isError ? "✗" : "✓"} ${first(body)}`.trimEnd());
        else for (const block of blocks) {
          if (block.type === "text") lines.push(block.text ?? "");
          else if (block.type === "toolCall") lines.push(`● ${block.name} ${brief(block.arguments)}`.trimEnd());
          else if (block.type === "image") lines.push("[image]");
        }
        if (message.errorMessage) lines.push(`Error: ${message.errorMessage}`);
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
  private info = false;
  private listOffset = 0;
  constructor(manager: Manager, theme: Pick<Theme, "fg">, render: () => void, height: () => number, done: () => void) {
    this.manager = manager; this.theme = theme; this.requestRender = render; this.height = height; this.done = done;
    this.unsubscribe = manager.onChange(() => this.update());
    this.update();
  }
  private workers(): Snapshot[] { return tree(this.manager.status(), this.manager.history()).flatMap(node => node.members); }
  private worker(): Snapshot | undefined {
    const workers = this.workers();
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
    if (this.editing) {
      const input = this.editing.input;
      input.handleInput(data);
      const value = input.getValue(), safe = display(value);
      if (safe !== value) input.setValue(safe);
      this.requestRender(); return;
    }
    if (this.confirming) {
      if (matchesKey(data, "y")) { const id = this.confirming; this.confirming = undefined; void this.perform(() => this.manager.stop(id)); }
      else if (matchesKey(data, "n")) { this.confirming = undefined; this.requestRender(); }
      return;
    }
    const workers = this.workers(), worker = this.worker();
    if (!worker) return;
    const direction = matchesKey(data, "up") ? -1 : matchesKey(data, "down") ? 1 : 0;
    if (direction) {
      const index = workers.findIndex(w => w.workerId === worker.workerId);
      this.select(workers[Math.max(0, Math.min(workers.length - 1, index + direction))].workerId);
    } else if (matchesKey(data, "i")) this.info = !this.info;
    else if (matchesKey(data, "pageUp")) { this.follow = false; this.offset = Math.max(0, this.offset - this.capacity); }
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
  private select(workerId: string): void {
    if (workerId === this.selected) return;
    this.selected = workerId;
    this.follow = true; this.offset = 0; this.transcript = "Loading…"; this.generation++; this.update();
  }
  private list(width: number, rows: number, now: number): string[] {
    const agents = new Map(this.manager.history().map(s => [s.runId, s.agent])), lines: string[] = [];
    let chosen = 0;
    const row = (worker: Snapshot, name: string, indent: string) => {
      const selected = worker.workerId === this.selected, [color, symbol] = icon(worker, now), time = duration(elapsed(worker, now));
      const label = truncateToWidth(display(name), Math.max(0, width - indent.length - visibleWidth(time) - 5), "…", true);
      if (selected) chosen = lines.length;
      lines.push(`${selected ? this.theme.fg("accent", "▸") : " "} ${indent}${this.theme.fg(color, symbol)} ${selected ? this.theme.fg("accent", label) : label} ${this.theme.fg("dim", time)}`);
    };
    const nodes = tree(this.manager.status(), this.manager.history()), labels = names(nodes);
    for (const node of nodes) {
      if (node.members.length === 1) { row(node.members[0], named(node, node.members[0], labels), ""); continue; }
      const [color, symbol] = icon([...node.members].sort(byState)[0], now), title = labels.get(node.root.workerId)!;
      lines.push(`  ${this.theme.fg(color, symbol)} ${title}`);
      for (const member of node.members) { const name = named(node, member, labels); row(member, name === title ? agents.get(member.runId) ?? name : name, "  "); }
    }
    if (chosen < this.listOffset) this.listOffset = chosen;
    else if (chosen >= this.listOffset + rows) this.listOffset = chosen - rows + 1;
    this.listOffset = Math.max(0, Math.min(this.listOffset, lines.length - rows));
    const body = lines.slice(this.listOffset, this.listOffset + rows);
    while (body.length < rows) body.push("");
    return body.map(l => fit(l, width));
  }
  private pane(worker: Snapshot, width: number, rows: number, now: number): string[] {
    const nodes = tree(this.manager.status(), this.manager.history()), node = nodes.find(n => n.members.includes(worker));
    const name = node ? named(node, worker, names(nodes)) : display(worker.label), agent = display(this.manager.history().find(s => s.runId === worker.runId)?.agent ?? "");
    const spent = (worker.result?.usage ?? worker.usage)?.cost.total ?? 0;
    const head = [this.theme.fg("accent", display([name, ...(name.startsWith(agent) ? [] : [agent]), worker.state, duration(elapsed(worker, now)), ...(spent ? [`$${spent.toFixed(2)}`] : [])].join(" · ")))];
    const question = worker.questions?.find(q => q.state === "pending"), error = worker.error ?? worker.result?.error, running = active.includes(worker.state);
    if (question) head.push(this.theme.fg("warning", display(`? asks: ${question.question} · r reply`)));
    if (error) head.push(this.theme.fg("error", display(`Error: ${error}`)));
    if (reminded(worker) && !running) head.push(this.theme.fg("warning", "Saved conversation · c recover"));
    if (this.info) head.push(...[`${worker.model}:${worker.effort} · PID ${worker.pid ?? "not spawned"}`, worker.cwd, `Session: ${worker.sessionFile ?? "not yet persisted"}`,
      `${worker.workerId} · ${worker.runId}`].flatMap(l => wrapTextWithAnsi(display(l), Math.max(1, width))).map(l => this.theme.fg("dim", l)));
    head.push(this.theme.fg("dim", "─".repeat(width)));
    const text = [this.transcript];
    if (running && worker.output.trim() && !this.transcript.trimEnd().endsWith(worker.output.trim())) text.push(worker.output);
    if (running && worker.activity.startsWith("tool:") && worker.toolOutput?.trim()) text.push(`  │ ${worker.toolOutput.trim().split("\n").at(-1)}`);
    const lines = text.join("\n").split("\n").flatMap(l => wrapTextWithAnsi(display(l), Math.max(1, width)));
    if (running) { const [color, symbol] = icon(worker, now); lines.push(`${this.theme.fg(color, symbol)} ${this.theme.fg("dim", display(worker.activity))}`); }
    this.capacity = Math.max(1, rows - head.length);
    const last = Math.max(0, lines.length - this.capacity);
    this.offset = this.follow ? last : Math.max(0, Math.min(this.offset, last));
    const body = lines.slice(this.offset, this.offset + this.capacity);
    while (body.length < this.capacity) body.push("");
    return [...head, ...body].slice(0, rows).map(l => fit(l, width));
  }
  render(width: number): string[] {
    if (width < 1) return [];
    const height = Math.max(1, this.height());
    if (height < 10) return [fit("Subagents · enlarge terminal · Esc close", width)];
    const now = Date.now(), worker = this.worker();
    const keys = this.editing ? this.notice : "↑↓ select · PgUp/PgDn scroll · i info · m task · r reply · s stop · c recover · Esc";
    const title = `${this.theme.fg("accent", "Subagents")}${" ".repeat(Math.max(2, width - 9 - visibleWidth(keys)))}${this.theme.fg("dim", display(keys))}`;
    if (!worker) return [title, "No workers in this parent session."].map(line => fit(line, width));
    const rows = height - 3, side = width >= 60 ? Math.min(32, Math.floor(width * 0.3)) : 0;
    const pane = this.pane(worker, side ? width - side - 3 : width, rows, now);
    const body = side ? this.list(side, rows, now).map((line, i) => `${line}${this.theme.fg("dim", " │ ")}${pane[i]}`) : pane;
    if (this.editing) this.editing.input.focused = this.focused;
    const control = this.editing ? editorDisplay(this.editing.input.render(width)[0]) : this.confirming ? "Stop this worker? y confirm · n/Esc cancel (edits are preserved)" : this.theme.fg("muted", display(this.notice));
    return [title, ...body, this.theme.fg("dim", "─".repeat(width)), control].map(line => fit(line, width));
  }
  invalidate(): void {}
  dispose(): void { this.disposed = true; this.generation++; clearTimeout(this.timer); this.unsubscribe(); }
}
