# Pi subagent

Persistent Pi RPC workers, fresh one-shot reviewers, and a compact panel above the editor. The footer is not replaced.

**Phase 1:** `start`, `message`, `wait`, `status`, and `stop`. Only one task may run at a time. Parallel admission, child questions, recovery, and `/subagents` belong to later phases and are not available yet. Saved transcripts are inspectable, but workers cannot yet be recovered after shutdown.

## Isolated development

Do not load this package beside the old example: both register `subagent`. Do not change your global installation during development.

The tests create temporary agent directories, use a deterministic offline provider, exercise real Pi RPC children and tools, and remove their own resources:

```sh
npm run check --workspace=@lwlee2608/pi-subagent
PI_OFFLINE=1 node --test packages/subagent/test/rpc.test.ts packages/subagent/test/lifecycle.test.ts packages/subagent/test/panel.test.ts
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

All approved extensions load unless a profile selects names with `extensions: [provider]`. Only approve child-safe resources. Parent UI and orchestration extensions are not inherited. The package adds its private bootstrap; do not load `src/bootstrap.ts` yourself. Child nested delegation is disabled. A tool allowlist and read-only reviewer instructions are capabilities, not an OS sandbox: bash can still modify files.

Profiles come from `<agent-dir>/agents/*.md`, with bundled `worker` and `reviewer` fallbacks. Existing profiles are not overwritten. Compatible frontmatter includes `name`, `description`, `tools` (CSV or YAML list), `model` (optional `:effort` suffix), `effort`, and `extensions`. Project profiles in the nearest `.pi/agents` require both `agentScope: "project"`/`"both"` and that directory's project root in `trustedProjectRoots`. The default scope is `user`.

Call options override profile settings, then parent model/effort. Children inherit user skills and project instructions. The parent supplies available skill paths; project Pi configuration is otherwise disabled for children. Each start gets fresh context, not a parent fork.

`maxWorkers` bounds live process reservations, including idle retained workers. Phase 1 explicitly rejects another active task even if `maxActive` is greater than one. The configured scheduler limit becomes active in Phase 2.

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

## Storage and bounds

Private session directories and per-run result files live under `<agent-dir>/pi-subagent/<parent-session-id>/<worker-id>/`. Results reference the full persisted Pi transcript. Result files are mode `0600`; containing directories are mode `0700`. Keep transcripts private.

Live text is bounded to 8 KiB, returned result text to 4 KiB, stderr to 16 KiB, and individual RPC records to 4 MiB. Oversized/malformed protocol output closes the child rather than allocating without bounds. A parent admits at most 2048 tasks before requiring a new parent session; existing disk output remains intact. Durable recovery metadata and its ownership rules arrive in Phase 3.
