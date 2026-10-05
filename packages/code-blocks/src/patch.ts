import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

type Token = { type: string; text?: string; lang?: string };
type Renderer = (this: { theme: MarkdownTheme }, token: Token, width: number, next?: string, style?: unknown) => string[];
const owner = Symbol.for("@lwlee2608/pi-code-blocks/patch");

function probeTheme(): MarkdownTheme {
  const identity = (text: string) => text;
  return {
    heading: identity, link: identity, linkUrl: identity, code: identity,
    codeBlock: identity, codeBlockBorder: identity, quote: identity,
    quoteBorder: identity, hr: identity, listBullet: identity, bold: identity,
    italic: identity, strikethrough: identity, underline: identity,
  };
}

export function installPatch(color: (text: string) => string): () => void {
  // Pi exposes this TypeScript-private method at runtime, but gives it no API guarantee.
  const prototype = Markdown.prototype as unknown as { renderToken?: Renderer & { [owner]?: () => boolean } };
  const original = prototype.renderToken;
  if (typeof original !== "function" || original[owner]?.()) {
    throw new Error("Markdown renderer is unavailable or already patched.");
  }
  const probe = new Markdown("```text\nprobe\n```", 0, 0, probeTheme()).render(20).map(line => line.trimEnd());
  if (JSON.stringify(probe) !== JSON.stringify(["```text", "  probe", "```"])) {
    throw new Error("Markdown renderer is incompatible; leaving code blocks unchanged.");
  }

  let active = true;
  const patched: Renderer & { [owner]?: () => boolean } = function (token, width, next, style) {
    const lines = original.call(this, token, width, next, style);
    if (!active || token.type !== "code" || typeof token.text !== "string") return lines;
    const content = token.text.split("\n");
    const closing = content.length + 1;
    if (lines[0] !== this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`) ||
        lines[closing] !== this.theme.codeBlockBorder("```")) return lines;

    const language = token.lang?.trim().toLowerCase();
    const plain = !language || ["text", "txt", "plaintext", "plain"].includes(language);
    const body = plain
      ? content.map(line => (this.theme.codeBlockIndent ?? "  ") + color(line))
      : lines.slice(1, closing);
    return [...body, ...lines.slice(closing + 1)];
  };
  patched[owner] = () => active;
  prototype.renderToken = patched;
  return () => {
    active = false;
    if (prototype.renderToken === patched) prototype.renderToken = original;
  };
}
