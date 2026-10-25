import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Bridge, listenSocket } from "../src/bridge.ts";
import { decoder, encode } from "../src/host.js";
import { detectBrowserDirs, HOST, installHost, ORIGIN } from "../src/install.ts";

const home = await mkdtemp(join(tmpdir(), "pi-browser-install-"));
test.after(() => rm(home, { recursive: true, force: true }));
const config = join(home, ".config");
const sessions = join(home, "sessions");

test("installs the manifest and a Node-pinned wrapper into each detected Linux browser", async () => {
  const chrome = join(config, "google-chrome");
  const brave = join(config, "BraveSoftware", "Brave-Browser");
  for (const dir of [chrome, brave, join(config, "other")]) await mkdir(dir, { recursive: true });
  const dirs = detectBrowserDirs(home, config);
  assert.deepEqual(dirs, [chrome, brave]);
  for (const node of ["/old/node", "/opt/it's/node"]) await installHost(dirs, sessions, node);
  for (const dir of dirs) {
    const hosts = join(dir, "NativeMessagingHosts");
    const wrapper = join(hosts, `${HOST}.sh`);
    assert.deepEqual((await readdir(hosts)).sort(), [`${HOST}.json`, `${HOST}.sh`]);
    assert.deepEqual(JSON.parse(await readFile(join(hosts, `${HOST}.json`), "utf8")),
      { name: HOST, description: "Pi Browser", path: wrapper, type: "stdio", allowed_origins: [`${ORIGIN}/`] });
    assert.match(await readFile(wrapper, "utf8"), new RegExp(`^#!/bin/sh\nexec '/opt/it'\\\\''s/node' '\\S+/src/host\\.js' '${sessions}' "\\$@"\n$`));
    assert.equal((await stat(wrapper)).mode & 0o777, 0o755);
  }
});

test("the installed wrapper runs the host, which relays a call from the session to Chrome's stdio", async () => {
  const browser = join(home, "browser");
  await installHost([browser], sessions);
  const bridge = new Bridge({ transport: handlers => listenSocket(join(sessions, "a.sock"), handlers), connectTimeout: 5_000, callTimeout: 5_000 });
  await bridge.listen();
  const child = spawn(join(browser, "NativeMessagingHosts", `${HOST}.sh`), [`${ORIGIN}/`], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdout.on("data", decoder(({ id, method }: { id?: number; method?: string }) => { if (id) child.stdin.write(encode({ id, result: method })); }));
  try {
    assert.equal(await bridge.call("echo", {}), "echo");
  } finally {
    child.stdin.end();
    bridge.close();
  }
});
