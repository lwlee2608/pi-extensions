import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Bridge, listenSocket } from "../src/bridge.ts";
import { decoder, encode, relay } from "../src/host.js";

const root = await mkdtemp(join(tmpdir(), "pi-browser-host-"));
const bridges: Bridge[] = [];
test.after(async () => { for (const bridge of bridges) bridge.close(); await rm(root, { recursive: true, force: true }); });

function session(path: string): Bridge {
  const bridge = new Bridge({ transport: handlers => listenSocket(path, handlers), connectTimeout: 2_000, callTimeout: 2_000 });
  bridges.push(bridge);
  return bridge;
}

function chrome(dir: string) {
  const input = new PassThrough();
  const output = new PassThrough();
  const events: string[] = [];
  const waiters = new Set<() => void>();
  output.on("data", decoder(({ id, method, event }: { id: number; method: string; event?: string }) => {
    if (event) events.push(event);
    else if (method !== "never") input.write(encode(method === "fail" ? { id, error: "boom" } : { id, result: method }));
    for (const wake of waiters) wake();
  }));
  const until = (count: number) => new Promise<void>(resolve => {
    const check = () => { if (events.length >= count) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });
  return { input, events, until, start: () => relay(dir, input, output) };
}

test("frames survive any chunking, and a bad frame is skipped", () => {
  const messages = [{ id: 1, method: "read" }, { text: "é".repeat(5_000) }, { id: 2, result: null }];
  const bad = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.from("{x}")]);
  const bytes = Buffer.concat([encode(messages[0]), bad, encode(messages[1]), encode(messages[2])]);
  for (const size of [1, 7, bytes.length]) {
    const received: unknown[] = [];
    const receive = decoder((message: unknown) => received.push(message));
    for (let at = 0; at < bytes.length; at += size) receive(bytes.subarray(at, at + size));
    assert.deepEqual(received, messages);
  }
  assert.deepEqual([...encode({ a: 1 }).subarray(0, 4)], [7, 0, 0, 0]);
});

test("the host skips a socket that refuses, finds a session that starts later, and relays calls both ways", async () => {
  const dir = join(root, "later");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "stale.sock"), "");
  await writeFile(join(dir, "notes.txt"), "");
  const browser = chrome(dir);
  await browser.start();
  const bridge = session(join(dir, "live.sock"));
  assert.equal(await bridge.call("echo", {}), "echo");
  await assert.rejects(bridge.call("fail", {}), /boom/);
  assert.deepEqual(browser.events, ["connected"]);
  browser.input.end();
});

test("the host tells Chrome when its session goes away and links the next one", async () => {
  const dir = join(root, "next");
  const first = session(join(dir, "a.sock"));
  const second = session(join(dir, "b.sock"));
  await first.listen();
  await second.listen();
  const browser = chrome(dir);
  await browser.start();
  await browser.until(1);
  const [linked, other] = first.connected ? [first, second] : [second, first];
  linked.close();
  await browser.until(3);
  assert.deepEqual(browser.events, ["connected", "disconnected", "connected"]);
  assert.equal(await other.call("echo", {}), "echo");
  browser.input.end();
});

test("Chrome closing the host's input drops the session link", async () => {
  const dir = join(root, "end");
  const bridge = session(join(dir, "a.sock"));
  await bridge.listen();
  const browser = chrome(dir);
  await browser.start();
  await browser.until(1);
  const pending = bridge.call("never", {});
  browser.input.end();
  await assert.rejects(pending, /disconnected/);
  assert.equal(bridge.connected, false);
  assert.deepEqual(browser.events, ["connected"]);
});
