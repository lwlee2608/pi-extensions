export type Armed = "once" | "on" | "off";
export type Outcome = "completed" | "error";

export class NotifyState {
  armed: Armed = "off";
  condition: string | undefined;
  private outcome: Outcome | undefined;

  reset(): void { this.disarm(); this.outcome = undefined; }
  disarm(): void { this.armed = "off"; this.condition = undefined; }
  fired(): void { if (this.armed === "once") this.disarm(); }
  start(): void { this.outcome = undefined; }
  beforeSettle(outcome: string): void {
    this.outcome = outcome === "completed" || outcome === "error" ? outcome : undefined;
  }
  settle(): Outcome | undefined {
    const outcome = this.outcome;
    this.outcome = undefined;
    if (this.armed === "off" || !outcome) return undefined;
    this.fired();
    return outcome;
  }
}
