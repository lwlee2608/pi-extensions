import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const VERSION = "156.0.8078.47";
const PLATFORMS: Record<string, string> = { "darwin-arm64": "mac-arm64", "darwin-x64": "mac-x64", "linux-x64": "linux64" };

async function chromePath(): Promise<string> {
  const platform = PLATFORMS[`${process.platform}-${process.arch}`];
  if (!platform) throw new Error(`No Chrome for Testing build for ${process.platform}-${process.arch}.`);
  const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-browser", "chrome-for-testing", VERSION);
  const binary = platform.startsWith("mac")
    ? join(dir, `chrome-${platform}`, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
    : join(dir, "chrome-linux64", "chrome");
  if (existsSync(binary)) return binary;
  const response = await fetch(`https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/${platform}/chrome-${platform}.zip`);
  if (!response.ok) throw new Error(`Chrome for Testing download failed: HTTP ${response.status}`);
  const staging = `${dir}.download`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "chrome.zip"), Buffer.from(await response.arrayBuffer()));
  execFileSync("unzip", ["-q", join(staging, "chrome.zip"), "-d", join(staging, "out")]);
  await rename(join(staging, "out"), dir);
  await rm(staging, { recursive: true, force: true });
  return binary;
}

type Listener = (method: string, params: any, sessionId?: string) => void;

export class Cdp {
  private readonly socket: WebSocket;
  private readonly calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<Listener>();
  private nextId = 0;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", data => {
      const message = JSON.parse(data.toString());
      const call = this.calls.get(message.id);
      this.calls.delete(message.id);
      if (call) {
        if (message.error) call.reject(new Error(message.error.message));
        else call.resolve(message.result);
      } else {
        for (const listener of this.listeners) listener(message.method, message.params, message.sessionId);
      }
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = ++this.nextId;
    this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise((resolve, reject) => this.calls.set(id, { resolve, reject }));
  }

  waitFor(method: string, match: (params: any) => boolean = () => true): Promise<any> {
    return new Promise(resolve => {
      const listener: Listener = (name, params) => {
        if (name !== method || !match(params)) return;
        this.listeners.delete(listener);
        resolve(params);
      };
      this.listeners.add(listener);
    });
  }
}

export async function launchChrome(extensionDir: string, userDataDir: string): Promise<{ cdp: Cdp; close: () => Promise<void> }> {
  const chrome = spawn(await chromePath(), [
    `--user-data-dir=${userDataDir}`, "--headless=new", "--force-device-scale-factor=2", "--window-size=1100,800", "--no-first-run", "--no-default-browser-check",
    "--use-mock-keychain", "--password-store=basic", "--remote-debugging-port=0", "--host-resolver-rules=MAP *.test 127.0.0.1",
    `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const url = await new Promise<string>((resolve, reject) => {
    let log = "";
    chrome.stderr.on("data", chunk => {
      log += chunk;
      const match = log.match(/DevTools listening on (ws:\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.once("exit", code => reject(new Error(`Chrome exited with ${code}:\n${log}`)));
  });
  const socket = new WebSocket(url);
  await once(socket, "open");
  return {
    cdp: new Cdp(socket),
    close: async () => {
      socket.close();
      if (chrome.exitCode !== null) return;
      chrome.kill();
      await once(chrome, "exit");
    },
  };
}
