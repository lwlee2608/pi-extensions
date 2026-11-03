import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, projectPath, renderFooter, summarize, type FooterSnapshot } from "../src/footer.ts";

const snapshot: FooterSnapshot = {
  provider: "anthropic", model: "opus-5-5", thinking: "high",
  context: { tokens: 280000, contextWindow: 700000, percent: 40 },
  totals: { cost: 17.37, cached: 23304400, fresh: 475600 },
  elapsed: 19000, cwd: "~/src/project", branch: "main", statuses: ["ready"],
};

test("renders the reference layout and project row", () => {
  assert.deepEqual(renderFooter(snapshot, 200), [
    "(anthropic) opus-5-5 [high] [━━━━━━━━────────────] 40% 280k / 700k tokens • $17.37 (98% cached, 475.6k new) • 19s",
    "~/src/project (main) • ready",
  ]);
});

test("highlights model, context usage, and cost; greys provider; accents branch; colors context pressure and thinking level, preserving terminal widths", () => {
  const codes: Record<string, number> = { text: 97, dim: 90, warning: 33, error: 31, accent: 36, thinkingHigh: 35 };
  const fg = (color: string, text: string) => `\u001b[${codes[color]}m${text}\u001b[39m`;
  const theme = { fg, getThinkingBorderColor: (level: string) => (text: string) => fg(`thinking${level[0].toUpperCase()}${level.slice(1)}`, text) };
  const at = (percent: number) => renderFooter({ ...snapshot, context: { ...snapshot.context, percent } }, 200, theme)[0];
  const lines = renderFooter(snapshot, 200, theme);
  assert.ok(lines[0].startsWith("\u001b[90m(anthropic) \u001b[39m\u001b[97mopus-5-5\u001b[39m"));
  assert.ok(lines[0].includes("\u001b[35mhigh\u001b[39m"));
  assert.ok(lines[0].includes("\u001b[97m$17.37\u001b[39m"));
  assert.ok(lines[0].includes("\u001b[97m━━━━━━━━\u001b[39m\u001b[90m────────────]"));
  assert.ok(lines[0].includes("\u001b[97m40%\u001b[39m\u001b[90m \u001b[39m\u001b[97m280k\u001b[39m\u001b[90m / 700k tokens"));
  assert.ok(at(70).includes("\u001b[97m70%"));
  assert.ok(at(80).includes("\u001b[33m━━━━━━━━━━━━━━━━\u001b[39m") && at(80).includes("\u001b[33m80%"));
  assert.ok(at(95).includes("\u001b[31m━━━━━━━━━━━━━━━━━━━\u001b[39m") && at(95).includes("\u001b[31m95%"));
  assert.equal(lines[1], "\u001b[90m~/src/project (\u001b[39m\u001b[36mmain\u001b[39m\u001b[90m) • ready\u001b[39m");
  for (const width of [0, 1, 16, 20, 30, 40, 80, 200]) {
    for (const line of renderFooter(snapshot, width, theme)) {
      assert.ok(visibleWidth(line) <= width);
    }
  }
});

test("unknown context remains unknown after compaction; progress is bounded", () => {
  const unknown = renderFooter({ ...snapshot, context: { tokens: null, percent: null, contextWindow: 700000 } }, 200)[0];
  assert.match(unknown, /\?% \? \/ 700k/);
  assert.match(renderFooter({ ...snapshot, context: { ...snapshot.context, percent: 120 } }, 200)[0], /\[━━━━━━━━━━━━━━━━━━━━\] 100%/);
  assert.match(renderFooter({ ...snapshot, context: { ...snapshot.context, percent: -10 } }, 200)[0], /\[────────────────────\] 0%/);
});

test("lines fit narrow terminals, Unicode, and ANSI statuses", () => {
  const data = { ...snapshot, model: "模型 🤖", cwd: "/项目\nname", statuses: ["\u001b[32mready\u001b[0m", "a\nb\tc"] };
  for (const width of [0, 1, 2, 10, 40, 80, 120, 200]) {
    const lines = renderFooter(data, width);
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width);
      assert.doesNotMatch(line, /[\n\r\t]/);
    }
  }
  assert.equal(renderFooter({ ...snapshot, branch: null, statuses: [] }, 200)[1], "~/src/project");
});

test("sums all billable entry kinds, including tool and summary usage", () => {
  const usage = { input: 10, output: 20, cacheRead: 80, cacheWrite: 10, cost: { total: 0.25 } };
  const entries = [
    { type: "message", message: { role: "assistant", usage } },
    { type: "message", message: { role: "toolResult", usage } },
    { type: "usage", usage }, { type: "compaction", usage }, { type: "branch_summary", usage },
    { type: "message", message: { role: "user" } },
    { type: "message", message: { role: "toolResult" } }, { type: "compaction" },
    { type: "custom" },
  ] as unknown as SessionEntry[];
  assert.deepEqual(summarize(entries), { cost: 1.25, cached: 400, fresh: 100 });
  assert.deepEqual(summarize([]), { cost: 0, cached: 0, fresh: 0 });
  assert.match(renderFooter({ ...snapshot, totals: summarize([]) }, 200)[0], /\$0.00 \(0% cached, 0 new\)/);
});

test("formats tokens, elapsed time, and home-relative paths", () => {
  assert.deepEqual([0, 999, 1000, 475600, 1000000, 12345600].map(formatTokens), ["0", "999", "1k", "475.6k", "1M", "12.3M"]);
  assert.deepEqual([0, 19999, 61000, 3661000].map(formatDuration), ["0s", "19s", "1m 1s", "1h 1m"]);
  assert.equal(projectPath("/home/me", "/home/me"), "~");
  assert.equal(projectPath("/home/me/project", "/home/me"), "~/project");
  assert.equal(projectPath("/home/me-too/project", "/home/me"), "/home/me-too/project");
  assert.equal(projectPath("/project", "/"), "/project");
});
