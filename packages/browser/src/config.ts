import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type HostList = "allowedHosts" | "evalHosts";

async function load(path: string): Promise<Record<string, unknown>> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  try { return JSON.parse(raw) ?? {}; }
  catch { throw new Error(`${path} is not valid JSON.`); }
}

function hostsOf(path: string, config: Record<string, unknown>, list: HostList): string[] {
  const hosts = config[list] ?? [];
  if (!Array.isArray(hosts) || !hosts.every(host => typeof host === "string")) {
    throw new Error(`${path} needs "${list}" to be an array of hostnames.`);
  }
  return hosts.map(host => host.toLowerCase());
}

export async function loadHosts(path: string, list: HostList = "allowedHosts"): Promise<string[]> {
  return hostsOf(path, await load(path), list);
}

export async function loadConfirmEval(path: string): Promise<boolean> {
  const value = (await load(path)).confirmEval ?? true;
  if (typeof value !== "boolean") throw new Error(`${path} needs "confirmEval" to be true or false.`);
  return value;
}

async function save(path: string, config: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}

export async function addHost(path: string, host: string, list: HostList = "allowedHosts"): Promise<void> {
  const config = await load(path);
  const hosts = hostsOf(path, config, list);
  if (!hosts.includes(host)) await save(path, { ...config, [list]: [...hosts, host] });
}

export async function stopConfirmingEval(path: string): Promise<void> {
  await save(path, { ...await load(path), confirmEval: false });
}
