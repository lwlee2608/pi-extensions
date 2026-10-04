import assert from "node:assert/strict";
import test from "node:test";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, getCapabilities, setCapabilities, type TUI } from "@earendil-works/pi-tui";
import { theme } from "./helpers.ts";
import { Questionnaire } from "../src/questionnaire.ts";
import { parameters, description, validate } from "../src/schema.ts";
import { result, type Result } from "../src/result.ts";
import { QuestionnaireState } from "../src/state.ts";
import { core, rich } from "./fixtures/demo.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { Preview } from "../src/preview.ts";
import { actionKeys, actionMatches } from "../src/keys.ts";
import { display, editorDisplay } from "../src/display.ts";

initTheme("dark", false);

const down = "\x1b[B", up = "\x1b[A", enter = "\r", esc = "\x1b";
export function harness(params = core, rows = 30, bindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
  let output: Result | undefined;
  const terminal = { rows };
  const questionnaire = new Questionnaire(params, { terminal, requestRender() {} } as unknown as TUI, theme, bindings, value => { output = value; });
  questionnaire.focused = true;
  const input = (...keys: string[]) => keys.forEach(key => questionnaire.handleInput(key));
  return { questionnaire, terminal, input, output: () => output, text: (width = 90) => questionnaire.render(width).join("\n") };
}

test("schema bounds, blank and duplicate labels, optional fields, and full declaration budget", () => {
  validate(core);
  const question = core.questions[0];
  for (const count of [0, 9]) {
    assert.throws(() => validate({ questions: Array(count).fill(question) }));
    assert.throws(() => validate({ questions: [{ ...question, options: Array.from({ length: count }, (_, i) => ({ label: String(i) })) }] }));
  }
  assert.throws(() => validate({ questions: [{ ...question, options: [{ label: "only one" }] }] }));
  assert.throws(() => validate({ questions: [{ ...question, question: " \n" }] }));
  assert.throws(() => validate({ questions: [{ ...question, options: [{ label: " " }, { label: "B" }] }] }));
  assert.throws(() => validate({ questions: [{ ...question, options: [{ label: " A " }, { label: "A" }] }] }));
  validate({ questions: Array.from({ length: 8 }, () => ({ question: "Q", options: Array.from({ length: 8 }, (_, i) => ({ label: String(i), preview: "# Markdown" })) })) });
  assert.ok(description.length + JSON.stringify(parameters).length <= 1800);
  assert.match(description, /On cancellation, do not repeat the questions or assume answers/);
});

test("real component handles mixed selections, custom text, revisits, explicit review, and compact output", () => {
  const h = harness();
  h.input(enter); // SQLite
  h.input(" ", down, " ", down, down, enter); // Search + Export, open custom editor
  h.input("Offline mode", enter);
  assert.equal(h.questionnaire.state.tab, 2);
  assert.equal(h.output(), undefined);
  h.input("\t", down, enter); // revisit and select PostgreSQL
  h.input("\t", enter);
  assert.deepEqual(h.output(), { cancelled: false, answers: [
    { questionIndex: 1, selected: ["PostgreSQL"] },
    { questionIndex: 2, selected: ["Search", "Export"], custom: "Offline mode" },
  ] });
});

test("one question still requires review and missing questions block submission", () => {
  const h = harness({ questions: core.questions.slice(0, 1) });
  h.input("\t", enter);
  assert.equal(h.output(), undefined);
  assert.match(h.text(), /Unanswered/);
  h.input("\t", enter);
  assert.equal(h.questionnaire.state.tab, 1);
  assert.equal(h.output(), undefined);
  h.input(enter);
  assert.equal(h.output()?.answers.length, 1);
});

test("untouched cancel is immediate; work requires explicit discard and keep preserves drafts", () => {
  const untouched = harness(); untouched.input(esc);
  assert.deepEqual(untouched.output(), { cancelled: true, answers: [] });
  const h = harness();
  h.input(down, down, enter, "draft", esc, esc);
  assert.match(h.text(), /> Keep editing/);
  assert.equal(h.output(), undefined);
  h.input(enter, esc, esc); // keep, request, escape confirmation
  assert.equal(h.questionnaire.state.answers[0].draft, "draft");
  h.input(enter, enter); // reopen draft and save
  assert.equal(h.questionnaire.state.answers[0].custom, "draft");
  h.input(esc, down, enter);
  assert.deepEqual(h.output(), { cancelled: true, answers: [] });
});

