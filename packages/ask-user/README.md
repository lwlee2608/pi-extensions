# Pi Ask User

A lean terminal-only `ask_user_question` tool. Supports 1–8 questions with 2–8 options, single/multi-select, multiline custom answers, Markdown previews, notes, explicit review, and safe cancellation. Hide/reopen follows in Phase 3.

- Tab / Shift+Tab: change question or open review.
- Up / Down: move through options; scroll the review.
- Ctrl+Up / Ctrl+Down: scroll question and option text without changing the focused option.
- Space: toggle a multi-select option.
- Enter: choose a single option, confirm a multi-select answer, or open the custom-answer editor. Submission happens only from review, with every question answered.
- In the editor: Enter applies, Shift+Enter adds a newline, Esc leaves without applying. Uncommitted text remains available when reopened.
- `n`: edit a question note, or the global note from review. Saving an empty note clears it; Esc retains the draft without replacing a saved note.
- PageUp / PageDown: scroll the focused option's preview. Previews sit beside options on wide terminals and below them on narrow terminals; editing always uses the full pane.
- Esc outside the editor requests cancellation. Existing answers or drafts require explicit **Discard answers** confirmation; **Keep editing** is the default.

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

The full user-run walkthrough is in [the plan](plans/ask-user.md#demo). Fixtures are not published. Do not load the old rpiv extension alongside this extension: both register `ask_user_question`. Do not install or switch global settings as part of verification.
