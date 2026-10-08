import { existsSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, parseArgs, SettingsManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const builtins = ["llama.cpp", "codemode", "tool-search", "mcp"];
export function isBuiltinExtension(path: string): boolean { return builtins.some(name => path === `builtin:${name}`); }

export async function normalizeExtensions(paths: string[]): Promise<string[]> {
  const own = await realpath(fileURLToPath(new URL("./index.ts", import.meta.url)));
  const result: string[] = [];
  for (const entry of paths) {
    if (isBuiltinExtension(entry)) { result.push(entry); continue; }
    if (!isAbsolute(entry)) throw new Error(`Child extension must be an absolute file or known builtin: ${entry}`);
    const path = await realpath(entry);
    if (path === own) continue;
    if (!(await stat(path)).isFile()) throw new Error(`Child extension must be a file: ${path}`);
    result.push(path);
  }
  return [...new Set(result)];
}

async function entryFile(path: string): Promise<string> {
  if (isBuiltinExtension(path) || !(await stat(path)).isDirectory()) return path;
  return ["index.ts", "index.js"].map(name => join(path, name)).find(file => existsSync(file)) ?? path;
}

// Pi exposes tool/command provenance, but not the complete loaded extension set.
// Resolve without importing factories again or installing/updating packages.
export async function parentExtensions(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string, argv = process.argv.slice(2)): Promise<string[]> {
  const args = parseArgs(argv);
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const packages = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager, builtinExtensions: builtins });
  const explicit: string[] = [], remote: string[] = [];
  for (const source of args.extensions ?? []) {
    if (isBuiltinExtension(source)) { explicit.push(source); continue; }
    if (source.startsWith("npm:") || source.startsWith("git:") || /^https?:/.test(source)) { remote.push(source); continue; }
    const local = source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : resolve(ctx.cwd, source);
    const resolved = await packages.resolveExtensionSources([local], { temporary: true });
    explicit.push(...resolved.extensions.filter(entry => entry.enabled).map(entry => entry.path));
  }
  if (remote.length) {
    // Pi records every -e resource as source "cli" without its package source or install directory.
    const loaded = [...pi.getAllTools(), ...pi.getCommands().filter(command => command.source === "extension")]
      .flatMap(item => item.sourceInfo?.source === "cli" && !explicit.includes(item.sourceInfo.path) ? [item.sourceInfo.path] : []);
    if (!loaded.length) throw new Error(`Cannot resolve parent extension ${remote.join(", ")} without tool or command provenance; configure pi-subagent/config.json extensions explicitly`);
    explicit.push(...loaded);
  }
  const configured = args.noExtensions ? [] : (await packages.resolve(async () => "error")).extensions.filter(entry => entry.enabled).map(entry => entry.path);
  return normalizeExtensions(await Promise.all([...explicit, ...configured].map(entryFile)));
}
