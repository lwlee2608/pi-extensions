import { existsSync } from "node:fs";
import { mkdir, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "com.lwlee2608.pi_browser";
export const ORIGIN = "chrome-extension://enidoebkpjligpdgedlellobooiiljib";
const HOST_SCRIPT = fileURLToPath(new URL("./host.js", import.meta.url));
const BROWSERS: Partial<Record<NodeJS.Platform, string[]>> = {
  linux: ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium", "BraveSoftware/Brave-Browser"],
  darwin: ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium", "BraveSoftware/Brave-Browser"],
};

export function detectBrowserDirs(home = homedir(), platform = process.platform, config = process.env.XDG_CONFIG_HOME || join(home, ".config")): string[] {
  const root = platform === "darwin" ? join(home, "Library", "Application Support") : config;
  return (BROWSERS[platform] ?? []).map(name => join(root, name)).filter(dir => existsSync(dir));
}

export function nodePath(execPath = process.execPath, standalone = Boolean(process.versions.bun) || process.getBuiltinModule("node:sea")?.isSea() === true): string {
  if (standalone) throw new Error(`The browser's native host runs on Node.js, but this pi runs as ${execPath}, which is not Node. Install pi with npm on Node.js 22.19+ to use the browser.`);
  return execPath;
}

export async function installHost(browserDirs: string[], sessions: string, node = nodePath(), script = HOST_SCRIPT): Promise<void> {
  for (const browser of browserDirs) {
    const dir = join(browser, "NativeMessagingHosts");
    const wrapper = join(dir, `${HOST}.sh`);
    const manifest = { name: HOST, description: "Pi Browser", path: wrapper, type: "stdio", allowed_origins: [`${ORIGIN}/`] };
    await mkdir(dir, { recursive: true });
    await write(wrapper, `#!/bin/sh\nexec ${[node, await realpath(script), sessions].map(quote).join(" ")} "$@"\n`, 0o755);
    await write(join(dir, `${HOST}.json`), `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
  }
}

async function write(path: string, text: string, mode: number): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, path);
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}
