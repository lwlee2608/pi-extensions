import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { RpcProcess, launchChild, literalInput, type Child, type ChildEvent } from "../src/rpc.ts";
import { Manager } from "../src/manager.ts";
import { fixture } from "./helpers.ts";

test("real RPC validates provider, tool loadout and confirmed process exit", { timeout: 40_000 }, async () => {
  const f = await fixture();
  let child: Child | undefined;
  try {
    const oldKey = process.env.PI_SUBAGENT_FIXTURE_KEY;
    process.env.PI_SUBAGENT_FIXTURE_KEY = "offline-not-a-credential";
    try { child = await launchChild(f.launch, join(f.root, "child"), randomUUID()); }
    finally { if (oldKey === undefined) delete process.env.PI_SUBAGENT_FIXTURE_KEY; else process.env.PI_SUBAGENT_FIXTURE_KEY = oldKey; }
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
    await assert.rejects(launchChild({ ...f.launch, providerContract: { ...f.launch.providerContract, baseUrl: "http://different.invalid" } }, join(f.root, "bad-endpoint"), randomUUID()), /differs/);
    const broken = join(f.root, "broken.ts");
    await writeFile(broken, 'export default function(pi) { pi.on("session_start", () => { throw new Error("STARTUP_FAILURE"); }); }');
    await assert.rejects(launchChild({ ...f.launch, extensions: [...f.launch.extensions, broken] }, join(f.root, "bad-startup"), randomUUID()), /STARTUP_FAILURE/);
    const prompt = join(f.root, "prompt.ts");
    await writeFile(prompt, 'export default function(pi) { pi.on("session_start", (_event, ctx) => { void ctx.ui.confirm("Unexpected permission", "Allow?"); }); }');
    await assert.rejects(launchChild({ ...f.launch, extensions: [...f.launch.extensions, prompt] }, join(f.root, "bad-prompt"), randomUUID()), /Unexpected child UI/);
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
      if (command.type === "clear_queue") return { data: { steering: [], followUp: [] } };
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

test("oversized records are dropped without killing the child", { timeout: 10_000 }, async () => {
  const script = `const rl = require("node:readline").createInterface({ input: process.stdin });
    rl.on("line", line => {
      const { id, type } = JSON.parse(line);
      process.stdout.write(JSON.stringify({ type: "agent_end", messages: ["x".repeat(5 * 1024 * 1024)] }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "response", id, command: type, success: true, data: {} }) + "\\n");
    });
    rl.on("close", () => process.exit(0));`;
  const child = new RpcProcess("-e", [script], process.cwd(), process.env, randomUUID());
  try {
    assert.equal((await child.request({ type: "get_state" })).command, "get_state");
    assert.equal(child.exited, false);
  } finally { await child.close(); }
});
