import assert from "node:assert/strict";
import test from "node:test";
import { SessionState } from "../src/state.ts";

test("work, native question, concurrent tools, recovery and final outcomes", () => {
  let now = 1;
  const state = new SessionState(() => now);
  state.start(); assert.equal(state.snapshot().status, "working");
  now = 2;
  state.toolStart("a", "bash"); state.toolStart("a/1", "read");
  assert.deepEqual(state.snapshot().tools, ["bash", "read"]);
  assert.equal(state.snapshot().statusSince, 1);
  state.promptStart(false); assert.equal(state.snapshot().status, "needs-input");
  now = 3;
  state.promptEnd(); assert.equal(state.snapshot().status, "working");
  state.toolEnd("a/1"); assert.deepEqual(state.snapshot().tools, ["bash"]);
  state.toolEnd("a"); state.beforeSettle("error");
  assert.equal(state.snapshot().status, "working");
  state.start(); state.compactStart(); assert.equal(state.snapshot().activity, "compacting");
  state.compactEnd("completed"); state.beforeSettle("completed"); state.settle();
  assert.equal(state.snapshot().status, "idle");
  state.start(); state.beforeSettle("error"); state.settle(); assert.equal(state.snapshot().status, "failed");
  state.start(); assert.equal(state.snapshot().status, "working");
  state.beforeSettle("aborted"); state.settle();
  assert.equal(state.snapshot().status, "idle"); assert.equal(state.snapshot().activity, "aborted");
});

test("idle dialogs, board overlap limitations, and manual compaction", () => {
  const state = new SessionState();
  state.promptStart(false); assert.equal(state.snapshot().status, "idle"); state.promptEnd();
  state.start(); state.promptStart(true);
  assert.equal(state.snapshot().status, "working"); assert.equal(state.snapshot().waitingUnavailable, true);
  state.promptEnd(); assert.equal(state.snapshot().waitingUnavailable, false);
  state.settle(); state.compactStart(); assert.equal(state.snapshot().status, "working");
  state.compactEnd("error"); assert.equal(state.snapshot().status, "failed");
  state.compactStart(); state.compactEnd("aborted"); assert.equal(state.snapshot().status, "idle");
});
