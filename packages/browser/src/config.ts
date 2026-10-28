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

export async function addHost(path: string, host: string, list: HostList = "allowedHosts"): Promise<void> {
  const config = await load(path);
  const hosts = hostsOf(path, config, list);
  if (hosts.includes(host)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ ...config, [list]: [...hosts, host] }, null, 2)}\n`);
}
