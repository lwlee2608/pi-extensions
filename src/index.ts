import { join } from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createCommand } from "./commands.ts";
import { FavoritesStore } from "./store.ts";

export default function modelPlus(pi: ExtensionAPI): void {
  const store = new FavoritesStore(join(getAgentDir(), "pi-model-plus", "favorites.json"));
  pi.registerCommand("model-plus", createCommand(store, (model) => pi.setModel(model)));
}
