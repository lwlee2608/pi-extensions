import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Manager } from "../src/manager.ts";
import { fixture, changedUntil } from "./helpers.ts";

async function parentProcess(root: string) {
  const child = fork(fileURLToPath(new URL("./fixtures/parent.ts", import.meta.url)), [root], { stdio: ["ignore", "ignore", "pipe", "ipc"], env: { ...process.env, PI_OFFLINE: "1" } });
  let diagnostic = ""; child.stderr?.on("data", data => { diagnostic += data; });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve()); child.once("exit", code => reject(new Error(`Parent exited ${code}: ${diagnostic}`)));
  });
  const call = (action: string, args: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { child.off("message", listener); reject(new Error(`Parent ${action} timed out: ${diagnostic}`)); }, 20_000);
    const listener = (value: unknown) => { const reply = value as { id?: string; error?: string; result?: unknown }; if (reply.id !== id) return; clearTimeout(timer); child.off("message", listener); if (reply.error) reject(new Error(reply.error)); else resolve(reply.result); };
    child.on("message", listener); child.send({ id, action, ...args });
  });
  return { child, call, exited };
}

test("a disposable parent process exits then recovers the original conversation", { timeout: 30_000 }, async () => {
  const f = await fixture(); let parent: Awaited<ReturnType<typeof parentProcess>> | undefined;
  try {
    const root = join(f.launch.agentDir, "pi-subagent");
    parent = await parentProcess(root);
    const run = await parent.call("start", { launch: f.launch, task: "PROCESS_MARKER" });
    await parent.call("wait", { runId: run.runId });
    const before = (await parent.call("status"))[0];
    await parent.call("shutdown"); assert.equal(await parent.exited, 0);
    assert.throws(() => process.kill(before.pid, 0), /ESRCH/);
    parent = await parentProcess(root);
    const after = await parent.call("recover", { workerId: run.workerId });
    assert.equal(after.state, "idle"); assert.notEqual(after.pid, before.pid); assert.equal(after.sessionId, before.sessionId);
    const next = await parent.call("message", { workerId: run.workerId, task: "Recall saved task" });
    assert.match((await parent.call("wait", { runId: next.runId })).runs[0].result.text, /PROCESS_MARKER/);
    await parent.call("shutdown"); assert.equal(await parent.exited, 0);
  } finally { if (parent?.child.exitCode === null) { await parent.call("shutdown"); await parent.exited; } await f.cleanup(); }
});

function reopen(root: string, parentId = "fixture-parent") { return new Manager({ root, parentId }); }
test("shutdown reopens retained context idle with new PID, immutable results and cancelled questions", { timeout: 30_000 }, async () => {
  const f = await fixture(); let restored: Manager | undefined;
  try {
    const idle = f.manager.start(f.launch, "RECOVERY_MARKER", "retained");
    const first = await f.manager.wait([idle.runId]);
    const blocked = f.manager.start(f.launch, "ASK_PARENT", "retained");
    const attention = await f.manager.wait([blocked.runId]);
    const questionId = attention.pendingQuestionIds[0];
    const working = f.manager.start(f.launch, "WRITE_AND_HOLD", "retained");
    await changedUntil(f.manager, () => f.manager.status(working.workerId)[0].activity === "tool: fixture_hold");
    const before = f.manager.status();
    await f.manager.shutdown();
    for (const view of before) assert.throws(() => process.kill(view.pid!, 0), /ESRCH/);
    const root = join(f.launch.agentDir, "pi-subagent");
    restored = reopen(root);
    assert.ok(restored.status().every(w => w.state === "closed" && w.processAlive === false));
    assert.deepEqual((await restored.wait([idle.runId])).runs, first.runs);
    assert.equal((await restored.wait([working.runId])).runs[0].result?.outcome, "interrupted");
    assert.equal(restored.status(blocked.workerId)[0].questions?.[0].state, "cancelled");
    await assert.rejects(restored.reply(questionId, "stale"), /stale|already answered/);
    const extraSkill = join(f.launch.agentDir, "skills/added/SKILL.md");
    await mkdir(join(f.launch.agentDir, "skills/added"), { recursive: true });
    await writeFile(extraSkill, "---\nname: added-after-stop\ndescription: UNAPPROVED_SKILL_MARKER\n---\nDo not load in recovered children.\n");
    const path = restored.status(idle.workerId)[0].sessionFile!;
    const transcript = await readFile(path, "utf8");
    const stop = restored.stop(idle.workerId);
    const competing = await Promise.allSettled([restored.recover(idle.workerId), restored.recover(idle.workerId)]);
    await stop;
    assert.equal(competing.filter(r => r.status === "fulfilled").length, 1);
    const recovered = (competing.find(r => r.status === "fulfilled") as PromiseFulfilledResult<ReturnType<Manager["status"]>[number]>).value;
    assert.equal(recovered.state, "idle"); assert.equal(recovered.sessionId, before[0].sessionId); assert.notEqual(recovered.pid, before[0].pid);
    assert.equal(await readFile(path, "utf8"), transcript, "recovery alone must not request the provider");
    const next = await restored.message(idle.workerId, "recall previous task");
    assert.notEqual(next.runId, idle.runId);
    assert.match((await restored.wait([next.runId])).runs[0].result!.text, /RECOVERY_MARKER/);
    assert.doesNotMatch(await readFile(path, "utf8"), /UNAPPROVED_SKILL_MARKER/);
    const recoveredBlocked = await restored.recover(blocked.workerId);
    assert.equal(recoveredBlocked.state, "idle");
    await assert.rejects(restored.reply(questionId, "still stale"), /stale|already answered/);
    const continued = await restored.message(blocked.workerId, "Decision: use recovery.txt. Recall prior context.");
    assert.equal((await restored.wait([continued.runId])).runs[0].result?.outcome, "completed");
    assert.equal(restored.status(blocked.workerId)[0].questions?.[0].state, "cancelled");
    assert.equal(await readFile(join(f.launch.cwd, "fixture-edit.txt"), "utf8"), "keep this edit");
  } finally { await restored?.shutdown(); await f.cleanup(); }
});

