import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Bridge, listenSocket, type BridgeOptions } from "../src/bridge.ts";
import { decoder, encode } from "../src/host.js";

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

async function host(path: string): Promise<Socket> {
  const socket = connect(path);
  socket.on("data", decoder(({ id, method, params }: { id: number; method: string; params: object }) => {
    socket.write(encode(method === "fail" ? { id, error: "boom" } : { id, result: { method, params } }));
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

test("a stop event from Chrome reaches onStop", async () => {
  let stops = 0;
  const { server, path } = bridge({ onStop: () => stops++ });
  await server.listen();
  const socket = await host(path);
  socket.write(encode({ event: "stop" }));
  assert.deepEqual(await server.call("echo", {}), { method: "echo", params: {} });
  assert.equal(stops, 1);
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
  const socket = connect(path);
  socket.on("data", () => socket.destroy());
  await once(socket, "connect");
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
  assert.ok(server.connected);
  server.close();
  assert.equal(existsSync(path), false);
  await assert.rejects(new Promise((resolve, reject) => connect(path).once("connect", resolve).once("error", reject)), /ENOENT/);
});

test("a bridge closed while it starts does not keep listening", async () => {
  const { server, path } = bridge();
  const listening = server.listen();
  server.close();
  await assert.rejects(listening, /closed/);
  assert.equal(existsSync(path), false);
});
