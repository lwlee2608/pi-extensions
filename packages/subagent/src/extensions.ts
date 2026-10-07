import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
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

// Pi exposes tool/command provenance, but not the complete loaded extension set.
// Resolve without importing factories again or installing/updating packages.
export async function parentExtensions(pi: ExtensionAPI, ctx: ExtensionContext, agentDir: string, argv = process.argv.slice(2)): Promise<string[]> {
  const args = parseArgs(argv);
  const settingsManager = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  const packages = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager, builtinExtensions: builtins });
  const sources = [...pi.getAllTools(), ...pi.getCommands()].flatMap(item => item.sourceInfo ? [item.sourceInfo] : []);
  const explicit: string[] = [];
  for (const source of args.extensions ?? []) {
    if (isBuiltinExtension(source)) { explicit.push(source); continue; }
    const remote = source.startsWith("npm:") || source.startsWith("git:") || /^https?:/.test(source);
    const installed = remote ? sources.find(info => info.source === source && info.scope === "temporary")?.baseDir
      : source.startsWith("~/") ? resolve(homedir(), source.slice(2)) : resolve(ctx.cwd, source);
    if (!installed) throw new Error(`Cannot resolve parent extension ${source} without installing it; configure pi-subagent/config.json extensions explicitly`);
    const resolved = await packages.resolveExtensionSources([installed], { temporary: true });
    explicit.push(...resolved.extensions.filter(entry => entry.enabled).map(entry => entry.path));
  }
  const configured = args.noExtensions ? [] : (await packages.resolve(async () => "error")).extensions.filter(entry => entry.enabled).map(entry => entry.path);
  return normalizeExtensions([...explicit, ...configured]);
}
