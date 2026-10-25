import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Bridge, listenSocket } from "../src/bridge.ts";
import { decoder, encode, PROTOCOL } from "../src/host.js";
import { detectBrowserDirs, HOST, installHost, nodePath, ORIGIN } from "../src/install.ts";

const home = await mkdtemp(join(tmpdir(), "pi-browser-install-"));
test.after(() => rm(home, { recursive: true, force: true }));
const config = join(home, ".config");
const sessions = join(home, "sessions");

test("installs the manifest and a Node-pinned wrapper into each detected Linux browser", async () => {
  const chrome = join(config, "google-chrome");
  const brave = join(config, "BraveSoftware", "Brave-Browser");
  for (const dir of [chrome, brave, join(config, "other")]) await mkdir(dir, { recursive: true });
  const dirs = detectBrowserDirs(home, "linux", config);
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

test("installs into each detected macOS browser under Application Support", async () => {
  const mac = join(home, "mac");
  const support = join(mac, "Library", "Application Support");
  const browsers = ["Google/Chrome", "Chromium", "BraveSoftware/Brave-Browser"].map(name => join(support, name));
  for (const dir of [...browsers, join(support, "Firefox")]) await mkdir(dir, { recursive: true });
  const dirs = detectBrowserDirs(mac, "darwin", config);
  assert.deepEqual(dirs, browsers);
  await installHost(dirs, sessions, "/opt/homebrew/bin/node");
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(dir, "NativeMessagingHosts", `${HOST}.json`), "utf8"));
    assert.equal(manifest.path, join(dir, "NativeMessagingHosts", `${HOST}.sh`));
    assert.match(await readFile(manifest.path, "utf8"), /^exec '\/opt\/homebrew\/bin\/node' /m);
  }
});

test("a pi that is not running on Node refuses to pin itself as the host's Node", () => {
  assert.equal(nodePath("/usr/bin/node", false), "/usr/bin/node");
  assert.throws(() => nodePath("/usr/local/bin/pi", true), /runs as \/usr\/local\/bin\/pi, which is not Node\. Install pi with npm/);
  assert.equal(nodePath(), process.execPath);
});

test("the installed wrapper runs the host through a symlinked package, and it relays a call from the session to Chrome's stdio", async () => {
  const browser = join(home, "browser");
  const linked = join(home, "linked-src");
  await symlink(fileURLToPath(new URL("../src/", import.meta.url)), linked);
  await installHost([browser], sessions, process.execPath, join(linked, "host.js"));
  const bridge = new Bridge({ transport: handlers => listenSocket(join(sessions, "a.sock"), handlers), connectTimeout: 5_000, callTimeout: 5_000 });
  await bridge.listen();
  const child = spawn(join(browser, "NativeMessagingHosts", `${HOST}.sh`), [`${ORIGIN}/`], { stdio: ["pipe", "pipe", "inherit"] });
  let host: number | undefined;
  child.stdout.on("data", decoder(({ session, event, version, message }: { session: string; event?: string; version?: number; message?: { id: number; method: string } }) => {
    if (event === "hello") host = version;
    if (message) child.stdin.write(encode({ session, message: { id: message.id, result: message.method === "hello" ? { version: PROTOCOL, host } : `${session} ${message.method}` } }));
  }));
  try {
    assert.equal(await bridge.call("echo", {}), "a echo");
  } finally {
    child.stdin.end();
    bridge.close();
  }
});
