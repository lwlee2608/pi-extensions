import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, changedUntil } from "./helpers.ts";
import { validateAction } from "../src/schema.ts";

test("blocked question interrupts waits on queued siblings; reply works at full capacity", { timeout: 25_000 }, async () => {
  const f = await fixture({ maxActive: 1, maxWorkers: 3 });
  try {
    const first = f.manager.start(f.launch, "ASK_PARENT", "retained");
    const sibling = f.manager.start(f.launch, "queued sibling");
    assert.equal(sibling.state, "queued"); assert.equal(sibling.pid, undefined);
    const attention = await f.manager.wait([sibling.runId]);
    assert.equal(attention.reason, "attention"); assert.equal(attention.pendingQuestionIds.length, 1);
    const questionId = attention.pendingQuestionIds[0];
    const blocked = f.manager.status(first.workerId)[0];
    assert.equal(blocked.state, "blocked");
    await assert.rejects(f.manager.message(first.workerId, "new task"), /idle retained/);
    await assert.rejects(f.manager.message(first.workerId, "steer", "steer"), /working child/);
    assert.equal((await f.manager.reply(questionId, "answer.txt")).delivered, true);
    await assert.rejects(f.manager.reply(questionId, "duplicate"), /stale|already answered/);
    const result = await f.manager.wait([first.runId, sibling.runId]);
    assert.equal(result.reason, "completed");
    assert.ok(result.runs.every(r => r.result?.outcome === "completed"));
    assert.match(result.runs[0].result!.text, /Parent answer: answer.txt/);
    assert.equal(f.manager.status(first.workerId)[0].runId, first.runId);
  } finally { await f.cleanup(); }
});

test("stop and explicit cancellation cancel pending questions and reject stale replies", { timeout: 25_000 }, async () => {
  const f = await fixture({ maxActive: 1 });
  try {
    for (const cancel of [false, true]) {
      const first = f.manager.start(f.launch, "ASK_PARENT", "retained");
      const attention = await f.manager.wait([first.runId]);
      const questionId = attention.pendingQuestionIds[0];
      if (cancel) await f.manager.reply(questionId, undefined, true);
      else await f.manager.stop(first.workerId);
      const result = await f.manager.wait([first.runId]);
      assert.equal(result.reason, "completed"); assert.equal(result.runs[0].result?.outcome, "interrupted");
      const view = f.manager.status(first.workerId)[0];
      assert.equal(view.questions?.[0].state, "cancelled"); assert.equal(view.processAlive, false);
      await assert.rejects(f.manager.reply(questionId, "stale"), /stale|already answered/);
    }
    assert.throws(() => validateAction({ action: "reply", questionId: "q-one", message: "yes", cancelled: true }), /Invalid/);
    assert.throws(() => validateAction({ action: "reply", questionId: "q-one" }), /Invalid/);
  } finally { await f.cleanup(); }
});

test("question gates a later write in the same response, including cancellation", { timeout: 25_000 }, async () => {
  for (const cancelled of [true, false]) {
    const f = await fixture();
    try {
      const run = f.manager.start(f.launch, "ASK_PARENT THEN_WRITE", "retained");
      const attention = await f.manager.wait([run.runId]);
      const output = join(f.launch.cwd, "after-question.txt");
      await assert.rejects(readFile(output), /ENOENT/);
      await f.manager.reply(attention.pendingQuestionIds[0], cancelled ? undefined : "Proceed", cancelled);
      const done = await f.manager.wait([run.runId]);
      if (cancelled) {
        assert.equal(done.runs[0].result?.outcome, "interrupted");
        await assert.rejects(readFile(output), /ENOENT/);
      } else {
        assert.equal(done.runs[0].result?.outcome, "completed");
        assert.equal(await readFile(output, "utf8"), "only after reply");
      }
    } finally { await f.cleanup(); }
  }
});

test("nested tools cannot invoke the blocking question tool", { timeout: 15_000 }, async () => {
  const f = await fixture();
  try {
    const run = f.manager.start({ ...f.launch, profile: { ...f.launch.profile, tools: [...f.launch.profile.tools, "fixture_nested"] } }, "NESTED_QUESTION");
    const result = await f.manager.wait([run.runId]);
    assert.equal(result.reason, "completed"); assert.equal(result.runs[0].result?.outcome, "completed");
    assert.deepEqual(result.pendingQuestionIds, []);
    const session = f.manager.status(run.workerId)[0].sessionFile!;
    assert.match(await readFile(session, "utf8"), /NESTED_DENIED/);
  } finally { await f.cleanup(); }
});

test("unexpected permission confirmation is refused, never auto-approved", { timeout: 20_000 }, async () => {
  const f = await fixture();
  try {
    const run = f.manager.start({ ...f.launch, profile: { ...f.launch.profile, tools: [...f.launch.profile.tools, "fixture_permission"] } }, "UNEXPECTED_PERMISSION");
    const result = await f.manager.wait([run.runId]);
    assert.equal(result.runs[0].result?.outcome, "failed");
    assert.match(result.runs[0].result?.error ?? "", /never auto-approved/);
    assert.doesNotMatch(result.runs[0].result?.text ?? "", /AUTO_APPROVED/);
    await changedUntil(f.manager, () => f.manager.status(run.workerId)[0].processAlive === false);
  } finally { await f.cleanup(); }
});

test("stopping queued work never spawns it and frees a reserved worker", { timeout: 20_000 }, async () => {
  const f = await fixture({ maxActive: 1, maxWorkers: 2 });
  try {
    const active = f.manager.start(f.launch, "ASK_PARENT", "retained");
    await changedUntil(f.manager, () => f.manager.status(active.workerId)[0].state === "blocked");
    const queued = f.manager.start(f.launch, "must not run");
    assert.throws(() => f.manager.start(f.launch, "over cap"), /cap reached/);
    const stopped = await f.manager.stop(queued.workerId);
    assert.equal(stopped.pid, undefined); assert.equal(stopped.result?.outcome, "interrupted");
    const replacement = f.manager.start(f.launch, "replacement");
    assert.equal(replacement.state, "queued");
    await f.manager.stop(active.workerId);
    assert.equal((await f.manager.wait([replacement.runId])).runs[0].result?.outcome, "completed");
  } finally { await f.cleanup(); }
});
