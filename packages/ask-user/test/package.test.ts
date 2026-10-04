import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parameters, description } from "../src/schema.ts";

test("package exposes its source, supplies no host copies, and excludes fixtures from the tarball", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.name, "@lwlee2608/pi-ask-user");
  assert.deepEqual(pkg.pi.extensions, ["./src/index.ts"]);
  assert.ok(existsSync(root + pkg.pi.extensions[0]));
  assert.equal(pkg.dependencies, undefined);
  assert.ok(pkg.keywords.includes("pi-package"));
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" }));
  const paths: string[] = pack.files.map((file: { path: string }) => file.path);
  assert.ok(paths.includes("src/index.ts"));
  assert.ok(paths.includes("src/overlay.ts"));
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("LICENSE"));
  assert.ok(paths.every(path => !/^(test|plans|node_modules)\//.test(path)));
  assert.ok(description.length + JSON.stringify(parameters).length <= 1800);
});