test("exclusive parent ownership, foreign/one-shot/live refusal and changed prerequisites", { timeout: 30_000 }, async () => {
  const f = await fixture(); let restored: Manager | undefined, foreign: Manager | undefined;
  try {
    const root = join(f.launch.agentDir, "pi-subagent");
    assert.throws(() => reopen(root), /owned|uncertain/);
    const retained = f.manager.start(f.launch, "saved", "retained");
    await f.manager.wait([retained.runId]);
    await assert.rejects(f.manager.recover(retained.workerId), /closed retained/);
    const once = f.manager.start(f.launch, "once"); await f.manager.wait([once.runId]); await f.manager.stop(once.workerId);
    await assert.rejects(f.manager.recover(once.workerId), /closed retained/);
    foreign = reopen(root, "foreign-parent"); await assert.rejects(foreign.recover(retained.workerId), /Unknown worker/);
    await f.manager.stop(retained.workerId);
    const original = await readFile(f.launch.profile.path, "utf8");
    await writeFile(f.launch.profile.path, "changed profile");
    await assert.rejects(f.manager.recover(retained.workerId), /prerequisites changed/);
    await writeFile(f.launch.profile.path, original);
    await rename(f.launch.cwd, `${f.launch.cwd}.hidden`);
    await assert.rejects(f.manager.recover(retained.workerId), /ENOENT|cwd/);
    await rename(`${f.launch.cwd}.hidden`, f.launch.cwd);
    const session = f.manager.status(retained.workerId)[0].sessionFile!;
    await rename(session, `${session}.hidden`);
    await assert.rejects(f.manager.recover(retained.workerId), /ENOENT|session file/);
    await rename(`${session}.hidden`, session);
    await writeFile(join(f.launch.agentDir, "pi-subagent/config.json"), '{"extensions":{}}');
    await assert.rejects(f.manager.recover(retained.workerId), /no longer approved/);
    await f.manager.shutdown();
    restored = reopen(root);
    assert.equal((await restored.wait([retained.runId])).runs[0].result?.outcome, "completed");
  } finally { await foreign?.shutdown(); await restored?.shutdown(); await f.cleanup(); }
});

test("failed first admission leaves existing saved workers loadable", { timeout: 20_000 }, async () => {
  const f = await fixture(); let restored: Manager | undefined;
  try {
    const saved = f.manager.start(f.launch, "keep saved worker", "retained"); await f.manager.wait([saved.runId]);
    assert.throws(() => f.manager.start({ ...f.launch, profile: { ...f.launch.profile, prompt: "x".repeat(21 * 1024 * 1024) } }, "must not admit"), /metadata exceeds/);
    await f.manager.shutdown();
    restored = reopen(join(f.launch.agentDir, "pi-subagent"));
    assert.equal(restored.status().length, 1);
    assert.equal((await restored.wait([saved.runId])).runs[0].result?.outcome, "completed");
  } finally { await restored?.shutdown(); await f.cleanup(); }
});

test("recovery refuses revoked project-profile trust", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const config = join(f.launch.agentDir, "pi-subagent/config.json");
    await writeFile(config, JSON.stringify({ extensions: { fixture: f.launch.extensions[0] }, trustedProjectRoots: [f.launch.cwd] }));
    const run = f.manager.start({ ...f.launch, profile: { ...f.launch.profile, trustedProjectRoot: f.launch.cwd } }, "trusted profile", "retained");
    await f.manager.wait([run.runId]); await f.manager.stop(run.workerId);
    await writeFile(config, JSON.stringify({ extensions: { fixture: f.launch.extensions[0] } }));
    await assert.rejects(f.manager.recover(run.workerId), /trust was revoked/);
  } finally { await f.cleanup(); }
});

test("corrupt metadata and uncertain ownership fail closed without changing foreign records", { timeout: 20_000 }, async () => {
  const f = await fixture(); let restored: Manager | undefined;
  try {
    const run = f.manager.start(f.launch, "saved", "retained"); await f.manager.wait([run.runId]); await f.manager.shutdown();
    const root = join(f.launch.agentDir, "pi-subagent"), path = join(root, "fixture-parent", run.workerId, "worker.json");
    const saved = await readFile(path, "utf8");
    await writeFile(path, "{broken"); assert.throws(() => reopen(root), /JSON|property|Unexpected/);
    await writeFile(path, JSON.stringify({ ...JSON.parse(saved), parentId: "foreign" })); assert.throws(() => reopen(root), /foreign/);
    const uncertain = { ...JSON.parse(saved), ownership: "owned" };
    await writeFile(path, JSON.stringify(uncertain));
    restored = reopen(root);
    await assert.rejects(restored.recover(run.workerId), /certain ownership/);
    assert.equal(await readFile(path, "utf8"), JSON.stringify(uncertain));
    await assert.rejects(restored.shutdown(), /ownership lock retained/);
  } finally {
    // This case deliberately leaves an uncertain record. Remove only its disposable directory.
    await f.cleanup();
  }
});
