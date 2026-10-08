# Pi Notify

Phone notifications for Pi runs you choose to watch. Off by default, TUI only; no sends from print/JSON/RPC sessions or subagent children.

## Install

```sh
pi install npm:@lwlee2608/pi-notify
```

Or try the source from this repository:

```sh
pi -e ./packages/notify/src/index.ts
```

Requires Node.js 22.19+ and Pi 1.0.0. Run `/reload` after installing.

## Configure

Create `~/.pi/agent/pi-notify/config.json` (under `PI_CODING_AGENT_DIR` when overridden):

```json
{
  "onPrompt": true,
  "connectors": [
    { "type": "telegram", "botToken": "$TELEGRAM_BOT_TOKEN", "chatId": "$TELEGRAM_CHAT_ID" }
  ]
}
```

Create a bot with Telegram's BotFather, start a conversation with it, and supply the destination chat ID. Export the environment variables before starting Pi, or supply literal strings. A string consisting entirely of `$VAR` resolves from Pi's environment; missing or empty values are rejected. Keep tokens private and restrict access to the config file.

At least one valid connector is required. Every connector fires on each ping; `onPrompt` defaults to `false`. Config is read for every command, tool arming request, and send, so edits apply without `/reload`. Invalid config refuses arming and leaves notifications off. Send failures show a warning per connector without exposing command output or tokens.

### Shell command connector

Route to ntfy, Slack, apprise, or any service with a local command:

```json
{
  "connectors": [
    { "type": "command", "run": "curl --fail --silent --show-error --data-binary \"$PI_NOTIFY_TEXT\" https://ntfy.sh/YOUR_PRIVATE_TOPIC" }
  ]
}
```

`run` executes in the session working directory using the platform shell and inherited environment. The notification is passed as `PI_NOTIFY_TEXT`, never interpolated into the command itself. Quote `"$PI_NOTIFY_TEXT"` in POSIX-shell commands. Telegram and command connectors can be mixed in the same array.

Only configure commands you trust: they execute with your permissions and can access local files and environment secrets. The extension supplies no prompt, reply, or code content, but a command you configure can read that content itself. Keep commands in the foreground. Output is discarded; exit code zero means success. Each send has a 10-second timeout; timeout or session reset kills the process group on POSIX (the shell process on Windows). Do not use detached/background processes that escape this cleanup. Sends run in the background and do not hold up Pi's lifecycle events.

## Use

| Action | Result |
| --- | --- |
| `/notify` | Arm the next completed or errored run only. |
| `/notify on` | Notify on every completed or errored run in this session. |
| `/notify off` | Disarm. |
| `/notify test` | Send a test immediately without changing arming. |
| “Notify me when you finish” | The agent can call `notify_me` to arm one-shot. |

The agent's tool description restricts `notify_me` to explicit user requests; it must not arm proactively. The tool is removed from active tools outside TUI, and calls outside TUI fail. Arming shows `🔔 once` or `🔔 on` in extension status (including Pi Footer). New, resumed, and forked sessions reset to off; arming is never persisted.

Notifications contain only the optional session name, working directory, and outcome:

```text
✅ fix-login · ~/src/app · done
❌ fix-login · ~/src/app · error
🔔 fix-login · ~/src/app · waiting for input
```

Session names and directory paths are sent to your configured destinations; avoid sensitive names if that matters to you.

With `onPrompt: true`, a blocking extension UI prompt during an active run also sends “waiting for input.” Its title and content are never included. Idle prompts do not send, and prompt pings do not consume one-shot: the eventual completed/error settle still sends. Commands such as `/sessions`, `/subagents`, or `/model-plus` opened during a run can also trigger this ping because Pi's prompt event does not identify its source.

### Settlement and cancellation limits

A run that settles to ask a question consumes one-shot, even if you expected more work afterward. Automatic continuations do not send until the final settlement.

Normal aborts send nothing and keep one-shot armed. **Accepted Pi limitation:** Escape during a pending asynchronous `agent_before_settle` handler does not update the previously recorded completion/error outcome, and Pi exposes no final cancellation state at settlement. That narrow case can still send a notification and consume one-shot.

`/notify off` prevents future pings; it does not recall a send already in flight. Session reset/shutdown aborts outstanding sends, but cannot recall a message already delivered.
