import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { Bridge, loadSecret, type BridgeOptions } from "../src/bridge.ts";

const origin = "chrome-extension://enidoebkpjligpdgedlellobooiiljib";
const dir = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
const bridges: Bridge[] = [];
test.after(async () => { for (const bridge of bridges) bridge.close(); await rm(dir, { recursive: true, force: true }); });

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  server.close();
  return port;
}

function bridge(port: number, options: Partial<BridgeOptions> = {}): Bridge {
  const bridge = new Bridge({ port, origin, secretPath: join(dir, "secret"), connectTimeout: 1_000, callTimeout: 1_000, ...options });
  bridges.push(bridge);
  return bridge;
}

async function chrome(port: number, from = origin): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: from });
  socket.on("message", data => {
    const { id, method, params } = JSON.parse(data.toString());
    socket.send(JSON.stringify(method === "fail" ? { id, error: "boom" } : { id, result: { method, params } }));
  });
  await once(socket, "open");
  return socket;
}

test("a call waits for Chrome, round-trips results and errors", async () => {
  const port = await freePort();
  const server = bridge(port);
  const call = server.call("echo", { a: 1 });
  await server.listen();
  await chrome(port);
  assert.deepEqual(await call, { method: "echo", params: { a: 1 } });
  await assert.rejects(server.call("fail", {}), /boom/);
});

test("a call fails when Chrome never connects", async () => {
  const server = bridge(await freePort(), { connectTimeout: 20 });
  await assert.rejects(server.call("echo", {}), /not connected/);
});

test("a foreign origin is rejected", async () => {
  const port = await freePort();
  await bridge(port).listen();
  for (const from of ["https://evil.example", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin: from });
    const [, response] = await once(socket, "unexpected-response");
    assert.equal(response.statusCode, 401);
  }
});

test("a second Chrome connection is refused while one is live", async () => {
  const port = await freePort();
  const server = bridge(port);
  await server.listen();
  await chrome(port);
  const second = await chrome(port);
  const [code, reason] = await once(second, "close");
  assert.equal(code, 4409);
  assert.match(reason.toString(), /already connected/);
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
});

test("a Chrome disconnect fails pending calls", async () => {
  const port = await freePort();
  const server = bridge(port);
  await server.listen();
  const socket = new WebSocket(`ws://127.0.0.1:${port}`, { origin });
  socket.on("message", () => socket.close());
  await once(socket, "open");
  await assert.rejects(server.call("echo", {}), /disconnected/);
});

test("a taken port reports in use and names /browser take", async () => {
  const port = await freePort();
  const holder = createServer().listen(port, "127.0.0.1");
  await once(holder, "listening");
  try { await assert.rejects(bridge(port).call("echo", {}), /in use.*\/browser take/); }
  finally { holder.close(); }
});

test("take without the secret is refused and the owner keeps the browser", async () => {
  const port = await freePort();
  const owner = bridge(port);
  await owner.listen();
  await chrome(port);
  const response = await fetch(`http://127.0.0.1:${port}/release`, { method: "POST", headers: { authorization: "Bearer wrong" } });
  assert.equal(response.status, 403);
  await assert.rejects(bridge(port, { secretPath: join(dir, "other-secret") }).take(), /refused the take \(HTTP 403\)/);
  assert.ok(owner.listening);
  assert.deepEqual(await owner.call("echo", {}), { method: "echo", params: {} });
});

test("take with the secret frees the port for the taker", async () => {
  const port = await freePort();
  let released = false;
  const owner = bridge(port, { label: () => "first session", onRelease: () => { released = true; } });
  await owner.listen();
  const first = await chrome(port);
  const taker = bridge(port);
  assert.deepEqual(await taker.owner(), { label: "first session", connected: true });
  first.removeAllListeners("message");
  const pending = assert.rejects(owner.call("never", {}), /took the browser/);
  assert.equal(await taker.take(), true);
  await pending;
  assert.ok(released && !owner.listening && taker.listening);
  await once(first, "close");
  await chrome(port);
  assert.deepEqual(await taker.call("echo", {}), { method: "echo", params: {} });
  await assert.rejects(owner.call("echo", {}), /in use/);
  assert.equal(await taker.take(), false);
});

test("the secret is created once, user-only", async () => {
  const path = join(dir, "nested", "secret");
  const [a, b] = await Promise.all([loadSecret(path), loadSecret(path)]);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
