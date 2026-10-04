# Lean ask-user extension

**The Job** — Build `@lwlee2608/pi-ask-user`, an independent structured-questionnaire extension with a small model-facing declaration.
**The Why** — Replace repeated tool instructions while keeping multi-select, custom answers, previews, notes, and access to the transcript.
**The Guardrail** — Do not change installed extensions or global Pi settings during implementation. Do not depend on rpiv packages. Publishing and switching extensions require a separate user action.
**Done means** — The selected flows work locally in both terminal modes, automated checks protect behavior and declaration size, and the package is ready for the user to replace the old extension.

## Decisions

### Package and runtime
- **Package** — `@lwlee2608/pi-ask-user`, version `0.1.0`, under `packages/ask-user`. Keep the tool name `ask_user_question`; do not promise exact rpiv input/output compatibility.
- **Repository conventions** — TypeScript source loaded directly by Pi, `.ts` local imports, Node's test runner, workspace scripts, host-provided Pi/TypeBox peer dependencies, package-local plans, and the existing CI/publishing workflow. No new runtime dependency is needed. `research`
- **Hosts** — Terminal only, both regular and fullscreen modes. Register during extension load, then on `session_start` remove only this tool from `pi.getActiveTools()` via `pi.setActiveTools()` when `ctx.mode !== "tui"`. Repeat the exclusion in `before_agent_start` as a backstop. Preserve other active tools and do not reactivate this tool in TUI if the user disabled it. Guard execution with `ctx.mode === "tui"`, not `ctx.hasUI` (which is also true in RPC). An unavailable UI is an error, not user cancellation.
- **Runtime API** — Pi 1.0.0 supports `exposure: "model-only"` and `executionMode: "sequential"`. Use these so nested tools cannot invoke the questionnaire and sibling calls do not open concurrent questionnaires. `research`
- **Isolation** — Separate input validation and answer state from Pi lifecycle and terminal rendering. Keep interaction state in memory for one call; no settings file, background process, or cross-session persistence.

### Model-facing contract
- **Budget** — At most 1,800 characters across description, minified JSON parameter schema, prompt snippet, and guidelines. Test the actual registered declaration. Omit prompt snippet and guidelines; do not inject equivalent rules through events. Provider formatting is outside this measurement.
- **Baseline** — Installed rpiv 2.12.0 uses approximately 4,983 characters for those fields. The new cap is approximately 64% smaller; 450 versus 1,246 tokens using characters/4 is only an estimate. `research`
- **Usage guidance** — A short description says to ask for blocking user decisions, batch related questions, and put recommended choices first. Include only necessary non-schema semantics, such as automatically provided custom answers. Include: "On cancellation, do not repeat the questions or assume answers; explain any blocking decision and wait." Cancellation does not mean rejection of the task or proposed options. Keep this guidance within the declaration budget. Do not explain keyboard controls or layout to the model.
- **Parameters** — `questions` contains 1–8 questions. Each has `question`, optional `header`, 2–8 `options`, and optional `multiSelect` (default false). Options have `label`, optional `description`, and optional Markdown `preview`.
- **Display limits** — Do not retain rpiv's 16-character header or 60-character label limits. Default omitted headers to Q1, Q2, etc. Wrap/scroll content and truncate only navigation labels where needed.
- **Validation** — Enforce array bounds and nonblank questions/option labels; reject duplicate option labels within a question because results identify selections by label. Keep schema descriptions terse and use schema constraints rather than repeated prose. Runtime-owned rows use internal identities, not label comparisons; no inherited rpiv reserved-label compatibility requirement.
- **Results** — Return compact JSON text with `cancelled`, `answers`, and optional `globalNote`. Each submitted answer contains a 1-based `questionIndex`, `selected` labels (an empty array for custom-only answers), optional `custom`, and optional `notes`. Omit empty optional fields. Do not echo question text, previews, or inactive drafts. UI details and transcript rendering may retain question context separately.
- **Cancellation** — Return `{ "cancelled": true, "answers": [] }` only after explicit user cancellation, including discard confirmation when work exists. Do not include draft answers or notes. Runtime failure/abort must remain distinct from an explicit user cancellation and must clean up the UI.

