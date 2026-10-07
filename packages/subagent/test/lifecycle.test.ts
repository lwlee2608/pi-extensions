import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, stat, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RpcClient, getPackageDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fixture, changedUntil } from "./helpers.ts";

for (const source of ["CLI", "settings"] as const) test(`parent inherits ${source} provider without child config and completes offline RPC start/wait/stop`, { timeout: 30_000 }, async () => {
  const f = await fixture();
  const client = new RpcClient({ cliPath: join(getPackageDir(), "dist/cli.js"), cwd: f.launch.cwd,
    env: { PI_CODING_AGENT_DIR: f.launch.agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
    args: [...(source === "CLI" ? ["--no-extensions", "--extension", f.launch.extensions[0]] : []),
      "--no-approve", "--no-session", "--provider", "subagent-offline", "--model", "fixture", "--thinking", "off",
      "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--tools", "subagent"] });
  try {
    await rm(join(f.launch.agentDir, "pi-subagent/config.json"));
    if (source === "settings") await writeFile(join(f.launch.agentDir, "settings.json"), JSON.stringify({
      packages: [f.launch.extensions[0]], retry: { enabled: false }, compaction: { enabled: false },
      extensions: ["-builtin:llama.cpp", "-builtin:tool-search", "-builtin:mcp"],
    }));
    await client.start();
    const events = await client.promptAndWait("PARENT_SMOKE", undefined, 20_000);
    const results = events.filter(e => e.type === "tool_execution_end");
    assert.equal(results.length, 3);
    assert.ok(results.every(e => !e.isError), JSON.stringify(results));
    const wait = JSON.parse(results[1].result.content[0].text);
    assert.equal(wait.runs[0].result.outcome, "completed");
    assert.match(wait.runs[0].result.text, /CHILD_SMOKE/);
    assert.equal(wait.workers[0].output, undefined); assert.equal(wait.workers[0].result.text, undefined);
    const stop = JSON.parse(results[2].result.content[0].text);
    assert.equal(stop.processAlive, false);
    assert.throws(() => process.kill(stop.pid, 0), /ESRCH/);
    const saved = JSON.parse(await readFile(join(f.launch.agentDir, "pi-subagent", (await client.getState()).sessionId, stop.workerId, "worker.json"), "utf8"));
    assert.deepEqual(saved.launch.extensions, [...f.launch.extensions, ...(source === "settings" ? ["builtin:codemode"] : [])]);
  } finally { await client.stop(); await f.cleanup(); }
});

// These tests use real Pi CLI/RPC children and real tools, without network/auth.
test("retained tasks share PID/session/context, runs stay immutable and input stays literal", { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const first = f.manager.start(f.launch, "MARKER-219\u2028literal", "retained");
    await assert.rejects(f.manager.message(first.workerId, "too soon"), /idle retained/);
    const completed = await f.manager.wait([first.runId]);
    assert.equal(completed.runs[0].result?.outcome, "completed");
    const before = f.manager.status(first.workerId)[0];
    const second = await f.manager.message(first.workerId, "/fixture-command recall marker");
    assert.notEqual(first.runId, second.runId);
    const next = await f.manager.wait([second.runId]);
    assert.match(next.runs[0].result!.text, /MARKER-219/);
    assert.match(next.runs[0].result!.text, /\/fixture-command recall marker/);
    const after = f.manager.status(first.workerId)[0];
    assert.equal(after.pid, before.pid); assert.equal(after.sessionId, before.sessionId);
    assert.deepEqual((await f.manager.wait([first.runId])).runs, completed.runs);
    assert.equal(f.manager.takeUsage()?.totalTokens, 22); assert.equal(f.manager.takeUsage(), undefined);
    assert.ok(after.sessionFile); assert.match(await readFile(after.sessionFile!, "utf8"), /MARKER-219/);
    const stopped = await f.manager.stop(first.workerId);
    assert.equal(stopped.result?.outcome, "completed");
    assert.throws(() => process.kill(before.pid!, 0), /ESRCH/);
  } finally { await f.cleanup(); }
});

test("wait cancellation leaves real work alive, steer stays on the run, stop preserves edits", { timeout: 40_000 }, async () => {
  const f = await fixture();
  try {
    const run = f.manager.start(f.launch, "WRITE_AND_HOLD", "retained");
    await changedUntil(f.manager, () => f.manager.status()[0].activity === "tool: fixture_hold");
    const controller = new AbortController();
    const waiting = f.manager.wait([run.runId], "all", 30_000, controller.signal);
    controller.abort(); await assert.rejects(waiting, /abort/i);
    assert.equal(f.manager.status()[0].state, "working");
    const steer = await f.manager.message(run.workerId, "STEER-MARKER", "steer");
    assert.equal(steer.runId, run.runId);
    const done = await f.manager.wait([run.runId]);
    assert.equal(done.runs[0].result?.outcome, "completed");
    assert.match(done.runs[0].result!.text, /STEER-MARKER/);
    const second = await f.manager.message(run.workerId, "WRITE_AND_HOLD");
    await changedUntil(f.manager, () => f.manager.status()[0].activity === "tool: fixture_hold");
    const stopped = await f.manager.stop(run.workerId);
    assert.equal(stopped.result?.outcome, "interrupted");
    assert.equal((await f.manager.wait([second.runId])).runs[0].result?.outcome, "interrupted");
    assert.equal(await readFile(join(f.launch.cwd, "fixture-edit.txt"), "utf8"), "keep this edit");
    assert.throws(() => process.kill(stopped.pid!, 0), /ESRCH/);
    assert.equal((await f.manager.stop(run.workerId)).result?.outcome, "interrupted");
  } finally { await f.cleanup(); }
});

