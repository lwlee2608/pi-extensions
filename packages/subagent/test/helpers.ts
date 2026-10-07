import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Manager } from "../src/manager.ts";
import type { Launch } from "../src/profiles.ts";

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-test-"));
  const agentDir = join(root, "agent"), cwd = join(root, "work");
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false }, enableAnalytics: false }));
  const launch: Launch = { cwd, agentDir, provider: "subagent-offline", model: "fixture", effort: "off", skills: [],
    extensions: [fileURLToPath(new URL("./fixtures/provider.ts", import.meta.url))],
    profile: { name: "fixture", path: "fixture", prompt: "You are an offline verification worker.", tools: ["read", "write", "bash", "fixture_hold"] } };
  const manager = new Manager({ root: join(agentDir, "pi-subagent"), parentId: "fixture-parent" });
  return { root, launch, manager, async cleanup() { await manager.shutdown(); await rm(root, { recursive: true, force: true }); } };
}
export function changedUntil(manager: Manager, condition: () => boolean): Promise<void> {
  if (condition()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`Timed out: ${JSON.stringify(manager.status())}`)); }, 25_000);
    const unsubscribe = manager.onChange(() => { if (condition()) { clearTimeout(timer); unsubscribe(); resolve(); } });
  });
}
