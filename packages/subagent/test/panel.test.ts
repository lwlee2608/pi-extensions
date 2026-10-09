import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { panelLines, display } from "../src/panel.ts";
import type { Snapshot, Step } from "../src/manager.ts";
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
  assert.match(panelLines([worker], 120, 1000).join(" "), /tool: read · next/);
  assert.equal(display("\x1b]0;bad title\x07hello\u202e"), "hello ");
});

test("multi-worker panel is bounded, prioritizes questions and shows overflow", () => {
  const workers: Snapshot[] = Array.from({ length: 8 }, (_, i) => ({ ...worker, workerId: `w-${i}`, label: `worker ${i}` }));
  workers[7] = { ...workers[7], state: "blocked", questions: [{ questionId: "q-one", workerId: "w-7", runId: "r-one", generation: "g", requestId: "request", question: "Choose file", state: "pending" }] };
  const lines = panelLines(workers, 100, 1000);
  assert.equal(lines.length, 9); assert.match(lines[0], /^\? worker 7/); assert.match(lines[1], /reply q-one: Choose file/);
  assert.match(lines.at(-1)!, /\+4 more/);
  const withIdle = [...workers.slice(0, 4).map(w => ({ ...w, state: "idle" as const })), { ...worker, label: "active reviewer" }];
  assert.match(panelLines(withIdle, 100)[0], /active reviewer/);
  for (const width of [1, 5, 40]) for (const line of panelLines(workers, width)) assert.ok(visibleWidth(line) <= width);
});

test("finished worker shows outcome icon, context, cost and first plain output line, then hides", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 648184, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.4213 } };
  const done: Snapshot = { ...worker, state: "closed", activity: "completed", output: "**Reviewed:** PR #133 (`e13ee6d`)\nmore", context: 82_400, result: { outcome: "completed", text: "", endedAt: 123_000, usage } };
  assert.deepEqual(panelLines([done], 120, 124_000), ["✓ 界面 😀 · 2m03s · ctx 82k · $0.42", "  └ Reviewed: PR #133 (e13ee6d)"]);
  assert.match(panelLines([{ ...done, result: { ...done.result!, outcome: "failed" }, error: "boom" }], 120, 124_000).join("\n"), /^✗ .*\n  └ boom$/);
  assert.deepEqual(panelLines([done], 120, 128_000), []);
  assert.deepEqual(panelLines([{ ...done, state: "idle" }], 120, 128_000), []);
  assert.equal(panelLines([{ ...done, recoverable: true }], 120, 999_000).length, 2);
  const colored = { fg: (color: string, text: string) => `\x1b[3${color.length % 8}m${text}\x1b[0m` };
  for (const width of [1, 10, 30]) for (const line of panelLines([done], width, 124_000, colored)) assert.ok(visibleWidth(line) <= width);
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
    await mkdir(join(f.launch.agentDir, "pi-subagent"), { recursive: true });
    await writeFile(join(f.launch.agentDir, "pi-subagent/config.json"), '{"extensions":{"provider":"/does-not-exist"}}');
    await assert.rejects(loadConfig(f.launch.agentDir), /ENOENT/);
  } finally { await f.cleanup(); }
});

test("nested workers collapse into one panel entry with a step chain", () => {
  const usage = (total: number) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
  const root: Snapshot = { ...worker, workerId: "w-root", runId: "r-2", label: "Phase 1 round 1 fixes", state: "idle", output: "fixed", startedAt: 0, result: { outcome: "completed", text: "", endedAt: 50_000, usage: usage(0.5) } };
  const child: Snapshot = { ...worker, workerId: "w-child", runId: "r-3", label: "phase 1 review", parentWorkerId: "w-root", state: "working", activity: "tool: bash", output: "gh pr diff 69", startedAt: 60_000, context: 41_000, usage: usage(0.2) };
  const steps: Step[] = [
    { runId: "r-1", workerId: "w-root", label: "owctl phase 1", startedAt: 0, agent: "worker", state: "idle", result: { outcome: "completed", text: "", endedAt: 30_000, usage: usage(1) } },
    { runId: "r-2", workerId: "w-root", label: "Phase 1 round 1 fixes", startedAt: 40_000, agent: "worker", state: "idle", result: root.result },
    { runId: "r-3", workerId: "w-child", label: "phase 1 review", startedAt: 60_000, agent: "reviewer", parentWorkerId: "w-root", state: "working" },
  ];
  const lines = panelLines([root, child], 200, 104_000, undefined, steps);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^⠋ owctl phase 1 · 1m44s · ctx 41k · \$1\.70 · ✓ worker › ✓ worker › ⠋ reviewer$/);
  const rounds = [...steps.slice(0, 2), ...steps.slice(0, 2), ...steps.slice(0, 2), steps[2]];
  assert.equal(panelLines([root, child], 80, 104_000, undefined, rounds)[0], "⠋ owctl phase 1 · 1m44s · ctx 41k · $4.70 · +5 › ✓ worker › ⠋ reviewer");
  assert.equal(lines[1], "  └ tool: bash · gh pr diff 69");
  const asking = { ...child, state: "blocked" as const, questions: [{ questionId: "q-one", workerId: "w-child", runId: "r-3", generation: "g", requestId: "request", question: "Which file?", state: "pending" as const }] };
  assert.match(panelLines([root, asking], 200, 104_000, undefined, steps).join("\n"), /^\? owctl phase 1.*\n  └ reply q-one: Which file\?$/);
  const orphan = { ...child, parentWorkerId: "w-missing" };
  const standalone = panelLines([orphan], 200, 104_000, undefined, steps.slice(2));
  assert.match(standalone[0], /^⠋ phase 1 review · 44s/);
  assert.equal(panelLines([root, child], 200, 104_000).length, 2);
  const colored = { fg: (color: string, text: string) => `\x1b[3${color.length % 8}m${text}\x1b[0m` };
  for (const width of [1, 10, 80]) for (const theme of [undefined, colored]) for (const line of panelLines([root, child], width, 104_000, theme, steps)) assert.ok(visibleWidth(line) <= width);
});

test("start accepts a well-formed parentWorkerId only", () => {
  validateAction({ action: "start", agent: "reviewer", task: "x", parentWorkerId: "w-1234" });
  assert.throws(() => validateAction({ action: "start", agent: "reviewer", task: "x", parentWorkerId: "../w" }), /Invalid/);
});
