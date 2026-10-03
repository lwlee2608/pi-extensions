import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

test("installs only in TUI, follows live state, and cleans up timers and subscriptions", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  let thinking = "high";
  extension({
    on: (name: string, handler: any) => handlers.set(name, handler),
    getThinkingLevel: () => thinking,
  } as unknown as ExtensionAPI);
  let footer: { render: (width: number) => string[]; dispose: () => void } | undefined;
  let renders = 0, subscriptions = 0, scans = 0;
  let branch = "main", leaf = "a", cost = 1;
  const statuses = new Map<string, string>();
  let branchChanged = () => {};
  const ctx = {
    mode: "rpc", cwd: "/test", model: { name: "OpenAI: Model A", id: "model-a", provider: "velocirouter", contextWindow: 200000 },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 1000, contextWindow: 200000, percent: 0.5 }),
    sessionManager: {
      getLeafId: () => leaf,
      getBranch: () => {
        scans++;
        return [{ type: "usage", usage: { input: 100, cacheRead: 100, cacheWrite: 0, cost: { total: cost } } }];
      },
    },
    ui: {
      setFooter: (factory: any) => {
        footer?.dispose();
        footer = factory({ requestRender: () => { renders++; } }, { fg: (_color: string, text: string) => text }, {
          getGitBranch: () => branch,
          getExtensionStatuses: () => statuses,
          onBranchChange: (callback: () => void) => {
            subscriptions++;
            branchChanged = callback;
            return () => { subscriptions--; };
          },
        });
      },
    },
  };
  const emit = (name: string) => handlers.get(name)?.({ type: name }, ctx as unknown as ExtensionContext);
  const line = () => footer!.render(300)[0];
  emit("session_start");
  emit("agent_start");
  assert.equal(footer, undefined);
  ctx.mode = "tui";
  emit("session_start");
  assert.equal(subscriptions, 1);
  assert.match(line(), /\(velocirouter\) model-a \[high\].*\$1.00.*0s$/);
  assert.doesNotMatch(line(), /OpenAI/);
  line(); assert.equal(scans, 1);
  leaf = "b"; cost = 2;
  assert.match(line(), /\$2.00/);
  leaf = "a"; cost = 1;
  emit("session_tree");
  assert.match(line(), /\$1.00/);
  ctx.model.name = "Model B"; ctx.model.id = "model-b"; ctx.model.provider = "anthropic"; thinking = "low";
  assert.match(line(), /\(anthropic\) model-b \[low\]/);
  statuses.set("test", "status"); branch = "feature"; branchChanged();
  assert.equal(footer!.render(300)[1], "/test (feature) • status");

  emit("agent_start");
  const beforeTick = renders;
  now = 19000; t.mock.timers.tick(1000);
  assert.ok(renders > beforeTick);
  assert.match(line(), /19s$/);
  emit("agent_start"); // Retries must not reset the run timer.
  assert.match(line(), /19s$/);
  emit("agent_settled");
  const settledRenders = renders;
  now = 50000; t.mock.timers.tick(2000);
  assert.equal(renders, settledRenders);
  assert.match(line(), /19s$/);
  emit("agent_start"); assert.match(line(), /0s$/);
  footer!.dispose(); footer!.dispose();
  const disposedRenders = renders;
  t.mock.timers.tick(2000);
  assert.equal(renders, disposedRenders);
  assert.equal(subscriptions, 0);
  emit("session_start");
  assert.equal(subscriptions, 1);
  assert.match(line(), /0s$/);
  emit("agent_start");
  emit("session_shutdown"); emit("session_shutdown");
  const shutdownRenders = renders;
  t.mock.timers.tick(2000);
  assert.equal(renders, shutdownRenders);
  assert.equal(subscriptions, 0);
});
