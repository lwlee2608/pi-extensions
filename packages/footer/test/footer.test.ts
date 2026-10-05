import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatTokens, projectPath, renderFooter, summarize, type FooterSnapshot } from "../src/footer.ts";

const snapshot: FooterSnapshot = {
  model: "Opus 5.5", thinking: "high",
  context: { tokens: 280000, contextWindow: 700000, percent: 40 },
  totals: { cost: 17.37, cached: 23304400, fresh: 475600 },
  elapsed: 19000, cwd: "~/src/project", branch: "main", statuses: ["ready"],
};

test("renders the reference layout and project row", () => {
  assert.deepEqual(renderFooter(snapshot, 200), [
    "Opus 5.5 [high] [━━━━━━━━────────────] 40% 280k / 700k tokens • $17.37 (98% cached, 475.6k new) • 19s",
    "~/src/project (main) • ready",
  ]);
});

test("highlights only the filled context cells and preserves terminal widths", () => {
  const theme = {
    fg: (color: string, text: string) => `\u001b[${color === "text" ? "97" : "90"}m${text}\u001b[39m`,
  };
  const lines = renderFooter(snapshot, 200, theme);
  assert.ok(lines[0].includes("\u001b[97m━━━━━━━━\u001b[39m\u001b[90m────────────]"));
  assert.ok(lines[0].includes("\u001b[90m 40%"));
  assert.equal(lines[1], "\u001b[90m~/src/project (main) • ready\u001b[39m");
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
  assert.deepEqual([0, 999, 1000, 475600, 1000000].map(formatTokens), ["0", "999", "1k", "475.6k", "1000k"]);
  assert.deepEqual([0, 19999, 61000, 3661000].map(formatDuration), ["0s", "19s", "1m 1s", "1h 1m"]);
  assert.equal(projectPath("/home/me", "/home/me"), "~");
  assert.equal(projectPath("/home/me/project", "/home/me"), "~/project");
  assert.equal(projectPath("/home/me-too/project", "/home/me"), "/home/me-too/project");
  assert.equal(projectPath("/project", "/"), "/project");
});
