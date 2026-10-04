import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

export function completeOverlay(tui: TUI, handle: OverlayHandle, done: () => void): void {
  const original = tui.hideOverlay;
  // Pi's stable TUI proxy forwards assignment, but not defineProperty, to its renderer.
  tui.hideOverlay = () => { tui.hideOverlay = original; handle.hide(); };
  try { done(); }
  finally { tui.hideOverlay = original; }
}
