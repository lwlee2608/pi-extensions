import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../chrome/", import.meta.url));

function set(text: string, name: string, value: number): string {
  const line = new RegExp(`^const ${name} = [\\d._]+;$`, "m");
  if (!line.test(text)) throw new Error(`chrome/background.js no longer declares ${name} as a plain constant.`);
  return text.replace(line, `const ${name} = ${value};`);
}

export async function copyExtension(dir: string, settings: { RECONNECT_MS: number; RECONNECT_MAX_MS: number; NAVIGATE_WAIT_MS: number }): Promise<string> {
  await cp(source, dir, { recursive: true });
  const path = join(dir, "background.js");
  await writeFile(path, Object.entries(settings).reduce((text, [name, value]) => set(text, name, value), await readFile(path, "utf8")));
  return dir;
}
