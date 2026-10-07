# Pi subagent

Persistent Pi RPC workers, fresh one-shot reviewers, and a compact panel above the editor. The footer is not replaced.

`start`, `message`, `wait`, `status`, `stop`, `reply`, and `recover` control isolated conversations. `/subagents` inspects live output and saved transcripts without replacing the footer or registering RPC children as terminal sessions.

## Isolated development

Do not load this package beside the old example: both register `subagent`. Do not change your global installation during development.

The tests create temporary agent directories, use a deterministic offline provider, exercise real Pi RPC children and tools, and remove their own resources:

```sh
npm run check --workspace=@lwlee2608/pi-subagent
PI_OFFLINE=1 npm test --workspace=@lwlee2608/pi-subagent
```

Node 22.19+ and Pi 1.x are required. Process cleanup is tested on Linux only. No credentials or paid calls are needed for these checks.

## Child resources

Create `<agent-dir>/pi-subagent/config.json` in the **isolated** agent directory you use for development. Paths must point to reviewed extension files, not packages or directories:

```json
{
  "extensions": {
    "provider": "/absolute/path/to/your/provider-extension.ts"
  },
  "trustedProjectRoots": [],
  "maxActive": 4,
  "maxWorkers": 16
}
```

Built-in providers need no provider extension. A custom provider must be available both to the parent and through this child allowlist. Normal Pi authentication remains Pi's responsibility; this package never reads credential contents. Missing or different models, unsupported effort, missing tools, and invalid paths fail visibly. Model selection is exact (`provider/model` or an unambiguous model ID), never fuzzy fallback.

All approved extensions load unless a profile selects names with `extensions: [provider]`. Only approve child-safe resources. Parent UI and orchestration extensions are not inherited. The package adds its private bootstrap and `ask_parent` question tool; do not load `src/bootstrap.ts` or `src/child.ts` yourself. Child nested delegation is disabled. A tool allowlist and read-only reviewer instructions are capabilities, not an OS sandbox: bash can still modify files.

Profiles come from `<agent-dir>/agents/*.md`, with bundled `worker` and `reviewer` fallbacks. Existing profiles are not overwritten. Compatible frontmatter includes `name`, `description`, `tools` (CSV or YAML list), `model` (optional `:effort` suffix), `effort`, and `extensions`. Project profiles in the nearest `.pi/agents` require both `agentScope: "project"`/`"both"` and that directory's project root in `trustedProjectRoots`. The default scope is `user`.

Call options override profile settings, then parent model/effort. Children inherit user skills and project instructions. The parent supplies available skill paths; project Pi configuration is otherwise disabled for children. Each start gets fresh context, not a parent fork.

`maxWorkers` bounds live process reservations, including queued and idle retained workers. `maxActive` bounds working/blocked tasks. Admitted tasks beyond that limit are queued without spawning a child; retained workers may queue their next task only after becoming idle. Blocked questions keep their task slot, but reply and stop never need a free slot.

## Simple review

Examples show tool arguments, not executable JavaScript globals. Replace placeholder IDs with returned IDs:

```json
{"action":"start","agent":"reviewer","task":"Review the local diff. Return prose findings; do not edit files."}
{"action":"wait","runIds":["r-RETURNED-RUN-ID"]}
```

`start` returns a stable worker ID, run ID, and admitted state immediately. Admission is not success. Inspect `runs[].result.outcome` from `wait`: `completed`, `failed`, or `interrupted`. A one-shot worker retires automatically after settlement and result persistence. Its successful result remains successful after process exit. `processAlive: false` confirms exit; `stop` also waits for cleanup. Terminal results remain readable through `wait` and `status`.

## Continue one worker

```json
{"action":"start","agent":"worker","lifetime":"retained","cwd":"/absolute/worktree","label":"Phase A","task":"Implement the assigned change and run its checks."}
{"action":"wait","runIds":["r-FIRST-RUN-ID"]}
{"action":"message","workerId":"w-WORKER-ID","mode":"task","label":"Phase A fixes","message":"Apply this review feedback and re-run the checks: ..."}
{"action":"wait","runIds":["r-NEW-RUN-ID"]}
{"action":"stop","workerId":"w-WORKER-ID"}
```

Task messages require an idle retained worker. The same PID and persisted Pi session handle both tasks, with different immutable run results. Busy task messages are rejected, never silently queued. A working child accepts `mode: "steer"`, retaining its run ID. Task/guidance text gets a fixed literal-input prefix so `/commands` are not dispatched.

`wait` is event-driven and supports `all` (default), `any`, and an optional positive `timeoutMs`. The default is 30 minutes. A timeout is not task failure. Cancelling a wait removes only that waiter; the panel continues to show the worker. `status` with no worker ID lists this parent's workers. Repeated status/wait calls do not duplicate child usage charges.

