import { watch } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
  let link;
  let ended = false;
  let queue = Promise.resolve();
  const send = message => output.write(encode(message));

  const open = path => new Promise(resolve => {
    const socket = connect(path);
    socket.on("error", error => {
      console.error(`pi-browser host: ${path}: ${error.message}`);
      resolve(false);
    });
    socket.once("connect", () => {
      link = socket;
      send({ event: "connected" });
      socket.on("data", decoder(send));
      socket.once("close", () => {
        link = undefined;
        if (ended) return;
        send({ event: "disconnected" });
        scan(path);
      });
      resolve(true);
    });
  });

  const scan = skip => {
    queue = queue.then(async () => {
      for (const name of await readdir(dir).catch(() => [])) {
        if (link || ended) return;
        const path = join(dir, name);
        if (name.endsWith(".sock") && path !== skip) await open(path);
      }
    });
  };

  const watcher = watch(dir, () => scan());
  input.on("data", decoder(message => link?.write(encode(message))));
  input.once("end", () => {
    ended = true;
    watcher.close();
    link?.destroy();
  });
  scan();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) relay(process.argv[2], process.stdin, process.stdout);
