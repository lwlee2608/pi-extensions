export type Armed = "once" | "on" | "off";
export type Outcome = "completed" | "error";

export class NotifyState {
  armed: Armed = "off";
  private outcome: Outcome | undefined;

  reset(): void { this.armed = "off"; this.outcome = undefined; }
  start(): void { this.outcome = undefined; }
  beforeSettle(outcome: string): void {
    this.outcome = outcome === "completed" || outcome === "error" ? outcome : undefined;
  }
  settle(): Outcome | undefined {
    const outcome = this.outcome;
    this.outcome = undefined;
    if (this.armed === "off" || !outcome) return undefined;
    if (this.armed === "once") this.armed = "off";
    return outcome;
  }
}
