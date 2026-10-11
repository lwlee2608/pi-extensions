import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { piInvocation, RpcProcess } from "../src/rpc.ts";

const bun = process.env.BUN_BIN ?? "bun";
test("compiled Bun executable supports RPC, IPC readiness/questions/replies and cleanup", {
  skip: spawnSync(bun, ["--version"]).status !== 0 ? "Bun is required to compile the fixture" : false,
  timeout: 60_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-compiled-test-"));
  let child: RpcProcess | undefined;
  try {
    const binary = join(root, "pi-fixture");
    const build = spawnSync(bun, ["build", "--compile", fileURLToPath(new URL("./fixtures/compiled-rpc.ts", import.meta.url)), "--outfile", binary], { encoding: "utf8" });
    assert.equal(build.status, 0, build.stderr);
    const token = randomUUID();
    child = new RpcProcess(piInvocation(["--mode", "rpc"], { execPath: binary, script: "/$bunfs/root/pi-fixture", bun: true, packageDir: root }), root,
      { ...process.env, PI_SUBAGENT_TOKEN: token }, token);
    await child.initialize();
    const question = new Promise<string>(resolve => child!.onEvent(event => {
      if (event.type === "subagent_question") resolve(event.requestId);
    }));
    const settled = new Promise<void>(resolve => child!.onEvent(event => { if (event.type === "agent_settled") resolve(); }));
    await child.request({ type: "prompt", message: "hello" });
    await child.reply(await question, "yes");
    await settled;
    await child.close();
    assert.equal(child.exited, true);
    assert.throws(() => process.kill(child!.pid!, 0), /ESRCH/);
  } finally { await child?.close(); await rm(root, { recursive: true, force: true }); }
});
