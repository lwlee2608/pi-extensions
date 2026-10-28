import { addHost, loadConfirmEval, loadHosts, stopConfirmingEval } from "./config.ts";

export type Choice = "once" | "session" | "always" | "deny";
export type Ask = (host: string) => Promise<Choice>;
export type Choose = (title: string, options: string[]) => Promise<string | undefined>;

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
    if (!host) {
      const { protocol } = parse(url);
      throw new Error(`The browser only acts on http and https pages, and this pi tab shows ${/^[aeiou]/.test(protocol) ? "an" : "a"} ${protocol} page. Navigate it first.`);
    }
    if (await this.allowed(url, granted)) return;
    const choice = await ask(host);
    if (choice === "deny") throw new Error(`The user did not allow the browser on ${host}.`);
    granted.add(host);
    if (choice === "session") this.session.add(host);
    if (choice === "always") await addHost(this.configPath, host);
  }
}

const EVAL_MAX_LINES = 20;
const EVAL_MAX_CHARS = 1_500;
const HIDDEN = /(?![\t\n])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/u;

export async function confirmEval(code: string | undefined, host: string, choose: Choose, configPath: string): Promise<void> {
  if (!code?.trim()) throw new Error("eval needs code.");
  if (HIDDEN.test(code)) throw new Error("eval code may not contain invisible or control characters other than newline and tab; write them as escapes like \\u001b.");
  const lines = code.split("\n");
  if (lines.length > EVAL_MAX_LINES || code.length > EVAL_MAX_CHARS) {
    throw new Error(`eval code is limited to ${EVAL_MAX_LINES} lines and ${EVAL_MAX_CHARS} characters so the user can see all of it.`);
  }
  if (lines.some((line, i) => !line.trim() && i > 0 && !lines[i - 1].trim())) throw new Error("eval code may not have two blank lines in a row.");
  if (!(await loadConfirmEval(configPath)) || (await loadHosts(configPath, "evalHosts")).includes(host)) return;
  const run = `Run all ${lines.length} line${lines.length === 1 ? "" : "s"}`;
  const always = `Always run on ${host}`;
  const never = "Never ask again on approved sites";
  const choice = await choose(`Run this JavaScript in the ${host} tab?\n${code}`, [run, always, never, "Don't run"]);
  if (choice === always) await addHost(configPath, host, "evalHosts");
  else if (choice === never) await stopConfirmingEval(configPath);
  else if (choice !== run) throw new Error("The user did not allow this eval.");
}