### Interaction
- **Batch flow** — Tabs for questions plus a review tab. Users can revisit answers and retain drafts. Require every question answered and explicit review/submission, including a one-question batch.
- **Single-select** — Select one authored option or use a custom answer. Only the active answer is submitted; switching modes does not erase the inactive text draft.
- **Multi-select** — Allow selected options plus a custom typed answer. A question is answered with at least one selected option or nonblank custom text. Notes alone do not answer a question.
- **Custom answers** — Always provide a built-in custom-answer row; no input flag is needed. Use Pi's multiline Editor.
- **Notes** — Allow per-answer notes and one global note on the review tab. Use the same editor behavior as custom answers.
- **Editing** — Enter applies the draft, Shift+Enter adds a newline, Esc returns without applying changes. Retain uncommitted drafts for reopening. Saving an empty optional note clears it. No external-editor launch in v1.
- **Previews** — Available for single- and multi-select. Show the focused option's Markdown preview. Use side-by-side layout when there is room and stack below options when narrow. Support scrolling; do not fetch remote resources. Text editing gets the usable pane width rather than remaining cramped beside a preview.
- **Keyboard** — Defaults: Tab/Shift+Tab change tabs; arrows move through options; Space toggles multi-select; Enter confirms/advances; `n` edits a question/global note; Alt+h hides/reopens; Esc leaves editing or requests questionnaire cancellation. On the custom-answer row, Enter opens its editor. PageUp/PageDown scroll the preview when browsing; editing retains editor bindings. Respect Pi navigation bindings and provide remappable extension actions for notes, hide/reopen, and preview scrolling. Footer hints reflect active bindings.
- **Cancellation safeguard** — Outside a text editor, Esc cancels immediately only if no selected answers, saved custom text, notes, or nonempty drafts exist anywhere in the batch. Include inactive and uncommitted drafts in this check. Otherwise show **Keep editing / Discard answers**, defaulting to Keep editing. Esc or Keep editing dismisses the confirmation without changing any state; only an explicit Discard answers confirms cancellation. Esc inside a text editor retains its existing leave-without-applying behavior. Abort/shutdown cleanup does not wait for confirmation. This supersedes immediate cancellation with existing work and updates Phase 1, Phase 2 note coverage, and demo step 7.
- **Key resolution** — Follow `packages/model-plus/src/menu.ts`'s custom-action pattern: read namespaced IDs from `keybindings.getUserBindings()`, use extension defaults only for undefined entries, normalize string/array overrides, and match with `matchesKey()`. Honor empty arrays as disabled bindings. Derive footer hints from the resolved keys. Pi's supplied manager does not register these custom IDs; do not call its `matches()` for them or claim automatic conflict detection. Use its standard matching for built-in navigation actions. `research`
- **Review** — Show selections, custom text, and notes. Identify missing answers and block submission until complete. Confirming a question advances to the next question or review; selecting a checkbox alone does not advance.
- **Shortcut correction** — Alt+h replaces the previously approved Ctrl+] default because Pi binds Ctrl+] to `tui.editor.jumpForward`. Alt+h is unused in the inspected Pi defaults; user bindings and other extensions can still conflict. With the default configuration, pass Ctrl+] unchanged to both the questionnaire editor and Pi's main editor while the dialog is hidden. This amends Phase 3's shortcut/tests and demo step 6; the phase order and scope do not change.
- **Hide/reopen** — Alt+h toggles the dialog even during text editing. Use a scoped `ctx.ui.onTerminalInput` listener and the resolved custom-action keys; hidden overlays receive no normal component input. Do not rely on a fixed `registerShortcut` registration for remapping. Consume the toggle once, pass unrelated input through, and remove the listener when the interaction ends. If the toggle has no resolved keys, disable hiding so the dialog cannot become unreachable. Preserve active tab, selections, editor drafts, and scroll positions. While hidden, permit transcript navigation and keep the tool pending. Restore with the configured shortcut. Do not steal input from another focused overlay. Ignore key-release/repeat events for the toggle.
- **Lifecycle** — Resolve/dispose each interaction once. Remove raw-input/abort listeners on completion, cancellation, abort, reload, and shutdown. Restore focus and do not leave hidden pending questionnaires after teardown.
- **Terminal correctness** — Use Pi width, Markdown, Editor, focus, and theme utilities. Test narrow/short terminals, resize, Unicode, multiline text, theme invalidation, and focus propagation. Never emit lines wider than the available columns.

### Scope and delivery
- **Not included** — RPC fallback, external-editor integration, localization, rpiv event compatibility, a separate configuration file, terminal-bell notifications, mouse-specific controls, persistent drafts, or an output schema solely for programmatic callers.
- **Phases** — Three, as approved below. Sequential: the phases share questionnaire state, rendering, and integration files, so parallel implementation would add conflicts.
- **Demo** — User-run deterministic walkthrough in an isolated profile. No model calls or credentials. A development-only command opens the same questionnaire runner as the real tool and displays its result; automated integration tests exercise tool registration and execution. The fixture is not published.

## Progress
Phase 1 of 3 · 0/14 tasks. Planning complete; implementation not started.

