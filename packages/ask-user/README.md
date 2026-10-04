# Pi Ask User

A lean terminal-only `ask_user_question` tool. Phase 1 supports 1–8 questions with 2–8 options, single/multi-select, multiline custom answers, explicit review, and safe cancellation. Previews, notes, and hide/reopen follow in later phases.

- Tab / Shift+Tab: change question or open review.
- Up / Down: move through options; scroll the review.
- Space: toggle a multi-select option.
- Enter: choose a single option, confirm a multi-select answer, or open the custom-answer editor. Submission happens only from review, with every question answered.
- In the editor: Enter applies, Shift+Enter adds a newline, Esc leaves without applying. Uncommitted text remains available when reopened.
- Esc outside the editor requests cancellation. Existing answers or drafts require explicit **Discard answers** confirmation; **Keep editing** is the default.

Pi's configured selection and editor bindings apply. Custom text may accompany multi-select choices. Cancellation returns no drafts. RPC, JSON, and print runs do not expose the tool.

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

Run `/ask-user-demo core`, `/ask-user-demo single`, or `/ask-user-demo cancel`. These commands open the real questionnaire and display JSON without calling a model. No credentials are needed. Use a fresh temporary profile and `--tui-mode fullscreen` to check the other terminal mode.

The full user-run walkthrough is in [the plan](plans/ask-user.md#demo). Fixtures are not published. Do not load the old rpiv extension alongside this extension: both register `ask_user_question`. Do not install or switch global settings as part of verification.