test("single-select inactive custom text is retained but never returned", () => {
  const state = new QuestionnaireState(core.questions.slice(0, 1));
  state.saveCustom(0, "  custom answer  ");
  state.select(0, 0);
  assert.equal(state.answers[0].draft, "  custom answer  ");
  assert.equal(state.hasWork(), true);
  assert.deepEqual(result(state), { cancelled: false, answers: [{ questionIndex: 1, selected: ["SQLite"] }] });
  state.answers[0].selected.clear();
  assert.equal(state.hasWork(), true);
  assert.throws(() => result(state), /Every question/);
});

test("Editor supports multiline drafts and focus; render fits narrow widths, height, and resize", () => {
  const h = harness({ questions: [{ question: "界".repeat(60), options: [{ label: "A".repeat(80) }, { label: "B" }] }] });
  h.input(down, down, enter, "first", "\n", "second");
  assert.equal(h.questionnaire.state.answers[0].draft, "first\nsecond");
  assert.match(h.text(), /\x1b_pi:c\x07/);
  h.questionnaire.focused = false;
  assert.doesNotMatch(h.text(), /\x1b_pi:c\x07/);
  h.questionnaire.focused = true;
  for (const rows of [4, 10, 30]) {
    h.terminal.rows = rows;
    for (const width of [1, 4, 20, 60, 120]) {
      h.questionnaire.invalidate();
      const lines = h.questionnaire.render(width);
      assert.ok(lines.length <= rows - 2);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
    }
  }
  h.input(enter);
  assert.equal(h.questionnaire.state.answers[0].custom, "first\nsecond");
});

test("untrusted terminal controls are removed for display, not answer values", () => {
  const attack = "\x1b]52;c;YXR0YWNr\x07\x1b[2J\x1bPmalicious\x1b\\";
  const h = harness({ questions: [{ question: attack + "Question", header: attack + "Header", options: [{ label: attack + "A", description: attack + "Description" }, { label: "B" }] }] });
  assert.doesNotMatch(h.text(), /\x1b\]|\x1bP|\x1b\[2J|malicious/);
  h.input(enter, enter);
  assert.equal(h.output()?.answers[0].selected[0], attack + "A");
  assert.equal(display(attack + "safe\ntext"), "safe\ntext");
});

test("editor sanitization preserves visible cursor and headers remain single-line", () => {
  const h = harness({ questions: [{ ...core.questions[0], header: "First\nSecond\tThird" }] });
  assert.ok(h.questionnaire.render(90).every(line => !/[\n\t]/.test(line)));
  h.input(down, down, enter, "abc", "\x1b[D");
  assert.match(h.text(), /\x1b\[7m/);
  assert.equal(editorDisplay("\x1b]52;c;attack\x07\x1b[2J\x1b[7mx\x1b[0m"), "\x1b[7mx\x1b[0m");
});

test("all long question and description lines can be read without moving selection", () => {
  const text = Array.from({ length: 50 }, (_, i) => `Line-${i}`).join("\n");
  const h = harness({ questions: [{ question: text, options: [{ label: "A", description: text }, { label: "B" }] }] }, 10);
  const seen = new Set<string>();
  for (let i = 0; i < 120; i++) {
    for (const match of h.text(40).matchAll(/Line-\d+/g)) seen.add(match[0]);
    h.input("\x1b[1;5B");
  }
  assert.equal(seen.size, 50);
  assert.equal(h.questionnaire.state.answers[0].cursor, 0);
  for (let i = 0; i < 120; i++) h.input("\x1b[1;5A");
  assert.match(h.text(40), /Line-0\n/);
});

test("undo history never crosses question boundaries", () => {
  const h = harness();
  h.input(down, down, enter, "private Q1", esc, "\t", down, down, down, enter, "\x1f");
  assert.equal(h.questionnaire.state.answers[1].draft, "");
  assert.equal(h.questionnaire.state.answers[0].draft, "private Q1");
});

test("responsive previews work in both selection modes, scroll, resize, and invalidate", () => {
  const h = harness(rich);
  for (const tab of [0, 1]) {
    h.questionnaire.state.tab = tab;
    const wide = h.text(120);
    assert.match(wide, /│/);
    assert.match(wide, /Preview 1–/);
    h.input("\x1b[6~");
    assert.doesNotMatch(h.text(120), /Preview 1–/);
    h.input("\x1b[5~");
    assert.match(h.text(60), /Preview 1–/);
    assert.doesNotMatch(h.text(60), /│/);
    for (const width of [1, 4, 20, 60, 120]) {
      assert.ok(h.questionnaire.render(width).every(line => visibleWidth(line) <= width));
    }
    h.questionnaire.invalidate();
    assert.match(h.text(120), /Preview/);
    h.input("n", "x".repeat(70));
    assert.doesNotMatch(h.text(120), /Preview/);
    assert.match(h.text(120), new RegExp("x".repeat(70)));
    h.input(esc);
  }
});

test("Markdown link destinations remain visible with terminal hyperlinks enabled", () => {
  const capabilities = getCapabilities();
  setCapabilities({ ...capabilities, hyperlinks: true });
  try {
    const preview = new Preview();
    preview.setText("See [documentation](https://example.com/docs).");
    const lines = preview.render(80, 10);
    assert.match(lines.join("\n"), /https:\/\/example.com\/docs/);
    assert.match(lines.join("\n"), /documentation/);
    assert.doesNotMatch(lines.join("\n"), /\x1b\]8/);
    assert.ok(preview.render(10, 20).every(line => visibleWidth(line) <= 10));
  } finally { setCapabilities(capabilities); }
});

