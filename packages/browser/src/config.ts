import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

async function load(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try { return JSON.parse(raw) ?? {}; }
  catch { throw new Error(`${path} is not valid JSON.`); }
}

async function save(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

function hostsOf(path: string, config: Record<string, unknown>): string[] {
  const hosts = config.allowedHosts ?? [];
  if (!Array.isArray(hosts) || !hosts.every(host => typeof host === "string")) {
    throw new Error(`${path} needs "allowedHosts" to be an array of hostnames.`);
  }
  return hosts.map(host => host.toLowerCase());
}

export async function loadHosts(path: string): Promise<string[]> {
  return hostsOf(path, await load(path));
}

export async function addHost(path: string, host: string): Promise<void> {
  const config = await load(path);
  const hosts = hostsOf(path, config);
  if (!hosts.includes(host)) await save(path, { ...config, allowedHosts: [...hosts, host] });
}

export async function removeHosts(path: string, host?: string): Promise<void> {
  const config = await load(path);
  const hosts = hostsOf(path, config);
  await save(path, { ...config, allowedHosts: host === undefined ? [] : hosts.filter(h => h !== host) });
}

export async function loadConfirmEval(path: string): Promise<boolean> {
  const value = (await load(path)).confirmEval ?? false;
  if (typeof value !== "boolean") throw new Error(`${path} needs "confirmEval" to be true or false.`);
  return value;
}

export async function setConfirmEval(path: string, value: boolean): Promise<void> {
  await save(path, { ...await load(path), confirmEval: value });
}
