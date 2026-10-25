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
  const frames: { session: string; message: any }[] = [];
  const waiters = new Set<() => void>();
  output.on("data", decoder(({ session, event, message }: { session: string; event?: string; message: any }) => {
    if (event) events.push(`${event} ${session}`);
    else {
      frames.push({ session, message });
      if (message.method !== "never") input.write(encode({ session, message: message.method === "fail" ? { id: message.id, error: "boom" } : { id: message.id, result: `${session} ${message.method}` } }));
    }
    for (const wake of waiters) wake();
  }));
  const until = (count: number) => new Promise<void>(resolve => {
    const check = () => { if (events.length >= count) { waiters.delete(check); resolve(); } };
    waiters.add(check);
    check();
  });
  return { input, events, frames, until, start: () => relay(dir, input, output) };
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
  assert.equal(await bridge.call("echo", {}), "live echo");
  await assert.rejects(bridge.call("fail", {}), /boom/);
  assert.deepEqual(browser.events, ["connected live"]);
  browser.input.end();
});

test("the host relays several sessions at once, tagging each frame with the socket it came in on", async () => {
  const dir = join(root, "many");
  const a = session(join(dir, "a.sock"));
  const b = session(join(dir, "b.sock"));
  const forged = await listenSocket(join(dir, "c.sock"), { open: peer => peer.send({ session: "a", id: 1, method: "forged" }), message: () => {}, close: () => {} });
  await a.listen();
  await b.listen();
  const browser = chrome(dir);
  await browser.start();
  assert.deepEqual(await Promise.all([a.call("echo", {}), b.call("echo", {}), a.call("read", {})]), ["a echo", "b echo", "a read"]);
  await browser.until(3);
  assert.deepEqual(browser.frames.find(frame => frame.message.method === "forged"), { session: "c", message: { session: "a", id: 1, method: "forged" } });
  a.close();
  await browser.until(4);
  assert.equal(browser.events.at(-1), "disconnected a");
  assert.equal(await b.call("echo", {}), "b echo");
  forged();
  browser.input.end();
});

test("first claim wins: a second host is refused while one holds the session, and takes over once that one ends", async () => {
  const dir = join(root, "takeover");
  const bridge = session(join(dir, "a.sock"));
  await bridge.listen();
  const first = chrome(dir);
  await first.start();
  await first.until(1);
  const second = chrome(dir);
  await second.start();
  await second.until(2);
  assert.deepEqual(second.events, ["connected a", "disconnected a"]);
  assert.equal(await bridge.call("echo", {}), "a echo");
  assert.equal(second.frames.length, 0);
  const pending = assert.rejects(bridge.call("never", {}), /disconnected/);
  first.input.end();
  await pending;
  assert.equal(await bridge.call("echo", {}), "a echo");
  assert.equal(second.events.at(-1), "connected a");
  second.input.end();
});

test("Chrome closing the host's input drops every session link", async () => {
  const dir = join(root, "end");
  const a = session(join(dir, "a.sock"));
  const b = session(join(dir, "b.sock"));
  await a.listen();
  await b.listen();
  const browser = chrome(dir);
  await browser.start();
  await browser.until(2);
  const pending = Promise.all([a, b].map(bridge => assert.rejects(bridge.call("never", {}), /disconnected/)));
  browser.input.end();
  await pending;
  assert.equal(a.connected || b.connected, false);
  assert.deepEqual(browser.events.toSorted(), ["connected a", "connected b"]);
});
