# Pi Notify

Phone notifications for Pi runs you choose to watch. Off by default, TUI only; no sends from print/JSON/RPC sessions or subagent children.

## Install

```sh
pi install npm:@lwlee2608/pi-notify
```

Requires Node.js 22.19+ and Pi 1.0.0. Run `/reload` after installing.

## Configure

Quick start with Telegram:

1. Run `/notify setup`, choose **+ Add destination**, then **Telegram**.
2. In Telegram, message @BotFather, send `/newbot`, and paste the token it gives you.
3. Open your new bot in Telegram and send it any message, like "hi".
4. Back in Pi, choose **Find my chat** and pick your chat.
5. Choose **Save and close**, send the test, then run `/notify` and pick when to get notified.

The setup menu lists destinations (Telegram and custom commands) and options (`onPrompt` as "Notify when Pi needs an answer", `nerdFont` as "Nerd Font bell icon"), with Save and close or Discard and close below a divider. It offers a test send after saving.

- Changes stay in a draft until Save and close. Discard and close or Esc at the menu writes nothing; Esc in a sub-dialog goes back.
- For Telegram, **Find my chat** reads the bot's recent messages and lists the chats to pick from. **Type a chat ID (advanced)** accepts a chat ID, `@channel`, or `$VAR`.
- Literal bot tokens are masked as you type and never shown again. On edit, empty input keeps the stored token. `$VAR` references stay readable and are saved unexpanded.
- Setup is refused during a run; try again when it finishes. A second `/notify setup` while one is open shows a notice instead of a new dialog; if you cannot see the open one, `/reload` clears it. A session reset closes setup without writing.
- If the file changed since setup opened, Save and close asks before overwriting it.
- Malformed JSON, a non-object file, or a `connectors` value that is not an array is refused with a warning; fix those by hand. A bad connector opens normally so it can be fixed.
- Saving a config that fails validation asks first, offers no test, and keeps all notifications refused until it is fixed.
- Unknown keys survive a save. Unknown destination types and multi-line `run` values show `(remove only)`; edit a multi-line `run` in the file.
- Setup never changes arming. The test send runs every connector, including shell commands, and only on an explicit yes.
- The file is written atomically with mode `0600`, and a symlinked config is written through.

### Manual config

Setup and hand edits share one file. To write it yourself, create `~/.pi/agent/pi-notify/config.json` (under `PI_CODING_AGENT_DIR` when overridden):

```json
{
  "onPrompt": true,
  "connectors": [
    { "type": "telegram", "botToken": "$TELEGRAM_BOT_TOKEN", "chatId": "$TELEGRAM_CHAT_ID" }
  ]
}
```

Create a bot with Telegram's BotFather, start a conversation with it, and supply the destination chat ID. Export the environment variables before starting Pi, or supply literal strings. A string consisting entirely of `$VAR` resolves from Pi's environment; missing or empty values are rejected. Keep tokens private and restrict access to the config file.

At least one valid connector is required. Every connector fires on each ping; `onPrompt` defaults to `false`. Set `"nerdFont": true` to show the Nerd Font bell (U+F0F3) instead of 🔔 in the status; it applies on the next arming, and outgoing messages keep standard emoji. Config is read for every command, tool arming request, and send, so edits apply without `/reload`. Invalid config refuses arming and leaves notifications off. Send failures show a warning per connector without exposing command output or tokens.

### Shell command connector

Route to ntfy, Slack, apprise, or any service with a local command:

```json
{
  "connectors": [
    { "type": "command", "run": "curl --fail --silent --show-error --data-binary \"$PI_NOTIFY_TEXT\" https://ntfy.sh/YOUR_PRIVATE_TOPIC" }
  ]
}
```

Example `run` values for common services (escape `"` as `\"` inside JSON):

| Service | `run` |
| --- | --- |
| ntfy | `curl -fsS --data-binary "$PI_NOTIFY_TEXT" https://ntfy.sh/YOUR_PRIVATE_TOPIC` |
| Gotify | `curl -fsS --form-string "message=$PI_NOTIFY_TEXT" "https://GOTIFY_HOST/message?token=$GOTIFY_TOKEN"` |
| Pushover | `curl -fsS --form-string "token=$PUSHOVER_TOKEN" --form-string "user=$PUSHOVER_USER" --form-string "message=$PI_NOTIFY_TEXT" https://api.pushover.net/1/messages.json` |
| Bark | `curl -fsS --data-urlencode "body=$PI_NOTIFY_TEXT" "https://api.day.app/$BARK_KEY"` |
| Discord | `curl -fsS --form-string "content=$PI_NOTIFY_TEXT" "$DISCORD_WEBHOOK_URL"` |
| Slack | `jq -n --arg text "$PI_NOTIFY_TEXT" '{text: $text}' \| curl -fsS -H 'Content-Type: application/json' --data-binary @- "$SLACK_WEBHOOK_URL"` |

