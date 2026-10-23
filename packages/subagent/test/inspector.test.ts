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
test("inspector lists nested workers under their group and shows the selected transcript", { timeout: 25_000 }, async () => {
  const f = await fixture(); let inspector: Inspector | undefined;
  try {
    const root = f.manager.start(f.launch, "ROOT_TASK", "retained", "owctl phase 1");
    await f.manager.wait([root.runId]);
    const child = f.manager.start(f.launch, "REVIEW_TASK", "once", "owctl review 1", root.workerId);
    await f.manager.wait([child.runId]);
    const second = f.manager.start(f.launch, "REVIEW_TASK", "once", "owctl review 1", root.workerId);
    await f.manager.wait([second.runId]);
    inspector = new Inspector(f.manager, theme, () => {}, () => 24, () => {});
    const list = inspector.render(100);
    assert.match(list[1], /^  ✓ owctl phase 1 +│ owctl phase 1 · fixture · idle · /);
    assert.match(list[2], /^▸   ✓ fixture +\d+s │ ─+$/);
    assert.match(list[3], /^    ✓ owctl review 1 #1 +\d+s │ /);
    assert.match(list[4], /^    ✓ owctl review 1 #2 +\d+s │ /);
    inspector.handleInput("\x1b[B"); inspector.handleInput("i");
    while (!/REVIEW_TASK/.test(inspector.render(100).join("\n"))) await new Promise(resolve => setTimeout(resolve, 20));
    const selected = inspector.render(100).join("\n");
    assert.match(selected, /\n▸   ✓ owctl review 1 #1 /);
    assert.match(selected, /owctl review 1 #1 · fixture · closed /); assert.ok(selected.includes(child.workerId) && selected.includes(child.runId));
    assert.match(selected, /│ Task +\n.*│   REVIEW_TASK/);
    for (const width of [1, 5, 20, 59, 60, 80]) for (const line of inspector.render(width)) assert.ok(visibleWidth(line) <= width);
  } finally { inspector?.dispose(); await f.cleanup(); }
});
