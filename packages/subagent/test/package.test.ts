import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
test("extracted artifact runs parent, bundled profile and child bridge outside checkout", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-pack-")); let client: RpcClient | undefined;
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { cwd: packageRoot, encoding: "utf8" }))[0];
    assert.ok(packed.files.every((file: { path: string }) => !/^(test|plans|node_modules)\//.test(file.path)));
    execFileSync("tar", ["-xzf", join(root, packed.filename), "-C", root]);
    const artifact = join(root, "package"), agentDir = join(root, "agent"), cwd = join(root, "work");
    const manifest = JSON.parse(await readFile(join(artifact, "package.json"), "utf8"));
    assert.deepEqual(manifest.pi.extensions, ["./src/index.ts"]);
    for (const path of ["src/child.ts", "src/bootstrap.ts", "agents/worker.md", "agents/reviewer.md"]) assert.ok(await readFile(join(artifact, path), "utf8"));
    await mkdir(join(agentDir, "pi-subagent"), { recursive: true }); await mkdir(cwd);
    await writeFile(join(agentDir, "pi-subagent/config.json"), JSON.stringify({ extensions: { fixture: provider } }));
    client = new RpcClient({ cliPath: join(getPackageDir(), "dist/cli.js"), cwd, env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
      args: ["--no-session", "--no-extensions", "--no-approve", "--provider", "subagent-offline", "--model", "fixture", "--thinking", "off", "--extension", provider, "--extension", artifact, "--tools", "subagent"] });
    await client.start();
    const commands = await client.getCommands(); assert.equal(commands.filter(c => c.name === "subagents").length, 1);
    const events = await client.promptAndWait("PARENT_SMOKE", undefined, 20_000);
    const results = events.filter(e => e.type === "tool_execution_end");
    assert.equal(results.length, 3); assert.ok(results.every(e => !e.isError));
    assert.equal(JSON.parse(results[1].result.content[0].text).runs[0].result.outcome, "completed");
    assert.equal(JSON.parse(results[2].result.content[0].text).processAlive, false);
  } finally { await client?.stop(); await rm(root, { recursive: true, force: true }); }
});

test("loading the old example beside the package emits a duplicate-tool diagnostic", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "subagent-conflict-"));
  try {
    const example = join(getPackageDir(), "examples/extensions/subagent/index.ts");
    const child = spawn(process.execPath, [join(getPackageDir(), "dist/cli.js"), "--mode", "rpc", "--no-session", "--no-extensions", "--no-approve", "--extension", example, "--extension", packageRoot], {
      cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: root, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; if (String(chunk).includes('"response"')) child.stdin.end(); });
    child.stderr.on("data", chunk => { output += chunk; });
    child.stdin.write('{"type":"get_state"}\n');
    const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
    await new Promise(resolve => child.once("close", resolve)); clearTimeout(timer);
    assert.match(output, /subagent/i); assert.match(output, /conflict|duplicate|already registered/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
