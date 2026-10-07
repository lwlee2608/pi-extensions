import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Inspector, transcriptTail } from "../src/inspector.ts";
import { fixture, changedUntil } from "./helpers.ts";

const theme = { fg: (_color: unknown, text: string) => text };
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
    inspector.handleInput("r"); inspector.handleInput("answer.txt"); inspector.render(80); inspector.handleInput("\r");
    await changedUntil(f.manager, () => f.manager.status(run.workerId)[0].state === "idle");
    assert.match(await transcriptTail(f.manager.status(run.workerId)[0].sessionFile!), /answer.txt/);
    inspector.handleInput("s"); assert.match(inspector.render(80).join("\n"), /Stop this worker/);
    inspector.handleInput("n"); assert.equal(f.manager.status(run.workerId)[0].processAlive, true);
    inspector.handleInput("\x1b"); assert.equal(closed, true); assert.equal(f.manager.status(run.workerId)[0].processAlive, true);
    inspector.handleInput("s"); inspector.handleInput("y");
    await changedUntil(f.manager, () => f.manager.status(run.workerId)[0].processAlive === false);
    inspector.invalidate(); inspector.render(80);
    assert.ok(renders > 0);
    inspector.dispose();
  } finally { inspector?.dispose(); await f.cleanup(); }
});
