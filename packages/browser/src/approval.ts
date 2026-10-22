import { addHost, loadHosts } from "./config.ts";

export type Choice = "once" | "session" | "always" | "deny";
export type Ask = (host: string) => Promise<Choice>;

export function parse(url: string): URL {
  try { return new URL(url); } catch { throw new Error(`Invalid URL: ${url}`); }
}

export function hostOf(url: string): string | undefined {
  const { protocol, hostname } = parse(url);
  return protocol === "http:" || protocol === "https:" ? hostname : undefined;
}

export class Approvals {
  private readonly session = new Set<string>();
  private readonly configPath: string;

  constructor(configPath: string) {
    this.configPath = configPath;
  }

  reset(): void {
    this.session.clear();
  }

  async allowed(url: string, granted: Set<string>): Promise<boolean> {
    const host = hostOf(url);
    return !!host && (granted.has(host) || this.session.has(host) || (await loadHosts(this.configPath)).includes(host));
  }

  async approve(url: string, ask: Ask, granted: Set<string>): Promise<void> {
    const host = hostOf(url);
    if (!host) throw new Error(`The browser only acts on http and https pages, and this pi tab shows a ${parse(url).protocol} page. Navigate it first.`);
    if (await this.allowed(url, granted)) return;
    const choice = await ask(host);
    if (choice === "deny") throw new Error(`The user did not allow the browser on ${host}.`);
    granted.add(host);
    if (choice === "session") this.session.add(host);
    if (choice === "always") await addHost(this.configPath, host);
  }
}
