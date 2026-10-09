# Pi subagent

Delegate tasks to isolated Pi child processes. Run one-shot reviewers, keep long-lived workers for follow-up tasks, run them in parallel, and answer their questions. A compact panel above the editor shows progress; `/subagents` inspects live output and transcripts.

## Install

```sh
pi install npm:@lwlee2608/pi-subagent
```

Run `/reload` afterward. Requires Node.js 22.19+ and Pi 1.x. Only one `subagent` tool can load at a time.

## Tool actions

| Action | Purpose |
| --- | --- |
| `start` | Start a worker from a profile. Returns worker and run IDs immediately. |
| `wait` | Wait for runs (`all` or `any`, optional `timeoutMs`). Returns result text. |
| `message` | Send a new `task` to an idle retained worker, or `steer` a working one. |
| `reply` | Answer a child's `ask_parent` question, or cancel it. |
| `status` | Show one worker, or all workers of this parent. |
| `stop` | Stop a worker. Never deletes edits or transcripts. |
| `recover` | Reopen a closed retained worker from its saved session. |

One-shot review:

```json
{"action":"start","agent":"reviewer","task":"Review the local diff."}
{"action":"wait","runIds":["r-RUN-ID"]}
```

Retained worker with a follow-up task:

```json
{"action":"start","agent":"worker","lifetime":"retained","cwd":"/path/to/worktree","task":"Implement X and run checks."}
{"action":"wait","runIds":["r-FIRST-RUN-ID"]}
{"action":"message","workerId":"w-WORKER-ID","message":"Apply this feedback: ..."}
{"action":"wait","runIds":["r-NEW-RUN-ID"]}
{"action":"stop","workerId":"w-WORKER-ID"}
```

- `wait` returns early with `reason: "attention"` when any child has a pending question. Answer with `{"action":"reply","questionId":"q-ID","message":"..."}`.
- Pass `parentWorkerId` on `start` to group a worker under another in the panel. Display only.
- Each `start` gets fresh context, not a fork of the parent conversation.
- Worktrees and Git operations are up to the caller; this extension never creates or removes them.

## Profiles

Profiles live in `<agent-dir>/agents/*.md`. Bundled `worker` and `reviewer` profiles are used as fallbacks.

```md
---
name: reviewer
description: Reviews changes without modifying files
tools: read, bash, grep, find, ls
model: provider/model:high
---
System prompt for the child.
```

Frontmatter: `name`, `description`, `tools`, `model` (optional `:effort`), `effort`, `extensions`. Call options override the profile, which overrides the parent's model and effort. Project profiles in `.pi/agents` need `agentScope: "project"` or `"both"` and a trusted project root.

Tool allowlists are instructions and capabilities, not an OS sandbox: `bash` can still modify files.

## Configuration

Children inherit the parent's extensions (except this one) by default. For stricter control, create `<agent-dir>/pi-subagent/config.json`:

```json
{
  "extensions": { "provider": "/absolute/path/to/provider-extension.ts" },
  "trustedProjectRoots": [],
  "maxActive": 4,
  "maxWorkers": 16
}
```

- `extensions`: replaces inheritance. `{}` loads none.
- `trustedProjectRoots`: roots allowed to supply project profiles.
- `maxActive`: concurrent working tasks; extra tasks queue.
- `maxWorkers`: live child processes, including idle retained ones.

## Inspector

`/subagents` opens a live view of workers and transcripts.

| Key | Action |
| --- | --- |
| ↑/↓ | Select worker |
| PgUp/PgDn, End | Scroll transcript, follow live output |
| `m` | Send task or steer |
| `r` | Reply to question |
| `s` | Stop (confirm with `y`) |
| `c` | Recover closed worker |
| `f` | Toggle flow view |
| Esc | Close |

## Storage

Sessions and results live under `<agent-dir>/pi-subagent/<parent-session-id>/<worker-id>/` with private file modes. Shutdown or `/reload` closes all children; retained workers can be recovered later from the same parent session.

## Development

```sh
npm run check --workspace=@lwlee2608/pi-subagent
PI_OFFLINE=1 npm test --workspace=@lwlee2608/pi-subagent
node packages/subagent/test/ui.ts regular
```

Tests use an offline provider and temporary directories. No credentials needed.
