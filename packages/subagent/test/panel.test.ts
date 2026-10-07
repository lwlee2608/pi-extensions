import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { panelLines, display } from "../src/panel.ts";
import type { Snapshot } from "../src/manager.ts";
import { validateAction } from "../src/schema.ts";
import { loadConfig, resolveLaunch } from "../src/profiles.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.ts";

const worker: Snapshot = { workerId: "w-one", runId: "r-one", sessionId: "session", state: "working", lifetime: "retained", label: "界面 😀",
  cwd: "/tmp", model: "offline/fixture", effort: "off", activity: "tool: read", output: "streamed \x1b[31mprogress\x1b[0m\nnext", startedAt: 0 };
test("panel fits narrow/Unicode widths and strips child terminal controls", () => {
  for (const width of [0, 1, 2, 8, 30, 80]) {
    const lines = panelLines([worker], width, 1000);
    assert.ok(lines.length <= 2);
    for (const line of lines) { assert.ok(visibleWidth(line) <= width); assert.doesNotMatch(line.replaceAll("\x1b[0m", ""), /[\x00-\x1f]/); }
  }
  assert.match(panelLines([worker], 120, 1000).join(" "), /tool: read.*streamed progress/);
  assert.equal(display("\x1b]0;bad title\x07hello\u202e"), "hello ");
});

test("invalid action and launch configuration fail before dispatch", async () => {
  assert.throws(() => validateAction({ action: "wait", runIds: [] }), /Invalid/);
  assert.throws(() => validateAction({ action: "start", agent: "../escape", task: "x" }), /Invalid/);
  assert.throws(() => validateAction({ action: "message", workerId: "w-one", message: "x", mode: "steer", label: "bad" }), /relabel/);
  const f = await fixture();
  try {
    const config = await loadConfig(f.launch.agentDir);
    assert.equal(config.maxActive, 4); assert.equal(config.maxWorkers, 16);
    await assert.rejects(resolveLaunch({ action: "start", agent: "worker", task: "test", model: "missing" }, { cwd: f.launch.cwd, agentDir: f.launch.agentDir, models: [], effort: "off" }, config), /available model/);
    await mkdir(join(f.launch.agentDir, "pi-subagent"));
    await writeFile(join(f.launch.agentDir, "pi-subagent/config.json"), '{"extensions":{"provider":"/does-not-exist"}}');
    await assert.rejects(loadConfig(f.launch.agentDir), /ENOENT/);
  } finally { await f.cleanup(); }
});
