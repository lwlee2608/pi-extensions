import { createServer, createConnection, type Socket } from "node:net";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { safeText } from "./state.ts";

function socketPath(root: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid session registration");
  const path = join(root, `${id}.sock`);
  if (Buffer.byteLength(path) > 103) throw new Error("Agent directory path too long for renaming");
  return path;
}

export function normalizeName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 128 || safeText(name) !== name) throw new Error("Use 1–128 characters without control characters");
  return name;
}

function receive(socket: Socket, callback: (value: unknown) => void): void {
  let data = "";
  let complete = false;
  socket.setEncoding("utf8");
  socket.setTimeout(3000, () => socket.destroy(new Error("Rename timed out; check the target session")));
  socket.on("data", chunk => {
    if (complete) return;
    data += chunk;
    if (Buffer.byteLength(data) > 4096) { socket.destroy(new Error("Rename message too large")); return; }
    if (!data.includes("\n")) return;
    complete = true;
    try { callback(JSON.parse(data.slice(0, data.indexOf("\n")))); }
    catch { socket.destroy(new Error("Invalid rename message")); }
  });
}

export async function serveRenames(root: string, id: string, sessionId: string, apply: (name: string) => void): Promise<() => Promise<void>> {
  const path = socketPath(root, id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  if (!(await lstat(root)).isDirectory()) throw new Error("Invalid registry directory");
  await chmod(root, 0o700);
  let closed = false;
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    receive(socket, value => {
      const request = value as { sessionId?: unknown; name?: unknown; expiresAt?: unknown } | null;
      try {
        if (closed || request?.sessionId !== sessionId || typeof request.name !== "string"
          || typeof request.expiresAt !== "number" || request.expiresAt < Date.now() || request.expiresAt > Date.now() + 5000) throw new Error("Session changed or request expired");
        apply(normalizeName(request.name));
        socket.end(JSON.stringify({ ok: true }) + "\n");
      } catch { socket.end(JSON.stringify({ ok: false }) + "\n"); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.removeListener("error", reject); resolve(); });
  });
  server.on("error", () => {});
  try { await chmod(path, 0o600); }
  catch (error) {
    server.close();
    await unlink(path).catch(() => {});
    throw error;
  }
  return async () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await unlink(path).catch(error => { if (error.code !== "ENOENT") throw error; });
  };
}

export async function renameSession(root: string, id: string, sessionId: string, value: string): Promise<void> {
  const name = normalizeName(value);
  const path = socketPath(root, id);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(path);
    let acknowledged = false;
    socket.on("error", () => reject(new Error("Rename unavailable; reload the target session and try again")));
    socket.on("close", () => { if (!acknowledged) reject(new Error("No rename confirmation; check the target session")); });
    socket.on("connect", () => socket.write(JSON.stringify({ sessionId, name, expiresAt: Date.now() + 3000 }) + "\n"));
    receive(socket, value => {
      acknowledged = true;
      socket.destroy();
      if ((value as { ok?: unknown } | null)?.ok === true) resolve();
      else reject(new Error("Session changed or rename was rejected"));
    });
  });
}
