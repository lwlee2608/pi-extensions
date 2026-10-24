# Pi subagent

Let Pi delegate tasks to helper agents. Each one runs as a separate Pi process with its own fresh context. Run reviewers in parallel, keep a worker around for follow-up tasks, and answer its questions while it works.

## Install

```sh
pi install npm:@lwlee2608/pi-subagent
```

Run `/reload` if Pi is already open. Requires Node.js 22.19+ and Pi 1.x on Linux or macOS. Windows is not supported.

Don't install it alongside another extension that provides a `subagent` tool. Only one can load at a time.

## Use

Ask Pi in plain language:

```text
Use a reviewer to review the local diff.
```

```text
Run three reviewers in parallel: one for correctness, one for tests, one for security.
```

```text
Start a worker in ../my-worktree to implement the plan, then keep it around for review feedback.
```

Pi starts the workers, waits for them, and brings their results back. A compact panel above the editor shows progress while they run.

![Subagent panel showing a phased build with worker and reviewer rounds](https://raw.githubusercontent.com/lwlee2608/pi-extensions/main/packages/subagent/media/panel.gif)

Things to know:

- Each worker starts with fresh context. It does not see your conversation, only the task Pi gives it.
- A worker can ask Pi a question mid-task. Pi answers it, or you can answer from the [inspector](#inspector).
- By default a worker exits after one task. Ask Pi to keep it if you want to send follow-up tasks.
- Stopping a worker never deletes its edits or transcript.
- Worktrees and Git are up to you (or Pi). This extension never creates or removes them.

## Bundled agents

| Agent | Tools | Use it for |
| --- | --- | --- |
| `worker` | read, bash, edit, write, grep, find, ls | Implementing and checking a focused task. |
| `reviewer` | read, bash, grep, find, ls | Reviewing changes without editing files. |

Both use your current model and thinking level unless you set one.

## Custom agents

Add Markdown files to `~/.pi/agent/agents/`. A file with the same `name` as a bundled agent replaces it.

```md
---
name: reviewer
description: Reviews changes without modifying files
tools: read, bash, grep, find, ls
model: provider/model:high
---
System prompt for the agent.
```

| Field | Meaning |
| --- | --- |
| `name` | Name Pi uses to start the agent. |
| `description` | What the agent is for. |
| `tools` | Allowed tools. Defaults to all built-in tools. |
| `model` | `provider/model`, with optional `:effort` suffix. Defaults to your current model. |
| `effort` | Thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `extensions` | Names from `extensions` in `config.json` to load in the child. Defaults to all of them. |

A model or effort Pi passes for one task overrides the agent file.

Project agents in `.pi/agents/` are ignored unless the project root is listed in `trustedProjectRoots` (see below).

> **Not a sandbox:** tool lists are instructions, not OS isolation. An agent with `bash` can still modify files.

## Configuration

Optional. Create `~/.pi/agent/pi-subagent/config.json`:

```json
{
  "extensions": { "provider": "/absolute/path/to/provider-extension.ts" },
  "trustedProjectRoots": ["/absolute/path/to/project"],
  "maxActive": 4,
  "maxWorkers": 16
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `extensions` | Inherit yours | Extensions children load. Replaces inheritance; `{}` loads none. |
| `trustedProjectRoots` | `[]` | Projects allowed to supply agents from `.pi/agents/`. |
| `maxActive` | `4` | Workers running at once. Extra tasks queue. |
| `maxWorkers` | `16` | Live workers, including idle ones kept for follow-ups. |

## Inspector

Press ↓ on an empty prompt while the panel is showing, or run `/subagents`, to open a live view: workers on the left, grouped with the reviewers nested under them, and the selected worker's transcript on the right.

![Subagent inspector showing the worker tree and a live transcript](https://raw.githubusercontent.com/lwlee2608/pi-extensions/main/packages/subagent/media/inspector.gif)

| Key | Action |
| --- | --- |
| ↑/↓ | Select worker |
| PgUp/PgDn, End | Scroll transcript, follow live output |
| `i` | Show model, folder, PID, session file and IDs |
| `m` | Send a task, or steer a running worker |
| `r` | Reply to a question |
| `s` | Stop (confirm with `y`) |
| `c` | Recover a closed worker |
| Esc | Close |

## Storage

Sessions and results are saved under `~/.pi/agent/pi-subagent/`, readable only by you. Quitting Pi or running `/reload` closes all workers. Workers kept for follow-ups can be recovered later from the same Pi session.

## License

MIT
