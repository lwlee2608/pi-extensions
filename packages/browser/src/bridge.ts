import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export const PORT = 47823;
export const ORIGIN = "chrome-extension://enidoebkpjligpdgedlellobooiiljib";

export interface BridgeOptions {
  port: number;
  origin: string;
  connectTimeout?: number;
  callTimeout?: number;
  onChange?: (connected: boolean) => void;
}

interface Pending {
  socket: WebSocket;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class Bridge {
  private readonly options: BridgeOptions;
  private server?: Server;
  private starting?: Promise<void>;
  private socket?: WebSocket;
  private readonly waiters = new Set<(error?: Error) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;

  constructor(options: BridgeOptions) {
    this.options = options;
  }

  get listening(): boolean {
    return this.server !== undefined;
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  listen(): Promise<void> {
    const starting = this.starting ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.request(req, res));
      const wss = new WebSocketServer({ server, verifyClient: ({ origin }: { origin?: string }) => origin === this.options.origin });
      wss.on("connection", socket => this.attach(socket));
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (this.starting === starting) this.starting = undefined;
        server.close();
        reject(error.code === "EADDRINUSE"
          ? new Error(`The browser is in use by another pi session (or another program holds port ${this.options.port}). Run /browser take to move it here.`, { cause: error })
          : error);
      });
      server.once("listening", () => {
        if (this.starting !== starting) { server.close(); reject(new Error("Browser bridge is closed.")); return; }
        this.server = server;
        resolve();
      });
      server.listen(this.options.port, "127.0.0.1");
    });
    return starting;
  }

  async call(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    await this.listen();
    const socket = this.socket ?? await this.waitForSocket(signal);
    const id = ++this.nextId;
    const timeout = this.options.callTimeout ?? 30_000;
    return new Promise((resolve, reject) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); this.pending.delete(id); };
      const abort = () => { finish(); reject(new Error("Aborted.")); };
      const timer = setTimeout(() => { finish(); reject(new Error(`Chrome did not answer ${method} within ${timeout / 1000}s.`)); }, timeout);
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(id, {
        socket,
        resolve: value => { finish(); resolve(value); },
        reject: error => { finish(); reject(error); },
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(reason = "Browser bridge is closed."): void {
    this.starting = undefined;
    this.server?.close();
    this.server = undefined;
    for (const wake of this.waiters) wake(new Error(reason));
    for (const call of this.pending.values()) call.reject(new Error(reason));
    this.socket?.terminate();
  }

  private request(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(404).end();
  }

  private attach(socket: WebSocket): void {
    if (this.socket) { socket.close(4409, "Another Chrome is already connected to pi."); return; }
    this.socket = socket;
    this.options.onChange?.(true);
    for (const wake of this.waiters) wake();
    socket.on("error", () => {});
    socket.on("message", data => this.receive(data.toString()));
    socket.on("close", () => {
      for (const call of this.pending.values()) if (call.socket === socket) call.reject(new Error("Chrome extension disconnected."));
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.options.onChange?.(false);
    });
  }

  private receive(raw: string): void {
    let message: { id?: number; result?: unknown; error?: string };
    try { message = JSON.parse(raw); } catch { return; }
    const call = message.id === undefined ? undefined : this.pending.get(message.id);
    if (!call) return;
    if (message.error === undefined) call.resolve(message.result);
    else call.reject(new Error(message.error));
  }

  private waitForSocket(signal?: AbortSignal): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(this.socket!);
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
