import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Bridge, listenSocket, MAX_SOCKET_PATH, type BridgeOptions } from "../src/bridge.ts";
import { decoder, encode, PROTOCOL } from "../src/host.js";

const dir = await mkdtemp(join(tmpdir(), "pi-browser-test-"));
const bridges: Bridge[] = [];
let count = 0;
test.after(async () => { for (const bridge of bridges) bridge.close(); await rm(dir, { recursive: true, force: true }); });

function bridge(options: Partial<BridgeOptions> = {}): { server: Bridge; path: string } {
  const path = join(dir, "sessions", `${++count}.sock`);
  const server = new Bridge({ transport: handlers => listenSocket(path, handlers), connectTimeout: 1_000, callTimeout: 1_000, ...options });
  bridges.push(server);
  return { server, path };
}

type Call = { id: number; method: string; params: object; name: string };

async function host(path: string, answer = (socket: Socket, { id, method, params }: Call) => {
  socket.write(encode(method === "fail" ? { id, error: "boom" } : { id, result: { method, params } }));
}, versions: object = { version: PROTOCOL, host: PROTOCOL }): Promise<Socket> {
  const socket = connect(path);
  socket.on("data", decoder((call: Call) => {
    if (call.method === "hello") socket.write(encode({ id: call.id, result: versions }));
    else answer(socket, call);
  }));
  await once(socket, "connect");
  return socket;
}

test("a call waits for Chrome, round-trips results and errors", async () => {
  const { server, path } = bridge();
  const call = server.call("echo", { a: 1 });
  await server.listen();
  await host(path);
  assert.deepEqual(await call, { method: "echo", params: { a: 1 } });
  await assert.rejects(server.call("fail", {}), /boom/);
});

test("each call carries the session's current name", async () => {
  let name = "first";
  const { server, path } = bridge({ name: () => name });
  await server.listen();
  const names: string[] = [];
  await host(path, (socket, { id, name }) => { names.push(name); socket.write(encode({ id, result: null })); });
  await server.call("echo", {});
  name = "renamed";
  await server.call("echo", {});
  assert.deepEqual(names, ["first", "renamed"]);
});

test("a stop event from Chrome reaches onStop once the handshake is done", async () => {
  let stops = 0;
  const { server, path } = bridge({ onStop: () => stops++ });
  await server.listen();
  const socket = await host(path);
  await server.call("echo", {});
  socket.write(encode({ event: "stop" }));
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
  assert.equal(stops, 1);
});

test("a host that fails the version handshake fails every call and reports the mismatch until it disconnects", async () => {
  const path = join(dir, "sessions", `${++count}.sock`);
  let closed!: () => void;
  const gone = new Promise<void>(resolve => { closed = resolve; });
  const server = new Bridge({ transport: handlers => listenSocket(path, { ...handlers, close: peer => { handlers.close(peer); closed(); } }), callTimeout: 1_000 });
  bridges.push(server);
  const reload = /Pi Browser protocol versions do not match \(pi 1, extension 0, native host 1\)\. Reload the Pi Browser extension in chrome:\/\/extensions/;
  const waiting = assert.rejects(server.call("echo", {}), reload);
  await server.listen();
  const old = await host(path, undefined, { version: 0, host: PROTOCOL });
  await waiting;
  await assert.rejects(server.call("echo", {}), reload);
  assert.match(server.mismatch!.message, reload);
  assert.equal(server.connected, false);
  old.destroy();
  await gone;
  await host(path);
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
  assert.equal(server.mismatch, undefined);
});

test("an extension from before the handshake, which answers hello as an unknown action, is told to reload", async () => {
  const { server, path } = bridge();
  await server.listen();
  const socket = connect(path);
  socket.on("data", decoder(({ id, method }: Call) => socket.write(encode({ id, error: `Unknown browser action: ${method}` }))));
  await assert.rejects(server.call("status", {}), /extension none, native host none\)\. Reload the Pi Browser extension/);
});

test("a call fails when Chrome never connects", async () => {
  const { server } = bridge({ connectTimeout: 20 });
  await assert.rejects(server.call("echo", {}), /not connected\. Click the Pi Browser toolbar icon/);
});

test("a second host connection is refused while one is live", async () => {
  const { server, path } = bridge();
  await server.listen();
  await host(path);
  const second = await host(path);
  await once(second, "close");
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
});

test("a host disconnect fails pending calls", async () => {
  const { server, path } = bridge();
  await server.listen();
  await host(path, socket => socket.destroy());
  await assert.rejects(server.call("echo", {}), /disconnected/);
});

test("the socket replaces a stale one, is user-only in a user-only folder, and is removed on close", async () => {
  const { server, path } = bridge();
  await mkdir(join(dir, "sessions"), { recursive: true });
  await chmod(join(dir, "sessions"), 0o755);
  await writeFile(path, "stale");
  await server.listen();
  assert.ok((await stat(path)).isSocket());
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "sessions"))).mode & 0o777, 0o700);
  await host(path);
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
  assert.ok(server.connected);
  server.close();
  assert.equal(existsSync(path), false);
  await assert.rejects(new Promise((resolve, reject) => connect(path).once("connect", resolve).once("error", reject)), /ENOENT/);
});

test("a second pi with the same session fails clearly and leaves the live socket alone", async () => {
  const path = join(dir, "sessions", `${++count}.sock`);
  let probed!: () => void;
  const probe = new Promise<void>(resolve => { probed = resolve; });
  const server = new Bridge({ transport: handlers => listenSocket(path, { ...handlers, close: peer => { handlers.close(peer); probed(); } }), callTimeout: 1_000 });
  const twin = new Bridge({ transport: handlers => listenSocket(path, handlers) });
  bridges.push(server, twin);
  await server.listen();
  await assert.rejects(twin.listen(), /Another pi process with this session is using the browser socket .*\.sock/);
  await probe;
  await host(path);
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
});

test("a socket path at the OS limit listens, and one byte over fails naming the path", async () => {
  const at = (length: number) => join(dir, `${"s".repeat(length - dir.length - 6)}.sock`);
  const close = await listenSocket(at(MAX_SOCKET_PATH), { open: () => {}, message: () => {}, close: () => {} });
  close();
  const long = at(MAX_SOCKET_PATH + 1);
  await assert.rejects(listenSocket(long, { open: () => {}, message: () => {}, close: () => {} }),
    { message: `The browser socket path is ${MAX_SOCKET_PATH + 1} bytes, over the ${MAX_SOCKET_PATH}-byte limit on this OS: ${long}` });
});

test("a bridge closed while it starts does not keep listening", async () => {
  const { server, path } = bridge();
  const listening = server.listen();
  server.close();
  await assert.rejects(listening, /closed/);
  assert.equal(existsSync(path), false);
});
