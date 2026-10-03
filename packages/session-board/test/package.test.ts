import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

test("packed artifact contains its entry and all relative imports, without tests or dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "board-pack-"));
  try {
    const packed = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root], { encoding: "utf8" }))[0];
    assert.ok(packed.files.every((file: { path: string }) => !/^(test|node_modules|plans)\//.test(file.path)));
    execFileSync("tar", ["-xzf", join(root, packed.filename), "-C", root]);
    const packageRoot = join(root, "package");
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    for (const entry of manifest.pi.extensions) assert.ok((await stat(join(packageRoot, entry))).isFile());
    for (const name of await readdir(join(packageRoot, "src"))) {
      const path = join(packageRoot, "src", name);
      const source = await readFile(path, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)) assert.ok((await stat(resolve(dirname(path), match[1]))).isFile());
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
