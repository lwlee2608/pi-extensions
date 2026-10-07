import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, changedUntil } from "./helpers.ts";

function git(cwd: string, ...args: string[]): void { execFileSync("git", args, { cwd, stdio: "pipe" }); }
test("parallel real worktrees stream independently; fresh review feeds the original retained worker", { timeout: 40_000 }, async () => {
  const f = await fixture({ maxActive: 2 });
  try {
    const repo = join(f.root, "repo"), a = join(f.root, "a"), b = join(f.root, "b");
    await mkdir(repo);
    git(repo, "init", "-q"); git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    git(repo, "worktree", "add", "-qb", "a", a); git(repo, "worktree", "add", "-qb", "b", b);
    const first = f.manager.start({ ...f.launch, cwd: a }, "WRITE_AND_HOLD A", "retained");
    const second = f.manager.start({ ...f.launch, cwd: b }, "WRITE_AND_HOLD B", "retained");
    const queued = f.manager.start(f.launch, "FAIL_PROVIDER");
    assert.equal(queued.state, "queued");
    await changedUntil(f.manager, () => f.manager.status(first.workerId)[0].activity === "tool: fixture_hold" && f.manager.status(second.workerId)[0].activity === "tool: fixture_hold");
    const controller = new AbortController();
    const cancelledWait = f.manager.wait([first.runId, second.runId], "all", 10_000, controller.signal);
    controller.abort(); await assert.rejects(cancelledWait);
    const anyWait = f.manager.wait([first.runId, second.runId], "any");
    const allWait = f.manager.wait([first.runId, second.runId, queued.runId]);
    assert.ok((await anyWait).runs.some(r => r.result?.outcome === "completed"));
    const all = await allWait;
    assert.deepEqual(all.runs.map(r => r.result?.outcome), ["completed", "completed", "failed"]);
    assert.equal(await readFile(join(a, "fixture-edit.txt"), "utf8"), "keep this edit");
    assert.equal(await readFile(join(b, "fixture-edit.txt"), "utf8"), "keep this edit");
    await assert.rejects(readFile(join(repo, "fixture-edit.txt")), /ENOENT/);
    await assert.rejects(readFile(join(f.launch.cwd, "fixture-edit.txt")), /ENOENT/);
    const before = f.manager.status(first.workerId)[0];
    const reviewer = f.manager.start({ ...f.launch, cwd: a, profile: { ...f.launch.profile, name: "reviewer", tools: ["read", "bash"] } }, "Review A: FEEDBACK-R1");
    const report = await f.manager.wait([reviewer.runId]);
    await changedUntil(f.manager, () => f.manager.status(reviewer.workerId)[0].processAlive === false);
    assert.doesNotMatch(report.runs[0].result!.text, /WRITE_AND_HOLD/);
    const fixes = await f.manager.message(first.workerId, report.runs[0].result!.text);
    const fixed = await f.manager.wait([fixes.runId]);
    assert.match(fixed.runs[0].result!.text, /WRITE_AND_HOLD A.*FEEDBACK-R1/s);
    const after = f.manager.status(first.workerId)[0];
    assert.equal(after.pid, before.pid); assert.equal(after.sessionId, before.sessionId); assert.notEqual(after.runId, before.runId);
    await f.manager.stop(first.workerId); await f.manager.stop(second.workerId);
    git(repo, "worktree", "remove", "--force", a); git(repo, "worktree", "remove", "--force", b);
  } finally { await f.cleanup(); }
});