test("saved notes and global note appear in review/results, drafts and previews do not", () => {
  const h = harness(rich);
  h.input("n", "Prefer simpler operations", enter, enter);
  h.input(" ", enter, "n", "Ship incrementally", enter);
  assert.match(h.text(), /Global note: Ship incrementally/);
  h.input("\t", "n", "\x01", "\x0b", "not saved", esc, "\t", "\t");
  assert.match(h.text(), /Prefer simpler operations/);
  assert.doesNotMatch(h.text(), /not saved/);
  h.input(enter);
  assert.equal(h.output()?.answers[0].notes, "Prefer simpler operations");
  assert.equal(h.output()?.globalNote, "Ship incrementally");
  assert.doesNotMatch(JSON.stringify(h.output()), /not saved|Detail|preview|Which/);
});

test("notes alone never answer questions and require discard confirmation, including global drafts", () => {
  for (const global of [false, true]) {
    const h = harness();
    if (global) h.input("\t", "\t");
    h.input("n", "note draft", esc, esc);
    assert.match(h.text(), /Discard all answers/);
    assert.equal(h.questionnaire.state.complete(), false);
    h.input(esc, "n", enter); // save existing draft
    h.input("n", "\x01", "\x0b", enter); // clear optional note
    assert.equal(h.questionnaire.state.hasWork(), false);
    h.input(esc);
    assert.deepEqual(h.output(), { cancelled: true, answers: [] });
  }
});

test("custom-action defaults, string/array overrides, disabled bindings, and editor ownership", () => {
  const keys = new KeybindingsManager(TUI_KEYBINDINGS, { "pi-ask-user.note": ["ctrl+n", "alt+n"], "pi-ask-user.previewDown": "ctrl+d", "pi-ask-user.previewUp": [] });
  assert.deepEqual(actionKeys(keys, "pi-ask-user.previewUp"), []);
  assert.deepEqual(actionKeys(keys, "pi-ask-user.previewDown"), ["ctrl+d"]);
  assert.equal(actionMatches(keys, "pi-ask-user.note", "\x0e"), true);
  const h = harness(rich, 30, keys);
  h.text(); h.input("\x04");
  assert.doesNotMatch(h.text(), /Preview 1–/);
  h.input("\x1b[5~");
  assert.doesNotMatch(h.text(), /Preview 1–/);
  h.input("n"); assert.doesNotMatch(h.text(), /Question note/);
  h.input("\x0e", "note"); assert.match(h.text(), /Question note/);
  assert.equal(h.questionnaire.state.answers[0].noteDraft, "note");
});

test("uses remapped built-in navigation and preserves Ctrl+] in the Editor", () => {
  const h = harness(core, 30, new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n" }));
  h.input("\x0e", "\x0e", enter, "a b c", "\x01", "\x1d", "c", "X");
  assert.equal(h.questionnaire.state.answers[0].draft, "a b Xc");
  assert.equal(h.output(), undefined);
  h.input(esc, up);
});
