import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";

function rendererOf(reference: TUI): TUI {
  const probe = Symbol("ask-user renderer");
  // Pi's stable proxy binds method calls to its renderer; descriptor operations do not forward.
  const target = reference as TUI & Record<symbol, () => TUI>;
  target[probe] = function (this: TUI) { return this; };
  let renderer: TUI | undefined;
  try { return renderer = target[probe](); }
  finally {
    if (renderer) Reflect.deleteProperty(renderer, probe);
    Reflect.deleteProperty(reference, probe);
  }
}

export function completeOverlay(reference: TUI, handle: OverlayHandle, done: () => void): void {
  const tui = rendererOf(reference);
  const descriptor = Object.getOwnPropertyDescriptor(tui, "hideOverlay");
  const restore = () => {
    if (descriptor) Object.defineProperty(tui, "hideOverlay", descriptor);
    else Reflect.deleteProperty(tui, "hideOverlay");
  };
  // Pi 1.0.0 closes the newest overlay, not its owner. Redirect only its synchronous close.
  Object.defineProperty(tui, "hideOverlay", { configurable: true, value: () => { restore(); handle.hide(); } });
  try { done(); }
  finally { restore(); }
}
