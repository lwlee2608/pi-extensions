import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

export function completeOverlay(tui: TUI, handle: OverlayHandle, done: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(tui, "hideOverlay");
  const restore = () => {
    if (descriptor) Object.defineProperty(tui, "hideOverlay", descriptor);
    else Reflect.deleteProperty(tui, "hideOverlay");
  };
  // Pi 1.0.0 closes the newest overlay, not its owner. Redirect only its synchronous close.
  Object.defineProperty(tui, "hideOverlay", {
    configurable: true,
    value: () => { restore(); handle.hide(); },
  });
  try { done(); }
  finally { restore(); }
}
