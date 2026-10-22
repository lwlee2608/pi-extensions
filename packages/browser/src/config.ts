import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function loadHosts(path: string): Promise<string[]> {
  let raw: string;
  try { raw = await readFile(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  let value: { allowedHosts?: unknown };
  try { value = JSON.parse(raw); }
  catch { throw new Error(`${path} is not valid JSON.`); }
  const hosts = value?.allowedHosts ?? [];
  if (!Array.isArray(hosts) || !hosts.every(host => typeof host === "string")) {
    throw new Error(`${path} needs "allowedHosts" to be an array of hostnames.`);
  }
  return hosts.map(host => host.toLowerCase());
}

export async function addHost(path: string, host: string): Promise<void> {
  const hosts = await loadHosts(path);
  if (hosts.includes(host)) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ allowedHosts: [...hosts, host] }, null, 2)}\n`);
}
