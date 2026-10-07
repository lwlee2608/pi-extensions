# Persistent subagents

**The Job** — Add a focused general-purpose subagent extension to this monorepo, with persistent worker conversations and live progress.
**The Why** — `build-feature` Orchestrator mode needs parallel phase workers that retain context across fresh review rounds; the installed example cannot continue workers.
**The Guardrail** — Keep phase dependencies, PRs, verification policy, merges, and Git worktree ownership in the orchestrator/skill. Preserve the existing footer and session-board.
**Done means** — An orchestrator can start isolated workers, wait without polling, message the same worker across review rounds, run fresh reviewers, inspect progress, stop children, and explicitly recover saved conversations after shutdown or reload.

## Decisions
- **Interview depth** — Key decisions only.
- **Scope** — A focused general-purpose extension in this repository. Profiles, start/message/wait/stop controls, parallel children, and progress UI; no built-in feature workflow engine.
- **Worker lifetime** — Live workers with saved recovery. Keep one RPC child per worker across rounds. Stop children safely on shutdown/reload; recovery is explicit from saved conversations. No detached unattended workers.
- **Progress UI** — Compact persistent panel near the editor plus `/subagents` inspector with live output and message/stop controls. Do not replace the footer.
- **Worktree ownership** — The orchestrator creates and retains phase worktrees and supplies `cwd`. The extension does not create branches, merge, or remove worktrees.
- **Runtime support** — Pi provides long-lived RPC children, event streams, steering/follow-up, and persisted sessions. Existing session-board registers TUI sessions only, so child progress needs its own surface. `research`
- **Package identity** — `@lwlee2608/pi-subagent` in `packages/subagent`, matching monorepo packaging. `agent`
- **Public API** — One `subagent` tool with `start`, `message`, `wait`, `status`, `stop`, `recover`, and `reply` actions. `start` returns immediately with a stable worker ID and initial run ID. `wait` supports one/any/all selected runs without polling. `/subagents` opens the inspector.
- **Run identity** — Keep worker/conversation identity separate from each submitted task. Messages that start another turn return a new run ID; waits target explicit run IDs to avoid returning a previous round's result. Starting independent workers always creates fresh context, not a parent fork. `agent`
- **Resource inheritance** — Inherit skills and project instructions, but explicitly select child extensions, including required model providers. Do not blindly load parent UI or orchestration extensions.
- **Profiles and tool restrictions** — Compatible Markdown profiles from `~/.pi/agent/agents`, with bundled worker/reviewer fallbacks and explicitly enabled trusted project profiles. Preserve the existing reviewer, including bash for Git/gh inspection. Read-only is an instruction-based contract, not an OS sandbox.
- **Model and effort selection** — Explicit model and effort start options, validated against available provider/model support. Resolve call override, then profile, then current parent configuration; preserve the resolved selection for recovery. No silent model fallback. `agent`
- **Child boundary** — Disable nested delegation. Use standard Pi CLI/RPC and persisted Pi sessions rather than another agent runtime. Load extensions from an explicit user-controlled allowlist, with profile-level selection only from that list. Missing provider/tool setup fails visibly. Profile paths and launch contracts are resolved before spawning. `agent`
- **Child questions** — Provide a child-to-parent question channel. Mark the child blocked and release the parent's wait. The parent answers or asks the user before continuing the same worker.
- **Cancellation** — Cancelling a wait cancels only that wait. Workers keep running until explicitly stopped or the parent shuts down/reloads. Stop clears queued messages, aborts active work, and closes the process with bounded escalation. Never roll back or delete worktree changes.
- **Recovery scope** — Only the original parent Pi session may explicitly recover its saved workers. Enforce exclusive ownership, preserve saved cwd/model/profile settings, and reject missing or changed recovery prerequisites rather than guessing. No adoption into another parent session.
- **Recovery behavior** — Stop saves an interrupted/closed state, not a successful task result. Recovery reopens the saved conversation in a new RPC process under the same logical worker ID; never automatically rerun the last task. If process ownership is uncertain, refuse recovery until resolved. Session shutdown, reload, and replacement all release owned processes. `agent`
- **UI detail** — Place a bounded, compact panel above the editor. Show task label, state, current tool, elapsed time, and provider-reported usage where available. No synthetic completion percentages. Inspector shows live transcript, model/cwd, and message/reply/stop controls. No terminal panes, footer replacement, or session-board changes. `agent`
- **Storage and limits** — Store child sessions and bounded runtime metadata under a user-level package directory, scoped by parent session ID, not inside worktrees. Start with four concurrent active child tasks; expose a configurable limit and visible queued state. Idle workers do not spend active-task slots; cap live child processes separately and reject excess starts clearly. Blocked questions must not silently deadlock the scheduler. `agent`
- **Events and results** — Settle on Pi's final lifecycle boundary rather than the first `agent_end`. Stream bounded progress; retain full persisted transcripts for inspection. Coalesce rendering, not lifecycle transitions. Report errors separately from successful idle completion. Account for child usage once, not on each repeated status/wait. `agent`
- **Child question transport** — Add a dedicated child-only question tool using a narrow parent bridge; do not load the parent's custom TUI questionnaire inside RPC children. Questions have stable IDs and explicit reply/cancel outcomes. Unexpected child UI permission prompts must fail closed or be explicitly forwarded, never auto-approved. `agent`
- **Platform and validation** — Target the existing Node 22/Linux development environment and Pi 1.x APIs. Test with deterministic RPC fixtures and a local Pi/mock-provider integration path before paid live calls. Do not claim untested cross-platform process cleanup support. `agent`
- **Skill integration** — Include a separate change to `agent-skills/skills/build-feature/SKILL.md` with the concrete API and recovery rules. Keep Git changes and commits separate across repositories.
- **Demo** — Disposable parallel orchestration with live model calls, then user confirmation of Pi UI. Use temporary Git worktrees, a fresh reviewer, feedback to the original worker, and explicit saved recovery. No GitHub PRs or deployment.
- **Phase count** — _open_

## Progress
Planning — decisions in progress; implementation not started.

## Demo
Run two workers in temporary Git worktrees, run a fresh reviewer, and relay fixes to the original worker. Demonstrate explicit recovery from its saved conversation after stopping/reloading. Ask the user to confirm the live panel and inspector in their Pi terminal. Use live model calls, no GitHub PRs, and no deployment. Exact commands will follow the locked API.
