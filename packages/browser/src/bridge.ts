import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname } from "node:path";
import { decoder, encode } from "./host.js";

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
  connectTimeout?: number;
  callTimeout?: number;
  onStop?: () => void;
}

interface Pending {
  peer: Peer;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export async function listenSocket(path: string, handlers: Handlers): Promise<() => void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  await rm(path, { force: true });
  const server = createServer(socket => {
    const peer = { send: (message: object) => void socket.write(encode(message)), close: () => socket.destroy() };
    socket.on("error", () => {});
    socket.on("data", decoder((message: Message) => handlers.message(peer, message)));
    socket.on("close", () => handlers.close(peer));
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
  private readonly waiters = new Set<(error?: Error) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(options: BridgeOptions) {
    this.options = options;
  }

  get connected(): boolean {
    return this.peer !== undefined;
  }

  async listen(): Promise<void> {
    const starting = this.starting ??= this.options.transport({
      open: peer => this.attach(peer),
      message: (peer, message) => { if (peer === this.peer) this.receive(message); },
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
    const peer = this.peer ?? await this.waitForPeer(signal);
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
      peer.send({ id, method, params });
    });
  }

  close(reason = "Browser bridge is closed."): void {
    this.stop?.();
    this.stop = undefined;
    this.starting = undefined;
    for (const wake of this.waiters) wake(new Error(reason));
    for (const call of this.pending.values()) call.reject(new Error(reason));
    this.peer?.close();
    this.peer = undefined;
  }

  private attach(peer: Peer): void {
    if (this.peer) { peer.close(); return; }
    this.peer = peer;
    for (const wake of this.waiters) wake();
  }

  private detach(peer: Peer): void {
    for (const call of this.pending.values()) if (call.peer === peer) call.reject(new Error("Chrome extension disconnected."));
    if (this.peer === peer) this.peer = undefined;
  }

  private receive(message: Message): void {
    if (message.event === "stop") { this.options.onStop?.(); return; }
    const call = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!call) return;
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
        () => done(new Error("Chrome extension is not connected. Run /browser for the extension folder, load it unpacked in chrome://extensions, and keep Chrome open.")),
        this.options.connectTimeout ?? 35_000,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.add(done);
    });
  }
}
