import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

export interface Favorite {
  provider: string;
  id: string;
}

export function modelKey(model: Favorite): string {
  return `${model.provider}/${model.id}`;
}

export class FavoritesStore {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<Favorite[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    const data: unknown = JSON.parse(text);
    if (
      !Array.isArray(data) ||
      !data.every((item: unknown): item is Favorite =>
        typeof item === "object" && item !== null &&
        "provider" in item && typeof item.provider === "string" && item.provider.length > 0 &&
        "id" in item && typeof item.id === "string" && item.id.length > 0
      )
    ) {
      throw new Error(`Invalid favorites file: ${this.path}. Expected an array of { provider, id }.`);
    }
    return [...new Map(data.map((item) => [modelKey(item), { provider: item.provider, id: item.id }])).values()];
  }

  async update(model: Favorite, action: "toggle" | "remove"): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true });
    // Lock across Pi processes; rename keeps readers from seeing partial JSON.
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: { retries: 30, minTimeout: 20, maxTimeout: 200, randomize: true },
    });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const favorites = await this.read();
      const exists = favorites.some((favorite) => modelKey(favorite) === modelKey(model));
      const added = action === "toggle" && !exists;
      const next = favorites.filter((favorite) => modelKey(favorite) !== modelKey(model));
      if (added) next.push({ provider: model.provider, id: model.id });
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, this.path);
      return added;
    } finally {
      try {
        await rm(temporary, { force: true });
      } finally {
        await release();
      }
    }
  }
}
