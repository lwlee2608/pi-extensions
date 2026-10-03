# Pi Session Board

**The Job** — Build an on-demand native Pi overlay that observes independent interactive Pi sessions across projects.
**The Why** — Let the user see which terminal sessions need attention or are working without visiting each terminal.
**The Guardrail** — Monitoring only: do not launch, control, attach to, or change other sessions. Store metadata only; do not modify sibling projects, publish, or deploy.
**Done means** — Two independently started Pi TUI sessions with the extension loaded appear in one live board, with trustworthy activity states and safe lifecycle cleanup.

## Decisions
- **Product scope** — Observe sessions started normally; no central manager, session controls, or terminal switching. User confirmed.
- **UI surface** — On-demand native Pi overlay. User confirmed.
- **Stored activity** — Project directory, session identity/name, status, tool names, and timings only. No prompt excerpts, tool arguments, tool output, or transcripts. User confirmed.
- **Registration scope** — Interactive Pi TUI sessions only, with the extension loaded and sharing the same Pi agent directory. Exclude RPC, JSON, print, and automated child sessions. User confirmed.
- **Starting point** — Repository starts with this plan and no implementation. The superseded handoff has been removed; this plan is authoritative.
- **Pi APIs** — Installed Pi is `1.0.0`. It provides `session_start` reasons, `session_shutdown` reasons, `session_info_changed`, `agent_before_settle`, `agent_settled`, and `ui_prompt_start` / `ui_prompt_end`. Waiting detection need not use tool-name guesses. `research`
- **Waiting detection caveat** — Native UI events wrap select/confirm/input/editor/custom interactions, not just agent questions. The board itself must not create a false Needs input state. `research`
- **Package conventions** — Sibling `../pi-model-plus` uses ESM TypeScript, npm lockfile, `tsc --noEmit`, Node's test runner, source distribution, and wildcard host-package peers. Current upstream guidance likewise requires host-provided peers with `*`, not bundled runtime copies. `research`
- **Supported host** — Target Pi 1.0 APIs, tested against 1.0.0, with no pre-1.0 compatibility paths or promise of compatibility with untested future releases. User confirmed.
- **Status and waiting semantics** — Needs input means a native extension UI prompt during active agent work; ignore idle dialogs and the board's own interaction. Otherwise show Working, Idle, Failed, or Unknown. Aborted runs return to Idle. No Completed state or prose/tool-name inference. User confirmed.
- **Stale presence policy** — Heartbeat every 5 seconds; show Unknown after 20 seconds without a heartbeat, hide after 5 minutes. No OS process probes and no deleting another registration's file. A paused writer can reappear. Clean exit removes its own record. User confirmed.
- **Opening command and shortcut** — `/sessions` only; no global shortcut in v1. User confirmed.
- **Busy-host access** — Pi's command dispatch handles extension commands before streaming/compaction prompt queueing; the command must not call `waitForIdle()`. Real TUI verification must cover opening and closing while busy. `research`
- **Waiting API limits** — Pi reports only the outermost wrapped UI interaction and supplies no originating tool or prompt ID. A direct test of the Pi 1.0.0 wrapper proved that a question opened during the board emits no separate start/end event, even if the board closes first. User approved limited detection: exclude the whole board-originated interaction and explicitly mark waiting detection unavailable until its outer UI end event. Standalone questions remain detectable; overlapping questions must remain accessible but need not produce Needs input. Native events also do not cover external-terminal input or assistant prose.
- **Supported platforms** — Linux first. Use portable Node APIs, but do not claim verified macOS or Windows support. User confirmed.
- **Package identity and license** — `@lwlee2608/pi-session-board`, UI title `Session Board`, MIT license. Prepare a public npm package; publishing is not authorized. User confirmed.
- **UI details and timing** — User revised after visual testing: full-area compact board inspired by the supplied Claude Code reference. Single-line aligned project/session, metadata-only activity, and elapsed-time columns; short project names, distinct registration suffixes for unnamed sessions. Group in this order: Needs input, Failed, Working, Idle, Unknown. Status counts at top; current-session and waiting-limit markers with one footer legend. Fill every cell to hide background content. Refresh once per second; arrow/page-key scrolling and Esc to return. Preserve viewport position and stable ordering across heartbeats.
- **Elapsed time** — Time since the current status began; activity/tool changes and heartbeats do not reset it. Unknown instead shows clearly labelled time since last heartbeat. No task-completion or task-duration claims.
- **Final demo** — None. Each phase must provide local verification; no deferred Verify lines. User confirmed.
- **Implementation phases** — Three sequential phases: live cross-project board; attention states; interruption safety and package validation. User confirmed. No parallel phases: each depends on and modifies the preceding registry, adapter, and UI.

