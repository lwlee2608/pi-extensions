# Notify Setup
**The Job** — `/notify setup`, an interactive TUI flow that creates and edits `pi-notify/config.json`: Telegram and shell-command connectors, plus `onPrompt` and `nerdFont`.
**The Why** — New users stall on hand-writing JSON before their first notification, and existing users must open the file for every later change. Both matter equally (issue #68).
**The Guardrail** — `config.json` stays the only config source and hand edits stay supported. Setup never displays an existing literal bot token, and arming plus `/notify on|off|test` behave as before.
**Done means** — From no config, `/notify setup` saves a working connector and `/notify test` delivers. Rerunning it changes settings without showing the stored token.

## Decisions
- **Interview depth** — key decisions only
- **Flow shape** — One menu of connectors and options on Pi's select dialog, with one small custom text input for every text field. A new user goes straight to adding a connector. Changes stay in a draft until Save; Esc in a sub-dialog goes back, and Cancel or Esc at the menu writes nothing
- **Existing connectors** — Add, edit, or remove any connector in the list. Save is blocked with zero connectors
- **Invalid existing config** — Malformed JSON, a non-object file, or a `connectors` value that is present but not an array: warn and write nothing; the user fixes it by hand. A parseable file with a bad connector opens normally so it can be fixed. A non-object connector entry is treated like an unsupported type, and a non-boolean option shows as off and stays unchanged unless toggled `agent`
- **Typing a literal bot token** — Masked by the custom input, while `$VARIABLE` references stay readable. Adds a pi-tui peer dependency to notify
- **Test send after Save** — Confirm dialog after Save, offered only when the saved config validates. It calls `send()` directly, because the `/notify test` path disarms on a config load failure. A command connector runs only on this explicit yes
- **Telegram chat ID help** — Hint text in the prompt only; no auto-detection through Telegram
- **Demo** — User runs it with a real bot and phone
- **Where does the plan live?** — `packages/notify/plans/`, matching other packages `research`
- **Can Pi's dialogs mask input?** — No. `ctx.ui.input` and pi-tui `Input` have no mask option; masking needs a small custom component through `ctx.ui.custom` `research`
- **Can Pi's dialogs prefill a value?** — `ctx.ui.input` has only a placeholder. `ctx.ui.editor` can prefill but takes no `signal`, so it cannot be closed on session reset. The custom input takes an initial value through `Input.setValue` `research`
- **Do Pi's dialogs stack?** — No. A new dialog replaces the current one and the old promise never resolves. That also leaves Pi's prompt depth above 0, so `ui_prompt_start` stops firing for every extension until the session resets. Nothing tells setup its dialog was replaced `research`
- **Does `/notify setup` fit the current command path?** — Not as is. `act()` loads and validates config first, so a missing or broken config would block setup. Setup must branch before that load `research`
- **Can setup reuse `parseConfig`?** — Not for editing. It returns resolved values, so saving its output would write `$VAR` secrets out as literals. Setup edits the raw JSON and uses `parseConfig` only to validate `research`
- **Setup during a run** — Refused with a warning while a run is active, because an agent dialog would replace setup's and hang it. This also means setup's own dialogs send no prompt pings, so no suppression is needed. A run started by another extension while setup is open is not handled
- **Reentry and session change** — A second `/notify setup` while open opens no dialog and shows a notice that `/reload` clears a setup the user cannot see, because the guard's practical trigger is a dialog already replaced. A session reset dismisses setup without writing `agent`
- **Arming state** — Setup does not change arming. After saving, the in-memory `nerdFont` and status refresh from the draft, since `loadConfig` throws on a config that is saved but invalid `agent`
- **Saving** — Atomic temp file and rename, file `0600`, new directory `0700`. A symlinked config is written through, not replaced `agent`
- **Concurrent edits** — No lock. If the file changed since setup opened, ask before overwriting `agent`
- **Fields setup does not manage** — Unknown top-level and connector keys survive a save. Unsupported connector types are listed and can only be removed `agent`
- **Invalid config at save** — Save runs `parseConfig` on the draft. Any failure, including an unset `$VAR` or a kept unsupported connector, asks for confirmation and warns that all notifications stay refused until it is fixed, because one bad connector fails the whole config. Declining returns to the menu. No value is shown, and no test is offered after saving `agent`
- **Literal bot token on edit** — Empty input keeps the stored token, and the literal is never prefilled. Chat IDs and `$VAR` values are prefilled `agent`
- **Command connector `run`** — Shown and prefilled, since only bot tokens are protected by issue #68 `agent`
- **Phase count** — 3, in sequence
- **Credential format checks** — Literal bot tokens and chat IDs are checked on entry using the same rules as `parseConfig`, and rejection messages never echo the value `agent`
- **Existing connectors before Phase 2** — Listed in the menu and preserved on Save, but not editable yet `agent`
- **Build mode** — Orchestrator; worker Opus 5.5 medium, reviewer Opus 5.5 high

## Progress
Active: none · 21/21 tasks

### Phase 1 — Create a working config from nothing
A new user can run `/notify setup`, add a Telegram or command connector, set options, save, and send a test without touching JSON.
**Blocked by:** none
- [x] Load raw config into an editable draft, and refuse malformed JSON, a non-object file, or a non-array `connectors` without writing (packages/notify/src/config.ts)
- [x] Save the draft atomically with owner-only permissions, writing through a symlinked config (packages/notify/src/config.ts)
- [x] Add a text input with an initial value and optional mask, masking literal tokens while `$VARIABLE` references stay readable (packages/notify/src/text-input.ts)
- [x] Add the pi-tui peer dependency (packages/notify/package.json)
- [x] Build the menu with connector rows, Add connector, option toggles, Save, and Cancel, opening on Add connector when the list is empty (packages/notify/src/setup.ts)
- [x] Prompt for Telegram and command connector fields, with chat ID hint text and format checks (packages/notify/src/setup.ts)
- [x] Block Save with zero connectors, and ask for confirmation on Save when the draft fails `parseConfig` (packages/notify/src/setup.ts)
- [x] Route `/notify setup` ahead of the config load and update the usage text and command description (packages/notify/src/index.ts)
- [x] Refuse `/notify setup` with a warning while a run is active (packages/notify/src/index.ts)
- [x] Refresh `nerdFont` and status from the draft after Save, then offer a test through `send()` only if the config validates (packages/notify/src/index.ts)
- [x] Test the flow with stubbed dialogs (packages/notify/test/setup.test.ts)
**Verify:** `npm test -w packages/notify` passes with new cases showing: from no config, driving the dialogs writes a file that `loadConfig` accepts, with mode `0600`; `$VAR` values are stored unexpanded; Cancel writes nothing; malformed JSON and a non-array `connectors` stay byte-identical; rendering the masked input never contains a literal token; declining the test sends nothing and accepting sends once; during a run, `/notify setup` warns and opens no dialog; saving with an unset `$VAR` or a kept unsupported connector requires confirmation, offers no test, and leaves `/notify on` armed.

### Phase 2 — Change an existing config without exposing the token
An existing user can edit or remove any connector from the menu, and the stored token stays hidden and intact.
**Blocked by:** 1
- [x] Edit Telegram connectors, where empty token input keeps the stored value, the literal is never prefilled, and chat IDs and `$VAR` values are prefilled (packages/notify/src/setup.ts)
- [x] Edit command connectors with `run` prefilled (packages/notify/src/setup.ts)
- [x] Remove connectors, and limit unsupported connector types to removal only (packages/notify/src/setup.ts)
- [x] Flag connectors that fail validation in the menu without showing their secrets (packages/notify/src/setup.ts)
- [x] Test edits against configs with literal tokens, `$VAR` values, and unknown keys (packages/notify/test/setup.test.ts)
**Verify:** `npm test -w packages/notify` passes with new cases showing: from a config with a literal token, no dialog title, option, prefill, notification, or masked render contains it; changing only the chat ID leaves the token, `$VAR` values, and unknown keys unchanged in the saved file; a connector with an unset `$VAR` opens and can be fixed; removing the last connector blocks Save.
**Note:** Paste prefill alters a multi-line `run`: `handlePaste` (`text-input.ts:19`) strips newlines and expands tabs, so a stored `printf a\nprintf\tb` becomes `printf aprintf    b` and Enter would silently save a different command, while `parseConfig` accepts multi-line `run`; the `run` edit must handle this, e.g. keep the stored value when input is unchanged, or treat a multi-line `run` as not editable.
**Note:** How the code refines two decisions. Literal bot token on edit: a chat ID that fails `validChatIdEntry` is hidden from the label and prefill, shows `(invalid)`, and must be retyped, so a token hand-placed in `chatId` can't show. Command connector `run`: a `run` containing any control character is Remove-only, the option the Note above allows.

### Phase 3 — Keep setup safe during session changes and concurrent edits
A user can use setup without lost edits or a half-open dialog, and the README explains it, including that setup is refused during a run.
**Blocked by:** 2
- [x] Refuse a second `/notify setup` while one is open, with a notice (packages/notify/src/index.ts)
- [x] Close setup without writing on session reset, including the custom input (packages/notify/src/setup.ts, packages/notify/src/index.ts)
- [x] Ask before overwriting when the file changed since setup opened (packages/notify/src/setup.ts)
- [x] Test each guard, including that arming state is unchanged by setup (packages/notify/test/setup.test.ts)
- [x] Document `/notify setup` and lead Configure with it, keeping the manual JSON docs (packages/notify/README.md)
**Verify:** `npm test -w packages/notify` passes with new cases showing: a second `/notify setup` while one is open opens no new dialog; session reset closes setup and leaves the file unchanged; changing the file after opening triggers a confirm, and declining leaves the outside edit intact; `/notify on` status is the same before and after setup.
**Note:** How the code refines Reentry and session change: the command handler returns while setup runs detached, because Pi's input loop awaits it, and a held handler behind a replaced dialog swallows every later input. Confirmed in real Pi.
**Note:** Known and not scheduled, from Phase 1 review. The run guard (`index.ts:75`) misses the time before `agent_start`, such as pre-prompt compaction; `!ctx.isIdle()` closes the compaction part only. `followSymlinks` (`config.ts:81`) resolves link text lexically, so a link like `sym/../config.json` can write to the wrong path; `realpath` first would fix it. The masked input's hidden cursor can move on left/right. From Phase 3 review: a hung setup leaves Pi's prompt depth raised, so `ui_prompt_start` stops firing and `onPrompt` pings silently stop while the session stays usable, until reset; aborting setup on `agent_start` could fix it but would change the "not handled" decision. A run can start with setup visible through queued input or CLI messages such as `pi "/notify setup" "do x"`; an agent dialog may then replace setup, and `/reload` clears it.

## Demo
User runs, with a real Telegram bot and phone:
1. `PI_CODING_AGENT_DIR=$(mktemp -d) pi -e ./packages/notify/src/index.ts`, then `/notify setup`; the flow opens on Add connector
2. Add a Telegram connector with a literal token and confirm it is masked while typing
3. Save and accept the test; the message arrives on the phone
4. Rerun `/notify setup`, change `onPrompt`, and save; the token is never shown and the next test still arrives
5. Add a command connector, then Cancel; `config.json` is unchanged
