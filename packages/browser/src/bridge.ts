import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";

export const PORT = 47823;
export const ORIGIN = "chrome-extension://enidoebkpjligpdgedlellobooiiljib";

export interface BridgeOptions {
  port: number;
  origin: string;
  secretPath: string;
  label?: () => string;
  connectTimeout?: number;
  callTimeout?: number;
  onRelease?: () => void;
}

export interface Owner {
  label: string;
  connected: boolean;
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
  private secret?: Promise<string>;

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
      const server = createServer((req, res) => void this.request(req, res).catch(() => res.destroy()));
      const wss = new WebSocketServer({ server, verifyClient: ({ origin }: { origin?: string }) => origin === this.options.origin });
      wss.on("connection", socket => this.attach(socket));
      wss.on("error", () => {});
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

  async take(): Promise<boolean> {
    if (this.server) return false;
    const response = await this.fetch("/release", "POST");
    if (response && !response.ok) throw new Error(`Port ${this.options.port} refused the take (HTTP ${response.status}). Is another program using it?`);
    await this.listen();
    return true;
  }

  async owner(): Promise<Owner | undefined> {
    const response = await this.fetch("/owner", "GET");
    return response?.ok ? await response.json() as Owner : undefined;
  }

  close(reason = "Browser bridge is closed."): void {
    this.starting = undefined;
    this.server?.close();
    this.server = undefined;
    for (const wake of this.waiters) wake(new Error(reason));
    for (const call of this.pending.values()) call.reject(new Error(reason));
    this.socket?.terminate();
  }

  private async fetch(path: string, method: string): Promise<Response | undefined> {
    const headers = { authorization: `Bearer ${await this.loadSecret()}` };
    return fetch(`http://127.0.0.1:${this.options.port}${path}`, { method, headers }).catch(() => undefined);
  }

  private async request(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const expected = Buffer.from(`Bearer ${await this.loadSecret()}`);
    const given = Buffer.from(req.headers.authorization ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) { res.writeHead(403).end(); return; }
    if (req.method === "GET" && req.url === "/owner") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ label: this.options.label?.() ?? "another pi session", connected: this.connected }));
    } else if (req.method === "POST" && req.url === "/release") {
      this.close("Another pi session took the browser.");
      res.writeHead(200, { connection: "close" }).end();
      this.options.onRelease?.();
    } else {
      res.writeHead(404).end();
    }
  }

  private loadSecret(): Promise<string> {
    return this.secret ??= loadSecret(this.options.secretPath);
  }

  private attach(socket: WebSocket): void {
    if (this.socket) { socket.close(4409, "Another Chrome is already connected to pi."); return; }
    this.socket = socket;
    for (const wake of this.waiters) wake();
    socket.on("error", () => {});
    socket.on("message", data => this.receive(data.toString()));
    socket.on("close", () => {
      for (const call of this.pending.values()) if (call.socket === socket) call.reject(new Error("Chrome extension disconnected."));
      if (this.socket === socket) this.socket = undefined;
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

export async function loadSecret(path: string): Promise<string> {
  try { return (await readFile(path, "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  try { await writeFile(path, secret, { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return (await readFile(path, "utf8")).trim(); throw error; }
  return secret;
}
