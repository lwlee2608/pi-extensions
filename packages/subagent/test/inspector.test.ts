import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { Inspector, transcriptTail } from "../src/inspector.ts";
import { resultText } from "../src/result.ts";
import { fixture, changedUntil } from "./helpers.ts";

const theme = { fg: (_color: unknown, text: string) => text };
test("tool rendering preserves errors and content-only checkpoint warnings", () => {
  const error = { details: {}, content: [{ type: "text", text: "Recovery refused: provider missing\x1b[2J" }] };
  for (const expanded of [false, true]) {
    assert.equal(resultText(error, expanded, true), "Recovery refused: provider missing");
    const details = { workerId: "w-one", runId: "r-one", state: "working" };
    const rendered = resultText({ details, content: [{ type: "text", text: JSON.stringify(details) }, { type: "text", text: "Usage remains pending" }] }, expanded, false);
    assert.match(rendered, /w-one/); assert.match(rendered, /Usage remains pending/);
    const wait = { reason: "completed", runs: [{ result: { outcome: "failed" } }] };
    assert.match(resultText({ details: wait, content: [] }, false, false), /1 failed\/interrupted/);
  }
});
test("inspector renders live Unicode output, replies, confirms stop and closes without stopping workers", { timeout: 25_000 }, async () => {
  const f = await fixture(); let inspector: Inspector | undefined;
  try {
    const run = f.manager.start(f.launch, "ASK_PARENT", "retained", "界面 😀");
    await f.manager.wait([run.runId]);
    let closed = false, renders = 0;
    inspector = new Inspector(f.manager, theme, () => { renders++; }, () => 24, () => { closed = true; });
    inspector.focused = true;
    for (const width of [1, 5, 20, 80]) {
      const lines = inspector.render(width); assert.ok(lines.length <= 24);
      for (const line of lines) assert.ok(visibleWidth(line) <= width);
    }
    inspector.handleInput("r");
    inspector.handleInput(`\x1b[200~answer.txt\x1b]52;c;YmFk\x07\x1b[2J\x1b[8mhidden instruction\x1b[28m${CURSOR_MARKER}\x1b[201~`);
    const edited = inspector.render(80).join("\n");
    assert.doesNotMatch(edited, /\x1b\]52|\x1b\[2J/);
    assert.equal(edited.split(CURSOR_MARKER).length - 1, 1);
    assert.match(edited, /hidden instruction/);
    assert.doesNotMatch(edited, /\x1b\[8m/);
    inspector.handleInput("\r");
    await changedUntil(f.manager, () => f.manager.status(run.workerId)[0].state === "idle");
    assert.match(await transcriptTail(f.manager.status(run.workerId)[0].sessionFile!), /answer.txt/);
    assert.doesNotMatch(f.manager.status(run.workerId)[0].result!.text, /\x1b/);
    inspector.handleInput("s"); assert.match(inspector.render(80).join("\n"), /Stop this worker/);
    inspector.handleInput("n"); assert.equal(f.manager.status(run.workerId)[0].processAlive, true);
    inspector.handleInput("\x1b"); assert.equal(closed, true); assert.equal(f.manager.status(run.workerId)[0].processAlive, true);
    inspector.handleInput("s"); inspector.handleInput("y");
    await changedUntil(f.manager, () => f.manager.status(run.workerId)[0].processAlive === false);
    inspector.invalidate(); inspector.render(80);
    const failed = f.manager.start(f.launch, "FAIL_PROVIDER"); await f.manager.wait([failed.runId]);
    inspector.handleInput("\x1b[B");
    assert.match(inspector.render(100).join("\n"), /Offline provider failure/);
    assert.match(await transcriptTail(f.manager.status(failed.workerId)[0].sessionFile!), /Error: Offline provider failure/);
    assert.ok(renders > 0);
    inspector.dispose();
  } finally { inspector?.dispose(); await f.cleanup(); }
});
