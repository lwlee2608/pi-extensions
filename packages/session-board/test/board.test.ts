import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Registration } from "../src/registry.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Board, rowLine } from "../src/board.ts";
import { transition } from "../src/state.ts";
import type { Row } from "../src/registry.ts";

const row: Row = {
  version: 1, registrationId: "current", sessionId: "session", name: "Fix auth", cwd: "/api",
  status: "working", statusSince: 1000, heartbeatAt: 2000, startedAt: 1000,
};

test("rows show current identity, project, activity and status age", () => {
  const line = rowLine(row, "current", 121000, 80);
  assert.match(line, /^›  api\s+\/ Fix auth/);
  assert.match(line, /Generating\s+2m$/);
  assert.equal(visibleWidth(line), 80);
  assert.match(rowLine({ ...row, status: "unknown" }, undefined, 22000, 80), /seen 20s$/);
  assert.notEqual(rowLine({ ...row, name: "", registrationId: "prefix-12345678" }, undefined, 1000, 80),
    rowLine({ ...row, name: "", registrationId: "prefix-87654321" }, undefined, 1000, 80));
  for (const width of [32, 80]) {
    const long = { ...row, name: "", cwd: "/pi-session-board-integration-tests" };
    assert.match(rowLine({ ...long, registrationId: "prefix-12345678" }, undefined, 1000, width), /12345678/);
    assert.match(rowLine({ ...long, registrationId: "prefix-87654321" }, undefined, 1000, width), /87654321/);
  }
});

test("full-area surface fills every cell and scrolling reaches the last row", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-scroll-"));
  let board: Board | undefined;
  try {
    for (let i = 0; i < 30; i++) {
      await new Registration(root, () => Date.now() + i).publish({
        sessionId: String(i), name: `session-${i}`, cwd: `/project-${i}`,
        status: "idle", statusSince: Date.now(),
      });
    }
    let refreshed!: () => void;
    const ready = new Promise<void>(resolve => { refreshed = resolve; });
    board = new Board(root, undefined, { fg: (_color, text) => text }, refreshed, () => 24, () => {});
    await ready;
    board.render(80);
    for (let i = 0; i < 100; i++) board.handleInput("\x1b[B");
    const lines = board.render(80);
    assert.equal(lines.length, 24);
    assert.ok(lines.every(line => visibleWidth(line) === 80));
    assert.ok(lines.some(line => line.includes("project-29")));
    assert.match(lines.at(-1)!, /Esc return/);
  } finally { board?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("refresh preserves selected session when earlier rows change groups", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-anchor-"));
  let board: Board | undefined;
  try {
    const writers: Registration[] = [];
    for (let i = 0; i < 15; i++) {
      const writer = new Registration(root, () => Date.now() + i);
      writers.push(writer);
      await writer.publish({ sessionId: String(i), name: `session-${i}`, cwd: `/p${i}`, status: "idle", statusSince: Date.now() });
    }
    let refreshed!: () => void;
    let ready = new Promise<void>(resolve => { refreshed = resolve; });
    board = new Board(root, undefined, { fg: (_color, text) => text }, () => refreshed(), () => 15, () => {});
    await ready;
    board.render(80);
    for (let i = 0; i < 8; i++) board.handleInput("\x1b[B");
    const before = board.render(80).find(line => line.includes("\x1b[7m"))!;
    await writers[0].publish({ sessionId: "0", name: "session-0", cwd: "/p0", status: "working", statusSince: Date.now() });
    ready = new Promise<void>(resolve => { refreshed = resolve; });
    await ready;
    assert.equal(board.render(80).find(line => line.includes("\x1b[7m"))!.slice(0, 40), before.slice(0, 40));
  } finally { board?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("Unicode/control text fits narrow widths and themes are evaluated on each render", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-width-"));
  let board: Board | undefined;
  try {
    await new Registration(root).publish({ sessionId: "id", name: "中文 👩‍💻\x1b[2J", cwd: "/unicode", status: "idle", statusSince: Date.now() });
    let ready!: () => void;
    const refreshed = new Promise<void>(resolve => { ready = resolve; });
    let style = "one";
    board = new Board(root, undefined, { fg: (_color, text) => `${style}:${text}` }, ready, () => 24, () => {});
    await refreshed;
    for (const width of [1, 12, 40, 80]) {
      for (const line of board.render(width)) { assert.ok(visibleWidth(line) <= width); assert.ok(!line.includes("\x1b[2J")); }
    }
    assert.match(board.render(80)[0], /^ one:/);
    style = "two"; board.invalidate(); assert.match(board.render(80)[0], /^ two:/);
  } finally { board?.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("compact limitation marker precedes long metadata and unfocused board yields the screen", () => {
  const limited = rowLine({ ...row, cwd: "/very/long/checkout/".repeat(10), tools: ["bash", "read"], waitingUnavailable: true }, undefined, 1000, 80);
  assert.match(limited, /^·\?/);
  const board = new Board("/nonexistent-board-test", undefined, { fg: (_color, text) => text }, () => {}, () => 40, () => {}, () => false);
  try { assert.deepEqual(board.render(80), []); } finally { board.dispose(); }
});

test("heartbeats and repeated states do not reset elapsed time", () => {
  const state = { status: "idle" as const, statusSince: 1 };
  assert.equal(transition(state, "idle", 5), state);
  assert.deepEqual(transition(state, "working", 5), { status: "working", statusSince: 5 });
});

test("board consumes escape and disposes its refresh timer", () => {
  let closed = false;
  const board = new Board("/nonexistent-board-test", undefined, { fg: (_color, text) => text }, () => {}, () => 24, () => { closed = true; });
  try {
    assert.match(board.render(80).join("\n"), /Session Board/);
    board.handleInput("\x1b");
    assert.equal(closed, true);
  } finally { board.dispose(); }
});