`run` executes in the session working directory using the platform shell and inherited environment. The notification is passed as `PI_NOTIFY_TEXT`, never interpolated into the command itself. Quote `"$PI_NOTIFY_TEXT"` in POSIX-shell commands. Telegram and command connectors can be mixed in the same array.

Only configure commands you trust: they execute with your permissions and can access local files and environment secrets. The extension supplies no prompt, reply, or code content (only the agent's short reason, when the user asked for one), but a command you configure can read that content itself. Keep commands in the foreground. Output is discarded; exit code zero means success. Each send has a 10-second timeout; timeout or session reset kills the process group on POSIX (the shell process on Windows). Do not use detached/background processes that escape this cleanup. Sends run in the background and do not hold up Pi's lifecycle events.

## Use

`/notify` opens a menu:

```text
Notify me

When Pi finishes
  Every time
→ Next time only
  Off                              ✓

Saved setting, used while notifications are on
  Notify when Pi needs an answer   off

────────────
  Send a test
  Setup

Tip: say "notify me when <something>" in your prompt.
```

The cursor starts on **Next time only**, so `/notify` then Enter arms one notification. ✓ marks the current choice. **Notify when Pi needs an answer** flips `onPrompt` in the config file, so it applies to all sessions, and keeps the menu open. After each choice, Pi says in one sentence when the notification fires. If the config is missing or invalid, the title shows why and the cursor starts on **Setup**.

| Command or prompt | Result |
| --- | --- |
| `/notify` | Open the menu. |
| `/notify once` | Notify when the next run completes or errors, then turn off. |
| `/notify on` | Notify each time a run completes or errors in this session. |
| `/notify off` | Turn notifications off. |
| `/notify test` | Send a test now without changing arming. |
| `/notify setup` | Create or edit the config in the TUI. Refused during a run. |
| “Notify me when you finish” | The agent calls `notify_me` to arm one-shot; `/notify on` stays on. |
| “Notify me when the tests pass” | The agent arms one-shot as a fallback, then calls `notify_me` with a reason such as `tests pass` when it happens. That sends at once and uses up the one-shot, so the end of the run does not send again (with `/notify on`, it still does). If it never happens, the end of the run still sends. |

The agent's tool description restricts `notify_me` to explicit user requests; it must not notify proactively. Whether a condition happened is the agent's judgment. The tool is removed from active tools outside TUI, and calls outside TUI fail. Arming shows `🔔 next finish` or `🔔 every finish` in extension status (including Pi Footer). New, resumed, and forked sessions reset to off; arming is never persisted.

Notifications contain only the optional session name, working directory, and outcome, or the agent's short reason (at most 120 characters, on one line):

```text
✅ fix-login · ~/src/app · done
❌ fix-login · ~/src/app · error
🔔 fix-login · ~/src/app · waiting for input
🔔 fix-login · ~/src/app · tests pass
```

Session names, directory paths, and agent reasons are sent to your configured destinations; avoid sensitive names if that matters to you.

With `onPrompt: true`, a blocking extension UI prompt during an active run also sends “waiting for input.” Its title and content are never included. Idle prompts do not send, and prompt pings do not consume one-shot: the eventual completed/error settle still sends. Commands such as `/sessions`, `/subagents`, or `/model-plus` opened during a run can also trigger this ping because Pi's prompt event does not identify its source.

### Settlement and cancellation limits

A run that settles to ask a question consumes one-shot, even if you expected more work afterward. Automatic continuations do not send until the final settlement.

Normal aborts send nothing and keep one-shot armed. **Accepted Pi limitation:** Escape during a pending asynchronous `agent_before_settle` handler does not update the previously recorded completion/error outcome, and Pi exposes no final cancellation state at settlement. That narrow case can still send a notification and consume one-shot.

`/notify off` prevents future end-of-run and prompt pings; it does not recall a send already in flight, and it does not stop the agent from sending a reason the user asked for. Session reset/shutdown aborts outstanding sends, but cannot recall a message already delivered.
