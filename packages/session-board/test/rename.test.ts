import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeName, renameSession, serveRenames } from "../src/rename.ts";
import { Registration } from "../src/registry.ts";
import { Board } from "../src/board.ts";

test("rename reaches only the live owner and validates names and session identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "rename-"));
  const id = randomUUID();
  let name = "original";
  const close = await serveRenames(root, id, "session-a", value => { name = value; });
  try {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    await renameSession(root, id, "session-a", "  中文 task  ");
    assert.equal(name, "中文 task");
    await assert.rejects(renameSession(root, id, "session-b", "wrong session"));
    assert.equal(name, "中文 task");
    for (const invalid of ["", "  ", "a\nsecret", "x".repeat(129)]) assert.throws(() => normalizeName(invalid));
    await close();
    await assert.rejects(renameSession(root, id, "session-a", "too late"));
  } finally { await close(); await rm(root, { recursive: true, force: true }); }
});

test("arrows select rows, rename stays targeted during editing and Esc cancels", async () => {
  const root = await mkdtemp(join(tmpdir(), "rename-ui-"));
  let board: Board | undefined;
  let renamed = "";
  const first = new Registration(root, () => Date.now() - 1000);
  const second = new Registration(root);
  const close = await serveRenames(root, second.id, "b", value => { renamed = value; });
  try {
    await first.publish({ sessionId: "a", name: "Alpha", cwd: "/a", status: "idle", statusSince: Date.now() });
    await second.publish({ sessionId: "b", name: "Beta", cwd: "/b", status: "idle", statusSince: Date.now() });
    let rendered!: () => void;
    const ready = new Promise<void>(resolve => { rendered = resolve; });
    board = new Board(root, first.id, { fg: (_color, text) => text }, () => rendered(), () => 24, () => {});
    await ready;
    assert.match(board.render(80).find(line => line.includes("\x1b[7m"))!, /Alpha/);
    board.handleInput("\x1b[B");
    assert.match(board.render(80).find(line => line.includes("\x1b[7m"))!, /Beta/);
    board.handleInput("r");
    assert.match(board.render(80).join("\n"), /Name:.*Beta/);
    board.handleInput("\x1b");
    assert.equal(renamed, "");
    board.handleInput("\x1b[114u");
    assert.match(board.render(80).join("\n"), /Name:.*Beta/);
    board.handleInput("\x15"); board.handleInput("Renamed"); board.handleInput("\r");
    for (let i = 0; i < 100 && !renamed; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(renamed, "Renamed");
  } finally { board?.dispose(); await close(); await rm(root, { recursive: true, force: true }); }
});
