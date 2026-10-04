# Pi Ask User

A lean terminal-only `ask_user_question` tool. Supports 1–8 questions with 2–8 options, single/multi-select, inline custom answers, Markdown previews, notes, review, and safe cancellation. Like Claude Code, it renders inline in place of Pi's input editor, so the transcript stays visible, and restores your editor text when done.

```
────────────────────────────────────────
←   ☒ Storage   ☐ Features   ✔ Submit   →

Which features should we include?

❯ 1. [✔] Search
  2. [ ] Export
  3. [ ] Type something.

Space toggle · Enter confirm · ↑/↓ navigate · Tab/←→ switch · n note · Esc cancel
```

- Tab / Shift+Tab or ← / →: change question or open review. Tabs appear only with more than one question.
- Up / Down: move through options or the review's Submit/Cancel choices.
- 1–9: pick an option directly. In multi-select this toggles it; the last number moves to the custom row.
- Ctrl+Up / Ctrl+Down: scroll question and option text without changing the focused option.
- Space: toggle a multi-select option. Only multi-select questions show checkboxes.
- Enter: choose a single option or the typed custom answer, or confirm a multi-select answer. A one-question batch submits on choice; larger batches submit from review once every question is answered.
- Custom row: type directly on `Type something.`, like Claude Code. There, digits, Space, and `n` are text and ←/→ move the text cursor; use Tab/Shift+Tab to switch questions. In multi-select, nonblank text checks the row as you type, so you can still toggle other options before confirming. Unconfirmed single-select text is kept but not submitted.
- In the note editor: Enter applies, Shift+Enter adds a newline, Esc leaves without applying. Uncommitted text remains available when reopened. Ctrl+] remains the editor's jump-forward action.
- `n`: edit a question note, or the global note from review. Saving an empty note clears it; Esc retains the draft without replacing a saved note.
- PageUp / PageDown: scroll the focused option's preview. Previews sit beside options on wide terminals and below them on narrow terminals; stacked previews appear only when the terminal is tall enough. Editing always uses the full width.
- Type-ahead guard: if you are still typing when the questionnaire opens, Enter, 1–9, Space, and `n` are ignored until you pause for 400 ms, so keystrokes meant for Pi's editor cannot answer a question. Esc and navigation work immediately.
- Esc outside the note editor requests cancellation. Existing answers or drafts require explicit **Discard answers** confirmation; **Keep editing** is the default.

Pi's configured selection and editor bindings apply. Custom actions read `pi-ask-user.note`, `pi-ask-user.previewUp`, and `pi-ask-user.previewDown` from Pi's keybindings, accepting a key string, an array of keys, or `[]` to disable. Defaults are `n`, `pageUp`, and `pageDown`. These IDs do not receive automatic conflict detection; avoid editor/navigation conflicts. Custom text may accompany multi-select choices. Cancellation returns no drafts. RPC, JSON, and print runs do not expose the tool.

## Local verification

From the repository root:

```sh
npm run check -w packages/ask-user
npm test -w packages/ask-user

repo="$PWD"
profile="$(mktemp -d)"
PI_CODING_AGENT_DIR="$profile" pi --offline --no-session --no-extensions \
  --no-skills --no-prompt-templates --no-context-files --no-approve \
  --tui-mode regular \
  -e "$repo/packages/ask-user/src/index.ts" \
  -e "$repo/packages/ask-user/test/fixtures/demo.ts"
```

Run `/ask-user-demo core`, `/ask-user-demo single`, `/ask-user-demo cancel`, or `/ask-user-demo rich`. Use `rich` to compare previews at 120 and 60 columns, attach question/global notes, and verify Esc preserves saved notes when a changed draft is abandoned. These commands open the real questionnaire and display JSON without calling a model. No credentials are needed. Use a fresh temporary profile and `--tui-mode fullscreen` to check the other terminal mode.

Run `/ask-user-demo limits` for eight questions with eight options each, long text, and Unicode. At a short terminal height, use Ctrl+Up/Down to inspect text, then submit; then cancel a new fixture and verify another opens normally.

The full user-run walkthrough is in [the repository plan](https://github.com/lwlee2608/pi-extensions/blob/main/packages/ask-user/plans/ask-user.md#demo). Fixtures are not published. Do not load the old rpiv extension alongside this extension: both register `ask_user_question`. Do not install or switch global settings as part of verification.

## Context budget and output

The description plus minified parameter schema is **796 characters** versus approximately 4,983 in rpiv 2.12.0: about 84% smaller. Prompt snippets and guidelines are omitted. The test caps the actual registered declaration at 1,800 characters. These are character counts, not exact tokenizer or provider-wire measurements.

Results contain `cancelled`, `answers`, and optional `globalNote`. Each answer contains a 1-based `questionIndex`, selected option labels, and optional `custom` and `notes`. Previews, repeated question text, and inactive drafts are excluded. Explicit cancellation returns exactly `{"cancelled":true,"answers":[]}`. Failure/abort is an error, not a user cancellation.

## Replace rpiv (user action after verification)

1. Remove or disable `npm:@juicesharp/rpiv-ask-user-question`. Never load both registrations together.
2. Install the local package with `pi install ./packages/ask-user`, or `pi install npm:@lwlee2608/pi-ask-user` after publication.
3. Start a fresh session. Review any separate user rules that still require rpiv's old question limits or schema; this package retains only the tool name, not exact API compatibility.
4. To roll back, remove/disable this package, restore rpiv, and start another fresh session.

The manifest advertises `pi-package` and a source extension entry point for Pi discovery. Publishing and switching packages are separate user actions, not part of verification. Follow the repository publishing instructions with tag `ask-user-v0.1.0`.

## Host compatibility

Requires Node.js 22.19+ and Pi 1.0.0+.
