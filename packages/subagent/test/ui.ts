import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

if (!process.stdin.isTTY) throw new Error("Run this offline UI fixture from a terminal");
const root = await mkdtemp(join(tmpdir(), "pi-subagent-ui-"));
const agentDir = join(root, "agent"), cwd = join(root, "work");
const provider = fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url));
await mkdir(join(agentDir, "pi-subagent"), { recursive: true }); await mkdir(cwd);
await mkdir(join(agentDir, "agents"));
await writeFile(join(agentDir, "agents/worker.md"), "---\nname: worker\ndescription: Offline UI worker\ntools: read, write, bash, fixture_hold\n---\nYou are an offline verification worker.\n");
await writeFile(join(agentDir, "pi-subagent/config.json"), JSON.stringify({ extensions: { fixture: provider } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }));
const mode = process.argv[2] === "regular" ? "regular" : "fullscreen";
console.log(`Offline fixture: ${root}\nType PARENT_UI, then /subagents. No paid calls or global settings. Exit Pi normally to clean up.`);
const child = spawn(process.execPath, [join(getPackageDir(), "dist/cli.js"), "--tui-mode", mode, "--no-extensions", "--no-approve", "--offline",
  "--provider", "subagent-offline", "--model", "fixture", "--thinking", "off", "--tools", "subagent", "--extension", provider,
  "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)),
  "--extension", fileURLToPath(new URL("../../footer/src/index.ts", import.meta.url)),
  "--extension", fileURLToPath(new URL("../../session-board/src/index.ts", import.meta.url))], {
  cwd, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, stdio: "inherit",
});
const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
if (code === 0) await rm(root, { recursive: true, force: true });
else console.error(`Fixture retained after exit ${code}: ${root}. Verify owned child exit before removing it.`);
process.exitCode = code ?? 1;