`stop` cancels work, clears child queues, and closes the owned process with bounded escalation. It never removes worktrees, reverts edits, or deletes transcripts. Shutdown/reload closes owned workers. Unexpected child permission dialogs fail closed, not auto-approved. The orchestrator owns all Git/worktree operations.

## Parallel workers and questions

Supply separate disposable worktree paths in each `start`; this extension does not create or remove them. Save both run IDs and wait without polling:

```json
{"action":"wait","runIds":["r-A-RUN-ID","r-B-RUN-ID"],"mode":"all"}
```

`any` returns after one selected result is terminal; `all` waits for every selected result. Either mode returns `reason: "attention"` when **any** owned child has a pending question, including when the selected runs are queued siblings. Inspect `pendingQuestionIds` and `status` for the question text, worker/run, and process generation. The panel prioritizes blocked workers, shows up to four rows plus details, and reports overflow.

Children ask through `ask_parent({ question: "Which filename?" })`, not a TUI questionnaire. Reply continues that run, without creating another task:

```json
{"action":"reply","questionId":"q-QUESTION-ID","message":"Use scratch.txt in your assigned worktree."}
```

If the decision belongs to the user, ask them before replying. To refuse the decision, send `{"action":"reply","questionId":"q-QUESTION-ID","cancelled":true}`. Cancellation stops the child and interrupts its unfinished run; it never means permission to guess. Stop, shutdown, and process exit cancel pending questions. Stale and duplicate replies fail. Question history is bounded to 128 per worker; exceeding it stops that worker visibly through an interrupted result.

For review/fix rounds, start a fresh one-shot reviewer in the worker's directory, wait for the report, then send it as a new `task` message to the **original idle retained worker**. Its PID/session stay unchanged and the fix task gets a new run ID. Stop every retained worker and confirm `processAlive: false` before removing worktrees.

## Inspector and offline UI verification

Open `/subagents` while the parent works or waits. Use ↑/↓ to select workers, PgUp/PgDn to scroll the selected transcript, and End to follow live output. `m` sends a new task to an idle retained worker or steers a working one; `r` answers a pending question; `s` asks for stop confirmation (`y`/`n`); `c` explicitly recovers a closed retained worker. Esc cancels an editor/confirmation first, then closes only the inspector. It does not cancel the parent wait or child work.

The inspector reads a bounded tail of the full private transcript (128 KiB input / 64 KiB displayed text), shows its path, and appends live streamed output. Older output stays available at that path. All displayed child text is terminal-control sanitized. Narrow terminals remain width-bounded; enlarge very short terminals to use controls.

Run the disposable offline fixture from a real terminal:

```sh
node packages/subagent/test/ui.ts fullscreen
# Repeat with regular and resize to narrow/normal widths:
node packages/subagent/test/ui.ts regular
```

Type `PARENT_UI`, then open `/subagents` while the two rows run. Select both, inspect output, steer the working worker, reply to the question, and cancel then confirm stop. Check Esc returns focus to the editor, change the theme and reopen, then `/reload` and recover a saved worker. `/sessions` should show only the parent TUI, and the existing footer should remain intact. Exit normally to stop children and remove the fixture's own temporary directory. This uses no credentials, network provider, or global configuration changes. Automated tests do not replace a user's confirmation of actual appearance/focus.

## Explicit saved recovery

Resume the **original parent Pi session**, inspect `status`, then explicitly recover a closed retained worker:

```json
{"action":"recover","workerId":"w-SAVED-WORKER-ID"}
{"action":"message","workerId":"w-SAVED-WORKER-ID","message":"Continue with this decision: use scratch.txt. Recall your previous work first."}
```

Recovery preserves worker/session identity, cwd, profile, provider/model/effort, and prior terminal results. It starts a new child PID **idle**, with no model request. Only a subsequent task creates a new run. Interrupted tasks, steering, and replies are never automatically replayed. Pending questions become cancelled history and their old IDs reject replies.

Stop/reload/shutdown/replacement closes owned children and interrupts only unfinished runs. Closed retained workers with saved sessions show `recoverable: true`; recovery still verifies prerequisites. It rejects one-shot, live, foreign-parent, missing-session/cwd, changed profile/extension/skill, removed allowlist, and provider-contract mismatches. Restore the saved prerequisites rather than substituting resources silently.

A private `owner.json` file exclusively reserves a parent's storage for its current runtime. A second parent instance cannot open it. Normal shutdown removes it only after confirmed child cleanup and metadata writes. A crash or failed cleanup leaves the lock: recovery then refuses uncertain ownership. Do not remove a lock until you have independently confirmed that its parent and every child have exited. The extension does not guess from PID reuse, adopt another parent's workers, or kill an unowned process. Corrupt metadata is reported without loading partial state.

## Storage and bounds

Private session directories and per-run result files live under `<agent-dir>/pi-subagent/<parent-session-id>/<worker-id>/`. Results reference the full persisted Pi transcript. Result files are mode `0600`; containing directories are mode `0700`. Keep transcripts private.

