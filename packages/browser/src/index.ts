import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Bridge, ORIGIN, PORT, type BridgeOptions } from "./bridge.ts";

export function browserExtension(overrides: Partial<BridgeOptions> = {}): (pi: ExtensionAPI) => void {
  return pi => {
    const bridge = new Bridge({ port: PORT, origin: ORIGIN, ...overrides });

    function use(ctx: ExtensionContext): Bridge {
      if (!ctx.hasUI) throw new Error("The browser needs an interactive pi session.");
      return bridge;
    }

    pi.on("session_shutdown", () => bridge.close());
  };
}

export default browserExtension();