## Implementation constraints

- Use separate state/presentation logic, registry infrastructure, Pi event adapter, and overlay component. TypeScript source distribution, no build step or standalone service; match the sibling's npm/Node-test conventions without modifying it.
- Store one atomically replaced JSON record per registration under `getAgentDir()/pi-session-board/`, respecting `PI_CODING_AGENT_DIR`. Unique registration filenames isolate old cleanup from newer registrations. Treat heartbeat freshness as a lease, not proof of OS process identity.
- Session replacement and reload must retire the owned registration and publish the current session without retained duplicate rows. Track in-flight writes so shutdown cannot recreate an already removed record. Start resources on `session_start`, not in the extension factory; cleanup must be idempotent.
- Directory/file permissions are private on supported Linux systems. Bound and validate records and text; tolerate malformed, oversized, unsupported, or disappearing records. Do not follow record-provided filesystem paths or execute record contents. Sanitize terminal control characters before rendering.
- Own clean shutdown removes only the owned file. Do not garbage-collect other registrations. Document that abandoned hidden records can accumulate and how the user can clear the registry with all participating sessions stopped.
- Metadata-only also excludes UI prompt titles and provider error messages, which may contain user content. Render generic labels such as Ready, Generating, Tool: bash, Waiting for input, Run failed, or Aborted. User-assigned session names and project paths remain visible metadata.
- Track concurrent tools without treating one recovered tool error as a failed run. Keep Working through automatic retries, recovery, and compaction. Use final settlement plus observed outcome to distinguish Idle, aborted, and Failed. Manual compaction is also busy work while it runs.
- Avoid mutating prompts, tools, histories, editor contents, or agent execution. Closing the overlay consumes its close key without aborting the host run. Handle an incoming host question while the board is open without swallowing or blocking access to that question; exercise native overlay focus behavior in verification.
- Fail softly on registry I/O errors: warn once per failure episode, keep Pi usable, retry on the next scheduled update, and expose a readable board error rather than an unhandled rejection. Stop refresh resources when the board closes.
- No user-facing configuration file, shared-registry override, filtering, detail drill-down, footer widget, history, telemetry, cost analytics, or LLM classification in v1.
- Pin development dependencies to tested versions; declare used host packages as `*` peers per upstream guidance. Document the tested Pi 1.0.0 baseline and lack of older-host support.
- Verification uses temporary local registry roots, synthetic events, and disposable Pi sessions. No paid model calls, production credentials, changes to the user's global Pi installation, or disruption of existing sessions. Any crash test targets only a process created for that test.

