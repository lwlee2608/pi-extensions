# Session Board

See all your Pi sessions in one place. Run `/sessions` in any Pi terminal to view every other session on this machine, across projects, with its status and how long it has been running. No launcher or server needed.

## Install

```sh
pi install npm:@lwlee2608/pi-session-board
```

Run `/reload` in each open Pi terminal. Every terminal you want on the board must load the extension and use the same Pi agent directory. Requires Node.js 22.19 or newer and Pi 1.0.0 on Linux.

## Use

Run `/sessions`. The board covers the conversation while open and restores it on exit. Closing it does not interrupt the agent.

Each row shows the session name, project, activity, and elapsed time. `›` marks the current terminal. Unnamed sessions show the last eight characters of their ID, so use `/name` in each terminal to give it a recognizable name.

Sessions are grouped by status:

| Status | Meaning |
| --- | --- |
| Needs input | The agent asked a question and is waiting for you. |
| Failed | The last run ended with an error. A tool error the agent recovered from does not count. |
| Working | Generating, running tools, or compacting. Shown with a spinner. |
| Idle | The run stopped. This does not mean the task is complete. |
| Unknown | No heartbeat for 20 seconds. The session may be paused or hung. It is hidden after 5 minutes. |

| Key | Action |
| --- | --- |
| ↑ / ↓ | Select a session |
| Page Up / Page Down | Move by a page |
| `r` | Rename the selected session |
| Esc | Close the board |

### Rename

Press `r`, edit the name at the bottom, and press Enter to save or Esc to cancel. This changes the real Pi session name, the same as `/name` in that terminal. Names are 1–128 characters. Use `/name` to clear a name.

Both terminals need this version of the extension loaded. Unknown sessions cannot be renamed. If a rename times out, check the name before trying again, since it may have applied.

### Needs input limits

Needs input only covers questions asked through Pi's own question prompts during a run. Questions written as plain text in a reply do not count.

If a question arrives while the board is open, Pi doesn't report it, so the row shows **?** (waiting detection unavailable) instead of Needs input until that interaction ends. The question still works: close the board and answer it.

## Privacy

Session records are stored in `~/.pi/agent/pi-session-board/` (under `PI_CODING_AGENT_DIR` when set), readable only by you. They hold the session name, project directory, status, tool names, and timestamps. Prompts, tool arguments, outputs, and transcripts are never stored. Names and paths are visible to other sessions on the board, so keep secrets out of session names.

Renames use private local Unix sockets. No network port is opened. Other programs running as your user can reach these sockets, as they can reach Pi's own files.

## Troubleshooting

- **A terminal is missing:** load the extension there and check both use the same `PI_CODING_AGENT_DIR`. Print, JSON, and RPC runs never appear.
- **A session shows Unknown:** its heartbeat stopped. It comes back when the session reports again. Machine sleep and clock changes can also cause this.
- **Registry warning:** check free disk space and the permissions of the agent directory. Don't make the records readable by others.
- **Stale records after crashes:** with all Pi sessions stopped, delete `~/.pi/agent/pi-session-board/`. It is recreated on the next start. Don't delete anything else in the agent directory.
- **Renaming is unavailable:** a very long agent directory path exceeds the Unix socket path limit. The board still works.

## Limits

- Only Linux with Pi 1.0.0 is tested.
- Shows sessions on this machine only. It can't switch terminals or control sessions, apart from renaming.
- The board steps aside while a question has focus.

## License

MIT
