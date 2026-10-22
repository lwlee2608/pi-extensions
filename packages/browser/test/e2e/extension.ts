import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../../chrome/", import.meta.url));

function set(text: string, name: string, value: number): string {
  const line = new RegExp(`^const ${name} = [\\d._]+;$`, "m");
  if (!line.test(text)) throw new Error(`chrome/background.js no longer declares ${name} as a plain constant.`);
  return text.replace(line, `const ${name} = ${value};`);
}

export async function copyExtension(dir: string, { port, alarmMinutes }: { port: number; alarmMinutes: number }): Promise<string> {
  await cp(source, dir, { recursive: true });
  const path = join(dir, "background.js");
  await writeFile(path, set(set(await readFile(path, "utf8"), "PORT", port), "ALARM_MINUTES", alarmMinutes));
  return dir;
}
