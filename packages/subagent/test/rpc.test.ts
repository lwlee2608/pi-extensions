import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchChild, literalInput, type Child, type ChildEvent } from "../src/rpc.ts";
import { Manager } from "../src/manager.ts";
import { fixture } from "./helpers.ts";

test("real RPC validates provider, tool loadout and confirmed process exit", { timeout: 40_000 }, async () => {
  const f = await fixture();
  let child: Child | undefined;
  try {
    child = await launchChild(f.launch, join(f.root, "child"), randomUUID());
    const events: ChildEvent[] = [];
    let settled!: () => void;
    const completion = new Promise<void>(resolve => { settled = resolve; });
    child.onEvent(event => { events.push(event); if (event.type === "agent_settled") settled(); });
    const response = await child.request({ type: "prompt", message: literalInput("hello\u2028world") });
    assert.equal(response.data.disposition, "started");
    await completion;
    assert.ok(events.some(event => event.type === "message_update"));
    assert.ok(events.some(event => event.type === "agent_end"));
    await child.close(); assert.equal(child.exited, true);
    assert.throws(() => process.kill(child!.pid!, 0), /ESRCH/);
    await assert.rejects(launchChild({ ...f.launch, profile: { ...f.launch.profile, tools: ["nonexistent_tool"] } }, join(f.root, "bad-tool"), randomUUID()), /tool setup failed/);
    await assert.rejects(launchChild({ ...f.launch, model: "missing" }, join(f.root, "bad-model"), randomUUID()), /exited|differs|provider unavailable/);
  } finally { await child?.close(); await f.cleanup(); }
});

test("early settlement before prompt response does not get lost", { timeout: 5000 }, async () => {
  const f = await fixture();
  let listener: (event: ChildEvent) => void = () => {};
  let exited = false;
  const fake = {
    get exited() { return exited; }, pid: undefined,
    onEvent(fn: typeof listener) { listener = fn; return () => {}; }, onExit() { return () => {}; },
    async request(command: { type: string }) {
      if (command.type === "get_state") return { data: { sessionId: "fake" } };
      listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "fast" }], provider: "offline", model: "fixture", api: "offline", timestamp: 0, stopReason: "stop", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
      listener({ type: "agent_settled" });
      return { data: { disposition: "started" } };
    },
    async close() { exited = true; },
  } as unknown as Child;
  const manager = new Manager({ root: f.root, parentId: "early", spawn: async () => fake });
  try {
    const run = manager.start(f.launch, "fast", "retained");
    const result = await manager.wait([run.runId]);
    assert.equal(result.runs[0].result?.outcome, "completed");
  } finally { await manager.shutdown(); await f.cleanup(); }
});
