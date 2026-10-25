import { chmod, mkdir, rm, utimes } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import { decoder, encode, PROTOCOL } from "./host.js";

export interface Message {
  id?: number;
  result?: unknown;
  error?: string;
  event?: string;
}

export interface Peer {
  send(message: object): void;
  close(): void;
}

export interface Handlers {
  open(peer: Peer): void;
  message(peer: Peer, message: Message): void;
  close(peer: Peer): void;
}

export type Transport = (handlers: Handlers) => Promise<() => void>;

export interface BridgeOptions {
  transport: Transport;
  name?: () => string;
  connectTimeout?: number;
  callTimeout?: number;
  onStop?: () => void;
}

interface Pending {
  peer: Peer;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export const MAX_SOCKET_PATH = process.platform === "darwin" ? 104 : 108;

function answers(path: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(path, () => { socket.destroy(); resolve(true); }).once("error", () => resolve(false));
  });
}

export async function listenSocket(path: string, handlers: Handlers): Promise<() => void> {
  const length = Buffer.byteLength(path);
  if (length > MAX_SOCKET_PATH) throw new Error(`The browser socket path is ${length} bytes, over the ${MAX_SOCKET_PATH}-byte limit on this OS: ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  if (await answers(path)) throw new Error(`Another pi process with this session is using the browser socket ${path}.`);
  await rm(path, { force: true });
  let live: Socket | undefined;
  const server = createServer(socket => {
    socket.on("error", () => {});
    if (live) { socket.destroy(); return; }
    live = socket;
    const peer = { send: (message: object) => void socket.write(encode(message)), close: () => socket.destroy() };
    socket.on("data", decoder((message: Message) => handlers.message(peer, message)));
    socket.on("close", () => {
      live = undefined;
      handlers.close(peer);
      // Touching the socket wakes the dir watch of any host this one refused, so it takes over.
      const now = new Date();
      utimes(path, now, now).catch(() => {});
    });
    handlers.open(peer);
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));
  await chmod(path, 0o600);
  return () => server.close();
}

export class Bridge {
  private readonly options: BridgeOptions;
  private starting?: Promise<void>;
  private stop?: () => void;
  private peer?: Peer;
  private state?: "joining" | "ready" | Error;
  private readonly waiters = new Set<(error?: Error) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(options: BridgeOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.state === "ready";
  }

  get mismatch(): Error | undefined {
    return this.state instanceof Error ? this.state : undefined;
  }

  async listen(): Promise<void> {
    const starting = this.starting ??= this.options.transport({
      open: peer => this.attach(peer),
      message: (peer, message) => this.receive(peer, message),
      close: peer => this.detach(peer),
    }).then(stop => {
      if (this.starting !== starting) { stop(); throw new Error("Browser bridge is closed."); }
      this.stop = stop;
    }, error => {
      if (this.starting === starting) this.starting = undefined;
      throw error;
    });
    await starting;
  }

  async call(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    await this.listen();
    if (this.state instanceof Error) throw this.state;
    const peer = this.state === "ready" ? this.peer! : await this.waitForPeer(signal);
    return this.request(peer, method, params, signal);
  }

  close(reason = "Browser bridge is closed."): void {
    this.stop?.();
    this.stop = undefined;
    this.starting = undefined;
    for (const wake of this.waiters) wake(new Error(reason));
    for (const call of this.pending.values()) call.reject(new Error(reason));
    this.peer?.close();
    this.peer = undefined;
    this.state = undefined;
  }

  private request(peer: Peer, method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = ++this.nextId;
    const timeout = this.options.callTimeout ?? 30_000;
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); };
      const abort = () => { finish(); reject(new Error("Aborted.")); };
      const timer = setTimeout(() => { finish(); reject(new Error(`Chrome did not answer ${method} within ${timeout / 1000}s.`)); }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        peer,
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      });
      peer.send({ id, method, params, name: this.options.name?.() });
    });
  }

  private attach(peer: Peer): void {
    if (this.peer) { peer.close(); return; }
    this.peer = peer;
    this.state = "joining";
    const join = (reply: unknown) => {
      if (this.peer !== peer) return;
      if (reply instanceof Error && !reply.message.startsWith("Unknown browser action")) { peer.close(); return; }
      const { version, host } = (reply ?? {}) as { version?: number; host?: number };
      this.state = version === PROTOCOL && host === PROTOCOL ? "ready" : new Error(`Pi Browser protocol versions do not match (pi ${PROTOCOL}, extension ${version ?? "none"}, native host ${host ?? "none"}). `
        + "Reload the Pi Browser extension in chrome://extensions, and restart pi if it started before the update.");
      for (const wake of this.waiters) wake(this.mismatch);
    };
    this.request(peer, "hello", {}).then(join, join);
  }

  private detach(peer: Peer): void {
    for (const call of this.pending.values()) if (call.peer === peer) call.reject(new Error("Chrome extension disconnected."));
    if (this.peer !== peer) return;
    this.peer = undefined;
    this.state = undefined;
  }

  private receive(peer: Peer, message: Message): void {
    if (message.event === "stop") { if (peer === this.peer && this.connected) this.options.onStop?.(); return; }
    const call = message.id === undefined ? undefined : this.pending.get(message.id);
    if (call?.peer !== peer) return;
    if (message.error === undefined) call.resolve(message.result);
    else call.reject(new Error(message.error));
  }

  private waitForPeer(signal?: AbortSignal): Promise<Peer> {
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(this.peer!);
      };
      const abort = () => done(new Error("Aborted."));
      const timer = setTimeout(
        () => done(new Error("Chrome extension is not connected. Click the Pi Browser toolbar icon in Chrome to reconnect. If it is not installed, run /browser for the extension folder and load it unpacked in chrome://extensions.")),
        this.options.connectTimeout ?? 35_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.add(done);
    });
  }
}
