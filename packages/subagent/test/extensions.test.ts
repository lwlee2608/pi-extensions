import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parentExtensions, normalizeExtensions } from "../src/extensions.ts";
import { loadConfig } from "../src/profiles.ts";
import { prerequisites } from "../src/store.ts";
import { fixture } from "./helpers.ts";

const pi = { getAllTools: () => [], getCommands: () => [] } as unknown as ExtensionAPI;
function context(cwd: string, trusted = false): ExtensionContext {
  return { cwd, isProjectTrusted: () => trusted } as ExtensionContext;
}

test("inheritance resolves packages, resource filters, CLI paths and project trust without executing factories", async () => {
  const f = await fixture();
  try {
    const pkg = join(f.root, "package");
    await mkdir(pkg);
    await writeFile(join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["provider.js", "disabled.js"] } }));
    for (const name of ["provider.js", "disabled.js"]) await writeFile(join(pkg, name), 'throw new Error("must not import");');
    await writeFile(join(f.launch.agentDir, "settings.json"), JSON.stringify({ packages: [{ source: pkg, extensions: ["provider.js"] }] }));
    const project = join(f.launch.cwd, ".pi/extensions");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "project.js"), "export default () => {};");
    assert.deepEqual(await parentExtensions(pi, context(f.launch.cwd), f.launch.agentDir, []), [join(pkg, "provider.js"),
      "builtin:llama.cpp", "builtin:codemode", "builtin:tool-search", "builtin:mcp"]);
    const trusted = await parentExtensions(pi, context(f.launch.cwd, true), f.launch.agentDir, []);
    assert.ok(trusted.includes(join(project, "project.js")));
    assert.ok(!trusted.includes(join(pkg, "disabled.js")));
    const explicit = f.launch.extensions[0];
    assert.deepEqual(await parentExtensions(pi, context(f.launch.cwd, true), f.launch.agentDir, ["--no-extensions", "-e", explicit]), [explicit]);
    const dir = join(f.root, "directory-extension");
    await mkdir(dir);
    await writeFile(join(dir, "index.js"), 'throw new Error("must not import");');
    assert.deepEqual(await parentExtensions(pi, context(f.launch.cwd), f.launch.agentDir, ["--no-extensions", "-e", dir]), [join(dir, "index.js")]);
    await assert.rejects(parentExtensions(pi, context(f.launch.cwd), f.launch.agentDir, ["-e", "npm:missing-provider"]), /without tool or command provenance/);
  } finally { await f.cleanup(); }
});

test("missing extensions inherits; explicit maps (including empty) replace inheritance", async () => {
  const f = await fixture();
  try {
    const config = join(f.launch.agentDir, "pi-subagent/config.json");
    await rm(config);
    const inherited = async () => f.launch.extensions;
    assert.deepEqual(Object.values((await loadConfig(f.launch.agentDir, inherited)).extensions), f.launch.extensions);
    await writeFile(config, '{"maxActive":2}');
    assert.deepEqual(Object.values((await loadConfig(f.launch.agentDir, inherited)).extensions), f.launch.extensions);
    await writeFile(config, '{"extensions":{}}');
    assert.deepEqual((await loadConfig(f.launch.agentDir, () => { throw new Error("must not discover"); })).extensions, {});
    await writeFile(config, JSON.stringify({ extensions: { provider: f.launch.extensions[0] } }));
    assert.deepEqual((await loadConfig(f.launch.agentDir, inherited)).extensions, { provider: f.launch.extensions[0] });
  } finally { await f.cleanup(); }
});

test("normalize deduplicates real paths and excludes self even through a symlink", async () => {
  const f = await fixture();
  try {
    const own = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const link = join(f.root, "subagent.ts");
    await symlink(own, link);
    assert.deepEqual(await normalizeExtensions([own, link, ...f.launch.extensions, ...f.launch.extensions]), [await realpath(f.launch.extensions[0])]);
    assert.deepEqual(await normalizeExtensions(["builtin:mcp"]), ["builtin:mcp"]);
    const builtins = ["builtin:llama.cpp", "builtin:codemode", "builtin:tool-search", "builtin:mcp"];
    assert.equal(Object.keys(prerequisites({ ...f.launch, extensions: builtins }).files).length, 5);
    const withBuiltin = { getAllTools: () => [{ sourceInfo: { path: "builtin:codemode" } }], getCommands: () => [] } as unknown as ExtensionAPI;
    assert.deepEqual(await parentExtensions(withBuiltin, context(f.launch.cwd), f.launch.agentDir, ["--no-extensions", "-e", "builtin:codemode"]), ["builtin:codemode"]);
    await assert.rejects(normalizeExtensions(["builtin:unknown"]), /known builtin/);
  } finally { await f.cleanup(); }
});
