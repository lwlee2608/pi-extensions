import { matchesKey, type KeyId, type KeybindingsManager } from "@earendil-works/pi-tui";

export const defaults = {
  "pi-ask-user.note": ["n"],
  "pi-ask-user.previewUp": ["pageUp"],
  "pi-ask-user.previewDown": ["pageDown"],
} satisfies Record<string, KeyId[]>;
export type Action = keyof typeof defaults;

export function actionKeys(manager: KeybindingsManager, action: Action): KeyId[] {
  const configured = manager.getUserBindings()[action];
  return configured === undefined ? defaults[action] : Array.isArray(configured) ? configured : [configured];
}
export function actionMatches(manager: KeybindingsManager, action: Action, data: string): boolean {
  return actionKeys(manager, action).some(key => matchesKey(data, key));
}