Live text is bounded to 8 KiB, returned result text to 4 KiB, stderr to 16 KiB, and individual RPC records to 4 MiB. Oversized/malformed protocol output closes the child rather than allocating without bounds. A parent admits at most 2048 tasks before requiring a new parent session; existing disk output remains intact. Worker metadata freezes the launch contract and hashed non-secret profile/extension/skill prerequisites. Atomic, fsynced metadata updates are limited to 20 MiB per worker; persistence failures close live work and remain visible rather than silently downgrading recovery.

## Live demo

Run once after all phase PRs merge, in a disposable terminal session. Live calls use normal Pi authentication through the configured provider; confirm model availability without reading or copying credential files. Missing authentication/configuration is a blocker. No GitHub remote, PR, push, publication, or deployment is part of this demo.

Create the exact fixture repository from the plan:

```sh
DEMO=$(mktemp -d)
mkdir "$DEMO/repo"
cd "$DEMO/repo"
git init -q
printf '%s\n' '{"type":"module","scripts":{"test":"node --test"}}' > package.json
printf '%s\n' 'export function add() { throw new Error("TODO"); }' > add.js
printf '%s\n' 'export function upper() { throw new Error("TODO"); }' > upper.js
printf '%s\n' 'import assert from "node:assert/strict";' 'import { test } from "node:test";' 'import { add } from "./add.js";' 'test("add numbers", () => assert.equal(add(2, 3), 5));' 'test("reject strings", () => assert.throws(() => add("2", 3), TypeError));' > add.test.js
printf '%s\n' 'import assert from "node:assert/strict";' 'import { test } from "node:test";' 'import { upper } from "./upper.js";' 'test("upper", () => assert.equal(upper("pi"), "PI"));' 'test("empty", () => assert.equal(upper(""), ""));' > upper.test.js
printf '%s\n' '# Disposable tasks' 'A: implement add; add(2,3)=5 and add("2",3) throws TypeError.' 'B: implement upper; upper("pi")="PI" and upper("")="".' > demo-plan.md
git add .
git -c user.name=Demo -c user.email=demo@example.invalid commit -qm 'Add disposable fixture contracts'
git worktree add -qb demo-a "$DEMO/A"
git worktree add -qb demo-b "$DEMO/B"
```

1. Launch Pi with invocation-specific extension selection (only this package, required provider, footer, and session-board) and isolated non-secret subagent config. Do not enable the old example. Choose an available model and effort explicitly.
2. Start retained workers in A and B. A implements **only nominal addition**, deliberately leaving the type check for review; B implements uppercase and runs `node --test upper.test.js`. A runs `node --test add.test.js`, whose omitted edge case is expected to fail initially.
3. Wait on both run IDs. Confirm panel/inspector behavior and unchanged footer; inspect edits for worktree isolation.
4. Start a fresh one-shot reviewer in A against all supplied requirements. Confirm it finds the missing type check, retires, and retains its result. Send its report as a new task to A's original worker. Confirm unchanged worker/session/PID, a new run ID, and passing `node --test add.test.js`.
5. Ask B to call `ask_parent` before choosing an output filename. Inspect the blocked row, reply with a disposable filename, and wait for the same run to complete.
6. Ask B another question and leave it unanswered. Reload the parent in the same session. Confirm child exit and cancelled question history. Explicitly recover B: new PID, idle, no replay. Reject the old question ID, then send a new task containing the decision and asking B to recall its prior work.
7. Stop A if still live and stop B. Confirm all child exits before `git worktree remove --force "$DEMO/A"` and the equivalent B command. Remove only the known `$DEMO` fixture after checking its path. Keep transcripts private. Report isolation, review/fix, questions, recovery, and the user's UI confirmation; do not call a missing confirmation a pass.

## Rollout and rollback

These are post-build steps, not approval to modify global settings now.

1. Let old-example children finish. Record its path and enabled resources. Preserve `~/.pi/agent/agents/*.md`.
2. Back up only affected non-secret settings. Disable `~/.pi/agent/extensions/subagent/index.ts` through `pi config`, including its auto-discovered entry. Keep backups outside auto-loaded extension directories.
3. Configure `<agent-dir>/pi-subagent/config.json` with reviewed provider/tool extension paths and limits. Do not inherit parent UI/orchestration extensions.
4. After approval, run `pi install ./packages/subagent` once, then reload. Verify one active `subagent`, `/subagents`, and a one-shot smoke task whose process retires. Pi reports a duplicate-tool conflict if both implementations load; do not rename tools to bypass it.
5. Apply the separately reviewed `agent-skills/skills/build-feature/SKILL.md` commit only after this extension is usable. The external skill change has its own Git history/PR; do not create a cross-repository commit. Publication and global installation remain user decisions.
6. Roll back by stopping all children, confirming exit, disabling/removing this package, restoring the prior resource selection, and reloading the old example. Revert the skill separately. Preserve saved sessions; do not send this action API to the old tool or remove worktrees as part of rollback.
