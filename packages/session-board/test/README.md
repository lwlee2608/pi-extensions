# Session Board manual tests

## Two-terminal verification

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

## Offline attention-state verification

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
