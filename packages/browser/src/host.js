import { watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL = 2;

export function encode(message) {
  const body = Buffer.from(JSON.stringify(message));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([head, body]);
}

export function decoder(receive) {
  let buffer = Buffer.alloc(0);
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const end = 4 + buffer.readUInt32LE(0);
      const body = buffer.subarray(4, end).toString();
      buffer = buffer.subarray(end);
      let message;
      try { message = JSON.parse(body); } catch { continue; }
      receive(message);
    }
  };
}

export async function relay(dir, input, output) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const links = new Map();
  const missed = new Set();
  let ended = false;
  const send = message => output.write(encode(message));

  const open = name => {
    const session = name.slice(0, -".sock".length);
    const path = join(dir, name);
    const socket = connect(path);
    let linked = false;
    links.set(session, socket);
    socket.on("error", error => console.error(`pi-browser host: ${path}: ${error.message}`));
    socket.on("data", decoder(message => {
      if (!linked) send({ session, event: "connected" });
      linked = true;
      send({ session, message });
    }));
    socket.once("close", () => {
      if (links.get(session) === socket) links.delete(session);
      if (linked && !ended) send({ session, event: "disconnected" });
      if (missed.delete(session) && !ended) scan();
    });
  };

  const scan = async changed => {
    for (const name of await readdir(dir).catch(() => [])) {
      const session = name.slice(0, -".sock".length);
      if (ended || !name.endsWith(".sock")) continue;
      if (!links.has(session)) open(name);
      else if (changed) missed.add(session);
    }
  };

  const watcher = watch(dir, () => scan(true));
  input.on("data", decoder(({ session, message }) => links.get(session)?.write(encode(message))));
  input.once("end", () => {
    ended = true;
    watcher.close();
    for (const socket of links.values()) socket.destroy();
  });
  send({ event: "hello", version: PROTOCOL });
  await scan();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) relay(process.argv[2], process.stdin, process.stdout);