## Progress
Complete · 12/12 tasks — three phase PRs (#1, #2, #3), each with two review rounds. Final integration-to-main PR remains for the user. Demo: none.

### Phase 1 — See live sessions across projects
Open `/sessions` in either of two independently launched Pi terminals and see both sessions update without reopening the board.

- [x] Create the loadable TypeScript package and local check/test commands (`package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`, `LICENSE`).
- [x] Publish isolated, bounded metadata records with heartbeat freshness and owned cleanup (`src/registry.ts`, `test/registry.test.ts`).
- [x] Register interactive sessions and connect identity, basic busy/idle transitions, and live overlay refresh (`src/index.ts`, `src/state.ts`, `src/board.ts`).
- [x] Verify the cross-project board and document local launch steps (`test/board.test.ts`, `README.md`).

**Verify:** Run `npm run check` and `npm test`; registry tests must cover two independent writers, private permissions, atomic replacement, owned cleanup, and the 20-second/5-minute freshness boundaries using an injected clock. Launch two disposable Pi TUI processes in different temporary project directories with the same temporary `PI_CODING_AGENT_DIR`, loading the absolute `src/index.ts` via `-e`. Without making a model call, open `/sessions` in A: both directories appear and A is marked current. Change B's session name using Pi's naming command and confirm A updates within two refresh ticks. Quit B normally and confirm its row disappears. Esc closes A's board without changing its editor or session. These checks are development-only, not a global installation.

### Phase 2 — Know which sessions need attention
Distinguish work, a question, and a failed run; safely consult the board while the host is busy.

- [x] Model attention states, final outcomes, concurrent tools, and elapsed status time (`src/state.ts`, `test/state.test.ts`).
- [x] Connect native UI, tool, settlement, and compaction events without persisting content (`src/index.ts`, `test/lifecycle.test.ts`).
- [x] Render final groups/activity labels and preserve usable focus when host questions arrive (`src/board.ts`, `test/board.test.ts`).
- [x] Add a test-only offline event/provider fixture and exact local attention-state verification steps (`test/fixtures/offline.ts`, `README.md`).

**Verify:** Run `npm run check` and `npm test`. State and adapter tests must exercise Working → Needs input → Working → Idle, final run failure, recovered tool failure, retry/compaction, user abort, concurrent/nested tools, and the next run clearing the previous outcome. Assert that prompt text, UI titles, arguments, outputs, and provider error details never reach registry records. In two disposable real Pi terminals, load the test-only fixture alongside the board. The fixture uses only a local deterministic provider and test tools, with no network, credentials, or charges; it drives a delayed tool, native blocking question, success, and non-retryable error. Observe the corresponding states in A. In B, open and close the board during delayed work: work continues and B does not become Needs input solely because its board opened. Also deliver a native question while B's board is open: it must remain accessible and answering must allow work to continue. During this board-originated interaction show that waiting detection is unavailable, rather than claiming to detect the overlapping question. Record the exact fixture commands in the README when adding it; never substitute a live provider call.

### Phase 3 — Trust the board through interruptions
Keep a truthful, usable board through lost heartbeats, session changes, bad registry files, and installation from the actual package artifact.

- [x] Harden reload/session replacement, delayed writes, stale records, and recoverable filesystem failures (`src/index.ts`, `src/registry.ts`, `test/lifecycle.test.ts`, `test/registry.test.ts`).
- [x] Verify stable viewport/order, narrow terminals, Unicode, sanitization, and theme changes (`src/board.ts`, `test/board.test.ts`).
- [x] Validate the distributed artifact and run checks in Linux CI (`package.json`, `test/package.test.ts`, `.github/workflows/ci.yml`).
- [x] Complete installation, privacy, detection limits, registry cleanup, compatibility, and troubleshooting guidance (`README.md`).

**Verify:** Run `npm run check` and `npm test`, including named cases for old-cleanup/new-registration isolation, shutdown racing a write, malformed/unsupported/oversized/disappearing records, I/O failure recovery, and frozen-clock stale-to-hidden transitions. Reuse the isolated two-terminal setup: `/reload`, `/new`, `/resume`, and fork in B must leave exactly one current B row after refresh, with no old identity. Terminate only a disposable B created for this test; A must show Unknown after 20 seconds and omit B after 5 minutes, without deleting B's record. Inspect retained metadata for the privacy contract. Test the overlay at narrow and normal widths, with Unicode names, scrolling during updates, and both regular/fullscreen Pi modes. Run `npm pack` to a temporary destination, extract the tarball, verify the manifest entry and every relative runtime import are included, and load that extracted package in a fresh isolated Pi TUI. `/sessions` must work without relying on the checkout or its `node_modules`; test fixtures must not ship in the package.

## UI follow-up

User approved a full-area compact board with metadata-only activity after trying PR #4. This supersedes the original two-line overlay layout, not the monitoring/privacy decisions. Verified type-check, 16 tests, full-area cell coverage, aligned columns, distinct unnamed IDs, and real Pi regular/fullscreen sessions including incoming question focus with 25 filler rows.

## Verification record

- User waived the green-CI requirement for Phases 1 and 2 because CI is explicitly Phase 3 scope. Local proof and review gates still apply; Phase 3 must have green CI.
- Phase 1: `npm run check` and `npm test` passed (6 tests after the review fix). Two real Pi 1.0.0 terminals under an isolated tmux server, clean HOME/environment and temporary agent directory proved discovery, current marker, rename within two seconds, owned exit cleanup, Esc close and usable editor. No provider credentials or model calls.
- Phase 2: two review rounds; fixed tall-board question occlusion by yielding rendering when unfocused and prioritized the unavailable warning before long metadata. Round 2 clean. Type-check and 10 tests passed, plus two real isolated Pi terminals with the offline provider/tool fixture (including 25 filler rows for question visibility). Verified standalone waiting, success, final failure, next-run clearing, board open/close while busy, usable overlapping confirmation with limitation label, abort-to-Idle, and no private markers in records. Pi reports completed for abort during a tool; only explicitly aborted outcomes get the Aborted activity label.
- Phase 3: two review rounds; fixed malformed registration-ID coercion with a regression case; round 2 clean, no skipped findings. Linux CI passed. Type-check and 16 tests passed, including packed imports, lifecycle/write races, malformed records, I/O recovery, viewport anchor, Unicode and theme refresh. Loaded extracted npm artifact outside checkout in isolated real Pi terminals (regular/fullscreen); verified reload/new/resume/fork identity replacement, Unicode/resize, then SIGKILL only the disposable writer: Unknown after 20 seconds and hidden after 5 real minutes while its record remained. No model network calls; local fixture only.
- Dependency note: `npm audit` reports a High advisory on Pi 1.0.0's development-only `brace-expansion@5.0.9`. `npm audit fix` and `npm update brace-expansion` did not resolve it. No copy ships in this package; host dependency updates are outside this phase.

## Demo
none

## Deferred / not authorized

- No pre-1.0 compatibility, non-TUI monitoring, session control, terminal switching, browser server, or other-machine monitoring.
- No automatic deletion of abandoned records from other registrations; stale records are hidden, not crash history.
- User authorized bootstrapping remote `main`, pushing integration/phase branches, opening PRs, and merging reviewed phase PRs into integration under the build-feature workflow. Leave the final integration-to-main PR for the user to merge.
- npm publication, releases, and global installation require separate user authorization. Gallery discovery is a post-publication check, not an MVP acceptance criterion or a naming guarantee.

## Research references

- Installed Pi 1.0.0: `docs/extensions.md`, `docs/tui.md`, `docs/packages.md`, `docs/configuration.md`, `docs/keybindings.md`, and `docs/custom-provider.md` under the installed `@earendil-works/pi-coding-agent` package.
- Exact lifecycle/UI contracts: installed `dist/core/extensions/types.d.ts`, `dist/core/extensions/runner.js`, and `dist/core/agent-session.js`. UI events describe only the outermost prompt; outcome is available before settlement, not on the payload-free `agent_settled` event.
- Native overlay pattern: installed `examples/extensions/overlay-test.ts`.
- Package conventions: `../pi-model-plus/package.json`, read only. Its older development dependency versions are not the target for this project.
