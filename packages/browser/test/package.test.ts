import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ORIGIN, PORT } from "../src/bridge.ts";

const root = fileURLToPath(new URL("../", import.meta.url));

test("package exposes its source and the Chrome extension, and excludes tests and plans", () => {
  const pkg = JSON.parse(readFileSync(root + "package.json", "utf8"));
  assert.equal(pkg.name, "@lwlee2608/pi-browser");
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.ok(existsSync(root + pkg.pi.extensions[0]));
  assert.ok(pkg.keywords.includes("pi-package"));
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" }));
  const paths: string[] = pack.files.map((file: { path: string }) => file.path);
  for (const path of ["src/index.ts", "chrome/manifest.json", "chrome/background.js", "README.md", "LICENSE"]) assert.ok(paths.includes(path), path);
  assert.ok(paths.every(path => !/^(test|plans)\//.test(path)));
});

test("the extension connects to the bridge's port", () => {
  assert.match(readFileSync(root + "chrome/background.js", "utf8"), new RegExp(`^const PORT = ${PORT};$`, "m"));
});

test("manifest key pins the extension id the bridge accepts", () => {
  const { key } = JSON.parse(readFileSync(root + "chrome/manifest.json", "utf8"));
  const id = createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
    .replace(/./g, c => String.fromCharCode(97 + parseInt(c, 16)));
  assert.equal(ORIGIN, `chrome-extension://${id}`);
});
