export type Status = "needs-input" | "failed" | "working" | "idle";
export type Outcome = "completed" | "aborted" | "error";
export interface Activity {
  status: Status;
  statusSince: number;
  tools?: string[];
  activity?: "ready" | "generating" | "compacting" | "aborted";
  waitingUnavailable?: boolean;
}

export function transition(state: Activity, status: Status, now: number): Activity {
  return state.status === status ? state : { ...state, status, statusSince: now };
}

export function safeText(text: string, limit = 512): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, limit);
}

export class SessionState {
  private running = false;
  private compacting = false;
  private prompt: "none" | "dialog" | "board" = "none";
  private tools = new Map<string, string>();
  private outcome: Outcome = "completed";
  private state: Activity;
  private clock: () => number;

  constructor(clock = Date.now) {
    this.clock = clock;
    this.state = { status: "idle", statusSince: clock() };
  }
  start(): void { this.running = true; this.outcome = "completed"; this.tools.clear(); }
  beforeSettle(outcome: Outcome): void { this.outcome = outcome; }
  settle(): void { this.running = false; this.tools.clear(); }
  toolStart(id: string, name: string): void { this.tools.set(id, safeText(name, 128)); }
  toolEnd(id: string): void { this.tools.delete(id); }
  promptStart(board: boolean): void { this.prompt = board ? "board" : "dialog"; }
  promptEnd(): void { this.prompt = "none"; }
  compactStart(): void { this.compacting = true; }
  compactEnd(outcome: Outcome): void {
    this.compacting = false;
    if (!this.running) this.outcome = outcome;
  }
  snapshot(): Activity {
    const busy = this.running || this.compacting;
    const status: Status = busy ? (this.prompt === "dialog" ? "needs-input" : "working")
      : this.outcome === "error" ? "failed" : "idle";
    this.state = transition(this.state, status, this.clock());
    return {
      ...this.state,
      tools: [...new Set(this.tools.values())].slice(0, 8),
      activity: this.compacting ? "compacting" : busy ? "generating" : this.outcome === "aborted" ? "aborted" : "ready",
      waitingUnavailable: this.prompt === "board",
    };
  }
}
