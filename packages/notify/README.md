# Pi Notify

Phone notifications for the Pi runs you choose to watch, via Telegram or any shell command. Off by default and TUI only: print, JSON, RPC, and subagent sessions never send.

## Install

```sh
pi install npm:@lwlee2608/pi-notify
```

Requires Node.js 22.19+ and Pi 1.0.0. Run `/reload` after installing.

## Set up Telegram

1. Run `/notify setup`, choose **+ Add destination**, then **Telegram**.
2. In Telegram, message @BotFather, send `/newbot`, and paste the token it gives you.
3. Open your new bot in Telegram and send it any message, like "hi".
4. Back in Pi, choose **Find my chat** and pick your chat.
5. Choose **Save and close** and send the test.

Bot tokens are masked as you type and never shown again. To use a shell command instead, see [Shell command connector](#shell-command-connector).

## Use

`/notify` opens a menu. Tab or ←/→ switches between the **Notify** and **Setup** tabs. Nothing changes until **Save and close**.

```text
[ Notify ]     Setup     tab ⇄
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When Pi finishes and waits for you
  After every reply
→ After the next reply only
  Off                               ✓

Also when something specific happens
  No condition                      ✓
  Specific condition

Also, while notifications are on (saved for all sessions)
  Notify on mid-task questions      off
```

| Command or prompt | Result |
| --- | --- |
| `/notify` | Open the menu. |
| `/notify once` | Notify when the next run ends (done or error), then turn off. |
| `/notify on` | Notify after every run in this session. |
| `/notify off` | Turn notifications off. |
| `/notify test` | Send a test now. |
| `/notify setup` | Add or edit destinations. Not available during a run. |
| "Notify me when you finish" | The agent arms a one-shot notification. |
| "Notify me when the tests pass" | The agent notifies when the tests pass, or at the end of the run if they never pass. |

- **Specific condition:** type a condition such as `the tests pass`. The agent decides when it happens and sends a notification at once.
- **Notify on mid-task questions:** also notify when Pi waits for you in a dialog, such as a question picker or an approval prompt. This does not use up a one-shot. Other dialogs opened during a run, such as `/sessions` or `/model-plus`, can also trigger it.
- The status bar shows `🔔 next reply` or `🔔 every reply` while armed. New, resumed, and forked sessions start with notifications off.

## Scenarios

**One-shot: `/notify once`**

```text
/notify once
"fix the login bug"
  agent works ...... run ends ──▶ ✅ my-session · ~/src/app · done
  later runs ───────────────────▶ (nothing; the one-shot is used)
```

**Every run: `/notify on`**

```text
run 1 ── completed ──▶ ✅ … · done
run 2 ── API error ──▶ ❌ … · error
run 3 ── completed ──▶ ✅ … · done      (until /notify off)
```

**Ask in the prompt: "fix the tests, notify me when they pass"**

```text
agent arms a one-shot (sends nothing yet)
agent runs tests ✗, fixes, runs tests ✓
  ──▶ 🔔 … · tests pass        (one-shot used; the end of the run sends nothing)

if the tests never pass:
run ends ──▶ ✅ … · done
```

**Condition in the menu, with After every reply**

```text
/notify: After every reply, condition "build fails"
agent sees the build fail ──▶ 🔔 … · build fails
run ends ───────────────────▶ ✅ … · done
(with After the next reply only, you get only the first message)
```

**Mid-task question, with Notify on mid-task questions on**

```text
agent opens a question dialog ──▶ 🔔 … · waiting for input
you answer, run ends ───────────▶ ✅ … · done
```

**No notification when:**

- You abort the run with Esc. A one-shot stays armed.
- Notifications are off. After `/notify off`, the agent cannot send until your next prompt.
- Pi runs in print, JSON, or RPC mode.
- The config is invalid. Pi shows a warning.

## Privacy

A message contains only the session name, the working directory, and the outcome or the agent's short reason (one line, at most 120 characters):

```text
✅ fix-login · ~/src/app · done
❌ fix-login · ~/src/app · error
🔔 fix-login · ~/src/app · waiting for input
🔔 fix-login · ~/src/app · tests pass
```

No prompt, reply, code, or dialog content is sent. Avoid sensitive session names and directory names if that matters to you.

## Manual config

Setup writes `~/.pi/agent/pi-notify/config.json` (under `PI_CODING_AGENT_DIR` when set). You can also edit it by hand:

```json
{
  "onPrompt": true,
  "nerdFont": false,
  "connectors": [
    { "type": "telegram", "botToken": "$TELEGRAM_BOT_TOKEN", "chatId": "$TELEGRAM_CHAT_ID" }
  ]
}
```

- A value that is only `$VAR` comes from Pi's environment. Literal strings also work.
- `onPrompt` is **Notify on mid-task questions** (default `false`). `nerdFont` shows the Nerd Font bell in the status bar instead of 🔔.
- Every connector gets each notification. Edits apply at the next send, without `/reload`.
- Keep tokens private. Setup saves the file with mode `0600`.

### Shell command connector

Send to ntfy, Slack, or any other service with a local command. The message is in `PI_NOTIFY_TEXT`:

```json
{
  "connectors": [
    { "type": "command", "run": "curl -fsS --data-binary \"$PI_NOTIFY_TEXT\" https://ntfy.sh/YOUR_PRIVATE_TOPIC" }
  ]
}
```

| Service | `run` |
| --- | --- |
| ntfy | `curl -fsS --data-binary "$PI_NOTIFY_TEXT" https://ntfy.sh/YOUR_PRIVATE_TOPIC` |
| Gotify | `curl -fsS --form-string "message=$PI_NOTIFY_TEXT" "https://GOTIFY_HOST/message?token=$GOTIFY_TOKEN"` |
| Pushover | `curl -fsS --form-string "token=$PUSHOVER_TOKEN" --form-string "user=$PUSHOVER_USER" --form-string "message=$PI_NOTIFY_TEXT" https://api.pushover.net/1/messages.json` |
| Bark | `curl -fsS --data-urlencode "body=$PI_NOTIFY_TEXT" "https://api.day.app/$BARK_KEY"` |
| Discord | `curl -fsS --form-string "content=$PI_NOTIFY_TEXT" "$DISCORD_WEBHOOK_URL"` |
| Slack | `jq -n --arg text "$PI_NOTIFY_TEXT" '{text: $text}' \| curl -fsS -H 'Content-Type: application/json' --data-binary @- "$SLACK_WEBHOOK_URL"` |

Escape `"` as `\"` inside JSON. Quote `"$PI_NOTIFY_TEXT"` in the command.

The command runs in the session directory with your shell, your permissions, and your environment, so configure only commands you trust. Exit code 0 means success; output is discarded. Each send times out after 10 seconds. Keep the command in the foreground: Pi cannot stop a background process when it times out.