### Phase 1 — Answer a batch without repeated model instructions
Users can answer single/multi-select questions, type custom answers, revisit tabs, review, submit, or cancel.

- [ ] Add package metadata, TypeScript configuration, license, root extension registration, and workspace lockfile entry (`packages/ask-user/package.json`, `packages/ask-user/tsconfig.json`, `packages/ask-user/LICENSE`, root `package.json`, `package-lock.json`).
- [ ] Define the final lean input contract, validation, and compact result formatting (`packages/ask-user/src/schema.ts`, `packages/ask-user/src/result.ts`). Keep the full schema budgeted from the start, including the preview field used in phase 2.
- [ ] Implement answer/draft state, confirmation before discarding work, and the usable tabbed selection/custom-answer/review flow (`packages/ask-user/src/state.ts`, `packages/ask-user/src/questionnaire.ts`).
- [ ] Register the tool with event-based terminal-only exclusion, an execution mode guard, serialized execution, abort cleanup, and concise call/result rendering (`packages/ask-user/src/index.ts`).
- [ ] Add deterministic core/single/cancel fixtures and focused schema, state, rendering, declaration-budget, and lifecycle tests (`packages/ask-user/test/fixtures/demo.ts`, `packages/ask-user/test/*.test.ts`). Document the phase's local fixture command in `packages/ask-user/README.md`.

**Verify:** `npm run check -w packages/ask-user && npm test -w packages/ask-user`. Tests must prove array bounds, invalid/duplicate labels, declaration size ≤1,800, no injected prompt rules, mixed multi-select/custom answers, complete-only submission, single-question review, immediate cancellation of an untouched batch, confirmation for selected answers or saved/inactive/uncommitted drafts, state preservation on Keep editing/Esc, and no drafts in confirmed cancellation results. Verify cancellation guidance remains within the declaration budget. Verify abort cleanup, exclusion in RPC/JSON/print on session start and before agent start, rejection of direct non-TUI execution, preservation of other tools, and no forced TUI reactivation. Run the isolated demo launcher below with `/ask-user-demo core`, `/ask-user-demo single`, and `/ask-user-demo cancel`; the first fixture must return the selected labels and custom text, the second must still require review, and the third must return only the cancellation envelope. Preview/notes fixture behavior belongs to phase 2.

### Phase 2 — Compare options and explain decisions
Users can inspect rich previews and attach notes without adding model prompt overhead.

- [ ] Add responsive Markdown previews and bounded scrolling in both selection modes (`packages/ask-user/src/preview.ts`, `packages/ask-user/src/questionnaire.ts`).
- [ ] Add per-answer/global note editing and review display, with saved values separate from uncommitted drafts (`packages/ask-user/src/state.ts`, `packages/ask-user/src/questionnaire.ts`).
- [ ] Include submitted notes in compact model results while keeping previews and inactive drafts out (`packages/ask-user/src/result.ts`, `packages/ask-user/src/index.ts`).
- [ ] Extend fixtures, keyboard/rendering tests, and usage documentation for previews, notes, Unicode, and resize (`packages/ask-user/test/fixtures/demo.ts`, `packages/ask-user/test/*.test.ts`, `packages/ask-user/README.md`).

**Verify:** `npm run check -w packages/ask-user && npm test -w packages/ask-user`. Tests must prove previews for both modes, width-safe stacked/wide layouts, preview scrolling, full-width editing, saved-versus-draft notes, global notes, discard confirmation for note-only work (including uncommitted global notes), theme invalidation, and no preview echo in result content. Verify custom-action string/array overrides and disabled bindings follow the model-plus resolver pattern. In `/ask-user-demo rich`, compare previews at 120 and 60 columns, add notes, edit and cancel a changed note, and confirm only the saved notes appear in the result.

### Phase 3 — Read the transcript and return safely
Users can hide/reopen the dialog without losing work, and can install the independently packaged extension when ready.

- [ ] Add remappable hide/reopen behavior and lifecycle-safe overlay input ownership (`packages/ask-user/src/questionnaire.ts`, `packages/ask-user/src/index.ts`).
- [ ] Add regression tests for hidden-state restoration, focus conflicts, remapped keys, Ctrl+] passthrough in both editors under the default configuration, key repeat/release, abort while hidden, shutdown, and idempotent cleanup (`packages/ask-user/test/*.test.ts`).
- [ ] Complete the deterministic maximum-size fixture and final walkthrough documentation (`packages/ask-user/test/fixtures/demo.ts`, `packages/ask-user/README.md`).
- [ ] Verify package contents and document discovery, context-budget measurement, and replacement/rollback instructions (`packages/ask-user/test/package.test.ts`, `packages/ask-user/README.md`, root `README.md`).
- [ ] Run all workspace checks, tests, and package dry runs; record results and leave installation/publishing to the user (`packages/ask-user/plans/ask-user.md`).

