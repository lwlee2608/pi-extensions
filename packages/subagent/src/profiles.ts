import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Effort, Start } from "./schema.ts";

export interface Config { extensions: Record<string, string>; trustedProjectRoots: string[]; maxActive: number; maxWorkers: number }
export interface Profile { name: string; path: string; prompt: string; trustedProjectRoot?: string; tools: string[]; model?: string; effort?: Effort; extensions?: string[] }
export interface Launch {
  cwd: string; agentDir: string; profile: Profile; extensions: string[]; skills: string[];
  provider: string; model: string; effort: Effort;
  providerContract: { api: string; baseUrl: string; registered: boolean };
}
const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const efforts = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
function list(value: unknown, field: string): string[] {
  const values = typeof value === "string" ? value.split(",").map(s => s.trim()) : value;
  if (!Array.isArray(values) || !values.every(v => typeof v === "string" && v.trim())) throw new Error(`Invalid ${field} list`);
  return values;
}
export async function loadConfig(agentDir: string): Promise<Config> {
  const path = join(agentDir, "pi-subagent/config.json");
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = {}; else throw new Error(`Cannot read ${path}: ${error}`); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(k => !["extensions", "trustedProjectRoots", "maxActive", "maxWorkers"].includes(k))) throw new Error(`Invalid config: ${path}`);
  const entries = raw.extensions ?? {};
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) throw new Error("extensions must map approved names to absolute file paths");
  const extensions: Record<string, string> = {};
  for (const [name, value] of Object.entries(entries)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || typeof value !== "string" || !isAbsolute(value)) throw new Error(`Invalid extension: ${name}`);
    const path = await realpath(value);
    if (!(await stat(path)).isFile()) throw new Error(`Extension must be a file: ${path}`);
    extensions[name] = path;
  }
  const trustedProjectRoots = await Promise.all(list(raw.trustedProjectRoots ?? [], "trustedProjectRoots").map(async path => {
    if (!isAbsolute(path)) throw new Error("Trusted project roots must be absolute");
    return realpath(path);
  }));
  const maxActive = raw.maxActive ?? 4, maxWorkers = raw.maxWorkers ?? 16;
  if (!Number.isSafeInteger(maxActive) || !Number.isSafeInteger(maxWorkers) || Number(maxActive) < 1 || Number(maxWorkers) < 1 || Number(maxActive) > Number(maxWorkers) || Number(maxWorkers) > 256) throw new Error("Limits must satisfy 1 <= maxActive <= maxWorkers <= 256");
  return { extensions, trustedProjectRoots, maxActive: Number(maxActive), maxWorkers: Number(maxWorkers) };
}
async function findProfile(dir: string, name: string): Promise<Profile | undefined> {
  let names: string[];
  try { names = (await readdir(dir)).filter(n => n.endsWith(".md")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let found: Profile | undefined;
  for (const filename of names) {
    const path = join(dir, filename);
    const { frontmatter: meta, body } = parseFrontmatter<Record<string, unknown>>(await readFile(path, "utf8"));
    if (meta.name !== name) continue;
    if (found) throw new Error(`Duplicate profile ${name} in ${dir}`);
    const tools = meta.tools === undefined ? builtins : list(meta.tools, "tools");
    if (!tools.length || tools.some(t => !/^[a-zA-Z0-9_-]+$/.test(t) || /subagent|delegate/i.test(t))) throw new Error(`Invalid or nested delegation tool in ${path}`);
    if (meta.model !== undefined && typeof meta.model !== "string") throw new Error(`Invalid model in ${path}`);
    if (meta.effort !== undefined && !efforts.includes(String(meta.effort))) throw new Error(`Invalid effort in ${path}`);
    found = { name, path: await realpath(path), prompt: body, tools, model: meta.model as string | undefined,
      effort: meta.effort as Effort | undefined, extensions: meta.extensions === undefined ? undefined : list(meta.extensions, "extensions") };
  }
  return found;
}
export async function resolveLaunch(input: Start, parent: { cwd: string; agentDir: string; model?: Model<Api>; effort: Effort; models: Model<Api>[]; skills?: string[]; registeredProviders?: readonly string[] }, config: Config): Promise<Launch> {
  const cwd = await realpath(resolve(parent.cwd, input.cwd ?? "."));
  if (!(await stat(cwd)).isDirectory()) throw new Error(`Not a working directory: ${cwd}`);
  let profile: Profile | undefined;
  if (input.agentScope && input.agentScope !== "user") {
    let root = cwd;
    while (true) {
      try {
        if ((await stat(join(root, ".pi/agents"))).isDirectory()) {
          if (!config.trustedProjectRoots.includes(root)) throw new Error(`Project profiles require explicit trust in pi-subagent/config.json: ${root}`);
          profile = await findProfile(join(root, ".pi/agents"), input.agent);
          if (profile) profile.trustedProjectRoot = root;
          break;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (dirname(root) === root) break;
      root = dirname(root);
    }
  }
  if (!profile && input.agentScope !== "project") profile = await findProfile(join(parent.agentDir, "agents"), input.agent);
  if (!profile && input.agentScope !== "project") profile = await findProfile(fileURLToPath(new URL("../agents/", import.meta.url)), input.agent);
  if (!profile) throw new Error(`Agent profile not found: ${input.agent}`);
  let selection = input.model ?? profile.model;
  let suffix: Effort | undefined;
  if (selection) {
    const match = selection.match(/:(off|minimal|low|medium|high|xhigh|max)$/);
    if (match) { suffix = match[1] as Effort; selection = selection.slice(0, -match[0].length); }
  }
  const candidates = selection ? parent.models.filter(m => `${m.provider}/${m.id}` === selection || m.id === selection) : parent.models.filter(m => m.id === parent.model?.id && m.provider === parent.model.provider);
  if (candidates.length !== 1) throw new Error(`Model must identify exactly one available model (no fallback): ${selection ?? "parent model"}`);
  const model = candidates[0];
  const effort = (input.effort ?? (input.model ? suffix : undefined) ?? profile.effort ?? suffix ?? parent.effort) as Effort;
  if (!getSupportedThinkingLevels(model).includes(effort)) throw new Error(`${model.provider}/${model.id} does not support effort ${effort}`);
  const extensions = (profile.extensions ?? Object.keys(config.extensions)).map(name => {
    if (!Object.hasOwn(config.extensions, name)) throw new Error(`Profile requests unapproved child extension: ${name}`);
    return config.extensions[name];
  });
  return { cwd, agentDir: parent.agentDir, profile, extensions, skills: parent.skills ?? [], provider: model.provider, model: model.id, effort,
    providerContract: { api: model.api, baseUrl: model.baseUrl, registered: parent.registeredProviders?.includes(model.provider) ?? false } };
}