test("late steering is cleared before another task and stop preserves final provider usage", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    const run = f.manager.start(f.launch, "WRITE_AND_HOLD", "retained");
    await changedUntil(f.manager, () => f.manager.status()[0].activity === "tool: fixture_hold");
    await assert.rejects(f.manager.message(run.workerId, "LATE_STEER", "steer"), /settled during steering/);
    await f.manager.wait([run.runId]);
    const next = await f.manager.message(run.workerId, "recall history");
    const done = await f.manager.wait([next.runId]);
    assert.doesNotMatch(done.runs[0].result!.text, /LATE_STEER/);
    const slow = await f.manager.message(run.workerId, "SLOW_BILLABLE");
    await changedUntil(f.manager, () => f.manager.status()[0].output.includes("BILLABLE_RESPONSE"));
    await f.manager.stop(run.workerId);
    const stopped = (await f.manager.wait([slow.runId])).runs[0].result!;
    assert.equal(stopped.outcome, "interrupted");
    assert.equal(stopped.usage.totalTokens, 11);
  } finally { await f.cleanup(); }
});

test("steering past its RPC deadline closes the uncertain worker before another task", { timeout: 45_000 }, async () => {
  const f = await fixture();
  try {
    const run = f.manager.start(f.launch, "WRITE_AND_HOLD", "retained");
    await changedUntil(f.manager, () => f.manager.status()[0].activity === "tool: fixture_hold");
    await assert.rejects(f.manager.message(run.workerId, "TIMEOUT_STEER", "steer"), /delivery uncertain/);
    const result = await f.manager.wait([run.runId]);
    assert.equal(result.runs[0].result?.outcome, "interrupted");
    assert.equal(f.manager.status()[0].processAlive, false);
    await assert.rejects(f.manager.message(run.workerId, "must not inherit guidance"), /idle retained/);
  } finally { await f.cleanup(); }
});

test("real failed truncation recovery does not report task success", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.launch.agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: true, keepRecentTokens: 0 } }));
    const initial = f.manager.start(f.launch, "prior context", "retained");
    await f.manager.wait([initial.runId]);
    const run = await f.manager.message(initial.workerId, "TRUNCATE_RECOVERY");
    const result = await f.manager.wait([run.runId], "all", 15_000);
    assert.equal(result.reason, "completed");
    assert.equal(result.runs[0].result?.outcome, "failed", JSON.stringify(result));
    assert.match(result.runs[0].result?.error ?? "", /compact|recover|context/i);
  } finally { await f.cleanup(); }
});

test("truncated final response without recovery is not reported as success", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const run = f.manager.start(f.launch, "TRUNCATE_RECOVERY");
    const result = await f.manager.wait([run.runId], "all", 15_000);
    assert.equal(result.runs[0].result?.outcome, "failed", JSON.stringify(result));
    assert.match(result.runs[0].result?.error ?? "", /truncated/);
  } finally { await f.cleanup(); }
});

test("more than sixteen one-shot reviews retire and preserve failed/handled results", { timeout: 150_000 }, async () => {
  const f = await fixture();
  try {
    const runIds: string[] = [];
    for (let i = 0; i < 18; i++) {
      const run = f.manager.start(f.launch, `review ${i}`); runIds.push(run.runId);
      const result = await f.manager.wait([run.runId]);
      assert.equal(result.runs[0].result?.outcome, "completed");
      await changedUntil(f.manager, () => f.manager.status(run.workerId)[0].processAlive === false);
      const view = f.manager.status(run.workerId)[0];
      assert.equal(view.state, "closed"); assert.throws(() => process.kill(view.pid!, 0), /ESRCH/);
      assert.equal((await stat(join(f.launch.agentDir, "pi-subagent/fixture-parent", run.workerId, `${run.runId}.json`))).mode & 0o777, 0o600);
    }
    assert.equal((await f.manager.wait(runIds)).runs.filter(r => r.result?.outcome === "completed").length, 18);
    for (const task of ["FAIL_PROVIDER", "HANDLE_INPUT"]) {
      const run = f.manager.start(f.launch, task);
      const done = await f.manager.wait([run.runId]);
      assert.equal(done.runs[0].result?.outcome, "failed");
      await f.manager.stop(run.workerId);
    }
  } finally { await f.cleanup(); }
});