**Verify:** `npm run check && npm test && npm pack --dry-run --ignore-scripts --workspaces`. Tests must prove exactly-once cleanup of the scoped terminal listener, remapped-key reopening while hidden, unrelated-key passthrough, disabled-toggle protection against unreachable hidden dialogs, no draft loss across Alt+h hide/reopen while editing, and unchanged Ctrl+] jump-forward behavior in the questionnaire editor and main editor while hidden under the default configuration. Also verify correct package entry points and exclusion of fixtures from the tarball. Run `/ask-user-demo rich` and `/ask-user-demo limits` in both terminal modes, hide while editing, read the transcript, reopen, and finish. After cancellation, start another fixture and confirm no stale listener or hidden overlay intercepts input.

## Demo

After all phases, the user runs these steps from the repository root. The fixture command is development-only and uses the production questionnaire runner without invoking a model. It displays the returned JSON as a local transcript message.

Start an isolated regular-mode session:

```sh
repo="$PWD"
profile="$(mktemp -d)"
PI_CODING_AGENT_DIR="$profile" pi --offline --no-session --no-extensions \
  --no-skills --no-prompt-templates --no-context-files --no-approve \
  --tui-mode regular \
  -e "$repo/packages/ask-user/src/index.ts" \
  -e "$repo/packages/ask-user/test/fixtures/demo.ts"
```

1. Run `/ask-user-demo core`. The fixture has a single-select storage question (SQLite/PostgreSQL) and a multi-select features question (Search/Export/Audit).
2. Choose SQLite. On the features tab, toggle Search and Export and save custom text `Offline mode`. Review, return to storage, change to PostgreSQL, then submit. Expect answers indexed 1 and 2, PostgreSQL for the first, Search/Export plus `Offline mode` for the second.
3. Run `/ask-user-demo single`. Choose an option. Confirm that it opens review rather than submitting immediately, then submit.
4. Run `/ask-user-demo rich`. It contains single- and multi-select code/config previews, including one long preview. Use arrows and PageUp/PageDown to inspect them. Resize to 120 columns, then 60 columns; verify side-by-side then stacked presentation without clipped lines.
5. Save a question note `Prefer simpler operations` and global note `Ship incrementally`. Reopen the question note, type a different draft, and press Esc. Confirm review and final output retain the saved note, not the uncommitted draft.
6. Before submitting, enter a multiline custom-answer draft. Verify Ctrl+] followed by a character still jumps forward in the editor without hiding the dialog. Press Alt+h to hide. Navigate the transcript and verify Ctrl+] still performs jump-forward in Pi's main editor without reopening the dialog. Press Alt+h again and confirm the same tab, draft, and selections remain. Save the draft, review, and submit. Verify JSON includes notes/custom text but no preview content or repeated question text.
7. Run `/ask-user-demo cancel` and press Esc before doing any work; expect immediate `{"cancelled":true,"answers":[]}`. Run it again, make a choice and type a draft, leave editing, then press Esc. Confirm **Keep editing / Discard answers** appears with Keep editing selected. Press Esc and verify your choice and draft remain. Request cancellation again and explicitly select Discard answers; expect exactly `{"cancelled":true,"answers":[]}`. Run another fixture to confirm input still works.
8. Run `/ask-user-demo limits`, which contains eight questions with eight options each, long headers/descriptions, and Unicode labels. Navigate all tabs and scroll at a small terminal height. Restore a larger window, answer all questions, and submit.
9. Quit Pi. Repeat the launcher with a new `profile="$(mktemp -d)"` and `--tui-mode fullscreen`, then repeat steps 1–8. Only the temporary profiles receive Pi state; do not copy credentials or global settings into them.

## User-controlled rollout after verification

- Do not load old and new extensions together: both register `ask_user_question`.
- To switch locally, the user removes/disables `npm:@juicesharp/rpiv-ask-user-question`, installs the local `packages/ask-user` path, and starts a fresh Pi session. Do not modify unrelated installed packages.
- A fresh session avoids relying on old injected tool instructions and declaration history. Review any separate user-authored rules that still impose rpiv's 1–4 questions, required headers, or single-select-only previews; retaining the tool name does not rewrite those rules.
- Rollback: remove/disable the new package and restore the previous package, then start a fresh session.
- Publishing follows the repository's first-publish/trusted-publisher procedure and `ask-user-v0.1.0` release tag. No publish, tag, install, or global settings edit is part of implementation verification.
