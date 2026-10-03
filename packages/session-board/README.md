# Session Board

A full-area Pi session board for independent interactive sessions across projects.
Run `/sessions` in any participating terminal. Each terminal must load the extension
and use the same Pi agent directory. No central launcher or server is needed.

Requires Node 22.19+; tested with Pi 1.0.0 on Linux. Older Pi releases are not supported.

## Install

```sh
pi install npm:@lwlee2608/pi-session-board
```

Reload each participating terminal after installation. Use the temporary `-e`
approach below when you do not want to change your installation.

## Try the checkout

From the repository root:

```sh
npm ci --ignore-scripts
npm run check
npm test
pi -e /absolute/path/to/pi-extensions/packages/session-board/src/index.ts
```

Start another Pi terminal with the same extension. `/sessions` shows session names,
short project names, activity, and elapsed time in aligned single-line rows.
Status counts sit above the grouped list. Working sessions show an animated spinner
while generating, running tools, or compacting. `›` marks the current terminal in a
separate column; unnamed sessions use the last eight characters of their registration ID. Use `/name` in
each terminal for a recognizable task name. The board covers the conversation
while open and restores it on exit. Session data refreshes each second; the spinner
updates every 80 ms without extra registry reads. Use ↑/↓ to select a highlighted row,
Page Up/Down to move by a page, `r` to rename, and Esc to close. Closing it does not interrupt the agent.
Groups are Needs input, Failed, Working, Idle, and Unknown. A recovered tool error
is not a failed run. Idle means the run stopped, not that your task is complete.

## Select and rename

Use ↑/↓ to highlight a session, then press `r`. Edit the name in the bottom input;
Enter saves and Esc cancels without closing the board. Names must contain 1–128
characters (no control characters). Use Pi's `/name` command to clear a name.

This changes the **actual Pi session name**, not a board alias. Each participating
terminal must load this version of the extension; run `/reload` in both terminals
after updating. The owning extension applies the rename through Pi's API, so normal
session persistence applies. No other process writes its history file.

Rename requests use private local Unix sockets beside the presence records, with
short timeouts and per-registration/session targeting. Unknown sessions cannot be
renamed. A quit, reload, or session switch invalidates the old endpoint; retry after
refreshing. A timeout has an uncertain outcome: check the name before retrying.
Other processes running as your user can access these endpoints, as they can access
Pi's own files. No network listener is opened. On unusually long agent-directory
paths, Unix socket limits disable renaming while monitoring continues.

## Local two-terminal verification

Use disposable directories, not your normal agent configuration:

```sh
ROOT=$(mktemp -d)
mkdir -p "$ROOT/agent" "$ROOT/A" "$ROOT/B"
export PI_CODING_AGENT_DIR="$ROOT/agent" PI_TELEMETRY=0
# In two terminals, use the same ROOT and extension path, but cd to A and B respectively:
cd "$ROOT/A"
pi --offline -ne -ns -np -nc -na -e /absolute/path/to/pi-extensions/packages/session-board/src/index.ts --name A
```

In B use `--name B`. In A open `/sessions`: both projects appear and A is current.
In B run `/name renamed-B`: A updates within two seconds. Quit B with Ctrl+D at
an empty editor: its row disappears. Esc closes A's board; type an unsent marker
to confirm the editor still works, clear it, then quit. No model calls are needed.

## Local metadata

Records live in `<agent-dir>/pi-session-board/`, private to your Linux user.
Only session identity/name, project directory, status, tool names, generic activity,
waiting-detection availability, and timestamps are stored.
No prompts, arguments, outputs, or transcripts are copied. Heartbeats run every
5 seconds. A missing heartbeat becomes Unknown at 20 seconds and is hidden at
5 minutes; this is not proof that a process crashed. Clean exits remove their
own records. The board never removes another writer's record. Hidden abandoned
records and temporary files can accumulate after crashes. With **all participating
Pi sessions stopped**, you can delete only `<agent-dir>/pi-session-board/`; it will
be recreated. Do not delete your agent directory or session histories.

## Attention detection

Needs input means a native extension question during active work. Idle pickers,
external-terminal input, and questions written as assistant prose do not count.
Pi 1.0 reports only the outermost UI interaction. While the board is open, an
incoming question has no separate event. The row therefore has a **?** marker, explained once in the footer as
**waiting detection unavailable**, not Needs input. This marker persists until the entire
outer interaction ends, including a question that outlives the board. Questions
still receive keyboard input; answering lets work continue. Abort returns to Idle;
the Aborted activity label is shown only when Pi reports an aborted outcome.

### Offline attention-state verification

Use the disposable setup above and add these arguments in both terminals:

```sh
-e /absolute/path/to/pi-extensions/packages/session-board/test/fixtures/offline.ts --model board-offline/fixture
```

The fixture is test-only, uses no network or credentials, and is excluded from
package distribution. Open `/sessions` in A. In B:

1. Send `question`: observe Working for eight seconds, then Needs input. Answer
   the native confirmation; observe Idle.
2. Send `work`, then `/sessions` during the eight-second tool. It stays Working,
   with the waiting-detection limitation label. Esc closes only the board.
3. Send `question`, then `/sessions` before the question arrives. The native
   question remains usable; press Enter to answer and observe Idle. Esc closes
   the board. This overlap is explicitly not classified as Needs input.
4. Send `fail`: observe Failed. Send `work`: it clears the previous failure.
   Press Esc during work: observe Idle, not Failed.

The fixture's private prompt/output/error markers must never appear in registry
JSON. It deliberately does not implement a general-purpose model service.

## Troubleshooting and limits

- Missing terminal: load the extension there, then check that both terminals use
  the same `PI_CODING_AGENT_DIR`. RPC, JSON, and print runs do not register.
- Unknown: the heartbeat lease expired. The process may be paused or hung, not
  necessarily dead. It reappears when it reports again. Machine sleep and clock
  changes affect wall-clock freshness and elapsed times.
- Registry warning: check free space and ownership/permissions of the agent
  directory. Updates retry on the next heartbeat; read failures show a board error
  instead of stale rows. Fix permissions rather than making records world-readable.
- Names and paths are visible local metadata; avoid putting secrets in names.
  Tool arguments, UI titles, provider errors, and message contents are never stored.
- The board temporarily yields the screen when a native question takes focus.
  Apart from explicit renaming, there is no session control, terminal switching, cross-machine discovery, or
  promise of task completion. Very short terminals show an enlarge-terminal hint.
- Only Linux with Pi 1.0.0 is verified. Other operating systems, older hosts, and
  future Pi releases are not covered by this release's compatibility claim.

## Development

`npm run check` type-checks without building; `npm test` runs Node's test runner.
Pi loads the TypeScript source directly. Host packages are peers, not bundled
runtime dependencies. Tests use temporary registry directories.

See the [repository README](https://github.com/lwlee2608/pi-extensions#publishing) for releases.
