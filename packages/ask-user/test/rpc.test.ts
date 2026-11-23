import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { decodeResponse, RPC_TITLE, runRpcQuestionnaire, snapshot } from "../src/rpc.ts";
import type { Params } from "../src/schema.ts";

const params: Params = { questions: [{ question: "Pick", options: [{ label: "A", preview: "# A" }, { label: "B" }] }] };
const response = (answers: unknown = [{ questionIndex: 1, selected: ["A"] }], extra = {}) => JSON.stringify({ protocol: "pi-ask-user", version: 1, answers, ...extra });
function host(editor: (title: string, prefill?: string) => Promise<string | undefined>) {
  return { mode: "rpc", ui: { editor } } as Pick<ExtensionContext, "mode" | "ui">;
}

test("snapshot validates input strictly and copies nested values", () => {
  const copy = snapshot(params);
  copy.questions[0].options[0].label = "Changed";
  assert.equal(params.questions[0].options[0].label, "A");
  for (const input of [{ questions: [] }, { ...params, extra: true }, { questions: [{ ...params.questions[0], multiSelect: "true" }] }, { questions: [{ ...params.questions[0], options: [{ label: " A " }, { label: "A" }] }] }]) assert.throws(() => snapshot(input));
});

test("answers support custom, notes, partial chat, and canonical ordering", () => {
  const multi = snapshot(params); multi.questions[0].multiSelect = true;
  assert.deepEqual(decodeResponse(response([{ questionIndex: 1, selected: ["B", "A"], custom: "Other", notes: "note" }], { globalNote: "all" }), multi), {
    cancelled: false, answers: [{ questionIndex: 1, selected: ["A", "B"], custom: "Other", notes: "note" }], globalNote: "all",
  });
  assert.deepEqual(decodeResponse(response([], { chat: true }), params), { cancelled: false, answers: [], chat: true });
  assert.equal(decodeResponse(response([{ questionIndex: 1, selected: [], custom: "Other" }]), params).answers[0].custom, "Other");
});

test("malformed, incomplete, forged, duplicate, and incompatible answers fail closed", () => {
  for (const text of ["", "null", "{}", response([], { version: 2 }), response([], { unknown: true }), response([]),
    ...[
      [{ questionIndex: 1, selected: ["unknown"] }], [{ questionIndex: 2, selected: ["A"] }],
      [{ questionIndex: 1, selected: ["A", "A"] }], [{ questionIndex: 1, selected: ["A", "B"] }],
      [{ questionIndex: 1, selected: ["A"], custom: "also" }], [{ questionIndex: 1, selected: [], custom: " " }],
      [{ questionIndex: 1, selected: ["A"], explanation: "forged" }],
      [{ questionIndex: 1, selected: ["A"] }, { questionIndex: 1, selected: ["B"] }],
    ].map(answers => response(answers))]) {
    assert.throws(() => decodeResponse(text, params), /Invalid questionnaire response/);
  }
});

test("editor transports a reserved envelope, validates against snapshot, and cancels explicitly", async () => {
  const input = snapshot(params);
  const result = await runRpcQuestionnaire(host(async (title, prefill) => {
    assert.equal(title, RPC_TITLE);
    assert.deepEqual(JSON.parse(prefill!).questions, params.questions);
    input.questions[0].options[0].label = "Mutated";
    return response();
  }), input);
  assert.equal(result.answers[0].selected[0], "A");
  assert.deepEqual(await runRpcQuestionnaire(host(async () => undefined), params), { cancelled: true, answers: [] });
  await assert.rejects(runRpcQuestionnaire(host(async () => "bad"), params), /expected JSON/);
});

test("abort, timeout and transport errors settle once and remove listeners", async () => {
  for (const reason of ["abort", "timeout", "reject", "throw"] as const) {
    const controller = new AbortController();
    let reply!: (value: string) => void;
    const ctx = host(() => {
      if (reason === "throw") throw new Error("transport");
      if (reason === "reject") return Promise.reject(new Error("transport"));
      return new Promise(resolve => { reply = resolve; });
    });
    const pending = runRpcQuestionnaire(ctx, params, controller.signal, 5);
    if (reason === "abort") controller.abort();
    await assert.rejects(pending, /aborted|timed out|transport/);
    reply?.(response());
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  }
  await assert.rejects(runRpcQuestionnaire(host(async () => { assert.fail("must not open"); }), params, AbortSignal.abort()));
  const controller = new AbortController();
  const pending = runRpcQuestionnaire(host(async () => response()), params, controller.signal);
  assert.equal((await pending).cancelled, false);
  controller.abort();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
