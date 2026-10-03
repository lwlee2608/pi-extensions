import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { readRows } from "../src/registry.ts";

test("adapter writes only metadata across work, UI, tools, compaction and settlement", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-adapter-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  extension({ on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: () => {} } as unknown as ExtensionAPI);
  const ctx = { mode: "tui", cwd: "/test", isIdle: () => true, ui: { notify: () => {} }, sessionManager: { getSessionId: () => "id", getSessionName: () => "name" } } as unknown as ExtensionContext;
  const emit = async (type: string, data = {}) => { await handlers.get(type)?.({ type, ...data }, ctx); };
  const row = async () => (await readRows(join(root, "pi-session-board")))[0];
  try {
    await emit("session_start"); await emit("agent_start", { prompt: "PRIVATE_PROMPT" });
    await emit("tool_execution_start", { toolCallId: "a", toolName: "bash", args: { command: "PRIVATE_ARGS" } });
    await emit("ui_prompt_start", { kind: "confirm", title: "PRIVATE_TITLE" });
    assert.equal((await row()).status, "needs-input");
    await emit("ui_prompt_end");
    await emit("tool_execution_end", { toolCallId: "a", isError: true, result: "PRIVATE_OUTPUT" });
    assert.equal((await row()).status, "working");
    await emit("session_before_compact"); assert.equal((await row()).activity, "compacting");
    await emit("session_compact");
    await emit("agent_before_settle", { outcome: "completed" }); await emit("agent_settled");
    assert.equal((await row()).status, "idle");
    await emit("agent_start"); await emit("agent_before_settle", { outcome: "error", errorMessage: "PRIVATE_ERROR" }); await emit("agent_settled");
    assert.equal((await row()).status, "failed");
    const dir = join(root, "pi-session-board");
    for (const file of (await readdir(dir)).filter(name => name.endsWith(".json"))) assert.doesNotMatch(await readFile(join(dir, file), "utf8"), /PRIVATE_/);
    const oldId = (await row()).registrationId;
    await emit("session_shutdown", { reason: "reload" });
    await emit("session_start", { reason: "reload" });
    assert.notEqual((await row()).registrationId, oldId);
    assert.equal((await readRows(dir)).length, 1);
    await Promise.all([emit("session_start"), emit("session_shutdown")]);
    assert.equal((await readRows(dir)).length, 0);
  } finally {
    await emit("session_shutdown");
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
