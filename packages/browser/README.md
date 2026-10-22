# Pi Browser

Let Pi use the Chrome you're already signed into. The agent opens pages, reads them, fills forms, takes screenshots, and checks console and network errors, in your real profile, without a separate automation browser.

> **In development** on `integrate/browser`. Not on npm yet; this README describes the finished v1.

## What you can do

| Use case | Ask Pi |
| --- | --- |
| Verify your own app | "Open localhost:3000, submit the signup form with a test email, and tell me what errors show up in the console." |
| Read a signed-in page | "Open my Linear inbox and summarize what's assigned to me. Don't change anything." |
| Do a chore | "On the staging admin page, turn off the beta banner and screenshot the result." |
| Read JS-rendered pages | "Open this dashboard and list the numbers on it." |

## How it works

```
 Pi session                          Chrome (your profile)
┌────────────────────────────┐      ┌───────────────────────────┐
│ browser tool, /browser     │  WS  │ Pi Browser extension      │
│ approval prompts           │◄────►│ (unpacked MV3)            │
│ bridge on 127.0.0.1        │      │ chrome.debugger (CDP)     │
└────────────────────────────┘      └─────────────┬─────────────┘
                                                  │
                                           "pi" tab group
```

The Pi extension runs a small WebSocket server on `127.0.0.1`. The companion Chrome extension connects to it and drives tabs through Chrome's debugger API. The agent only works in tabs it opens itself, collected in a tab group named **pi**. Your other tabs stay out of reach.

## Install

**Requirements:** desktop Google Chrome, Node.js 22.19+, Pi 1.0.0.

1. Install the Pi package:

   ```sh
   pi install npm:@lwlee2608/pi-browser
   ```

   Run `/reload` if Pi is already open.

2. Run `/browser` in Pi. It prints the path to the bundled Chrome extension.

3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select that path. On macOS, press **Cmd+Shift+G** in the folder picker to paste it.

4. Run `/browser` again. It should report Chrome as connected.

Then try a read-only first task:

```text
Open https://example.com and tell me what the page says.
```

> **Trust:** the companion has the `debugger` permission in the profile you load it into. Read [`chrome/`](chrome/) before loading it. Consider a separate Chrome profile if you don't want the agent anywhere near your main one.

## Use

The agent gets one `browser` tool:

| Action | What it does |
| --- | --- |
| `tabs` | List tabs in the pi group. Other tabs are only counted, never listed. |
| `navigate` | Open or load an `http`/`https` URL in a pi tab. Other schemes are refused. |
| `read` | Page text plus numbered element refs from the accessibility tree. |
| `click`, `type`, `keys`, `scroll` | Act on a ref with real input events. |
| `screenshot` | JPEG of a pi tab. Brings that tab to the front of its window first. |
| `console` | Recent console messages from a pi tab. |
| `network` | Recent requests: method, URL, status, and type. Never headers or bodies. |
| `eval` | Run JavaScript in the page. You confirm the code every time. |

Refs go stale after the page navigates; the agent reads again to get fresh ones.

| Command | Result |
| --- | --- |
| `/browser` | Extension path, connection state, and which session owns the browser. |
| `/browser take` | Move the browser to this session. |

### Site approval

The first action on a new host, reads included, asks you in Pi:

- **Allow once:** this action only.
- **This session:** until the session ends.
- **Always:** saved to `~/.pi/agent/pi-browser/config.json` (under `PI_CODING_AGENT_DIR` when set). Remove a host there to revoke it.

Approval matches the exact hostname, so `github.com` doesn't cover `gist.github.com`. It is checked on every action and before every navigation, so a redirect or link to a new host asks again. `eval` always asks, even on an "always" host.

### One session at a time

The first Pi session to use the browser owns it; others get an "in use" error. Run `/browser take` in the session that should have it. Chrome reconnects to the new owner within about 30 seconds; click the Pi Browser toolbar icon to reconnect at once.

The tool only exists in interactive sessions. Print mode, JSON/RPC mode, and subagent children never see it, because approvals need you.

### While the agent works

Chrome shows a "Pi Browser started debugging this browser" bar while the agent is attached. It goes away when Pi exits. Clicking **Cancel** on the bar takes control away from the agent.

## Safety

- **Only this extension can connect.** The bridge listens on loopback and accepts only the companion's pinned extension ID, so web pages and other extensions can't reach it. A local program running as you could forge that, but such a program can already read your Chrome profile.
- **Approved sites can steer the agent.** Approval is about where the agent may go, not what it reads there. Text on an approved site, such as an issue comment, an email, or a review, can contain instructions the agent may follow on that site. Use "always" only for sites whose content you trust, and watch the agent on sites with user-written content.
- **Page content goes to your model provider**, like any other tool output.
- **Network logs skip headers and bodies**, so tokens and cookies don't land in the transcript. Page text, console output, and eval results are returned as-is.
- **The bridge exists only while a Pi session uses the browser.** It closes when Pi exits.

## Limits

- One Chrome profile at a time. A second connected Chrome is refused.
- Cross-origin iframes, native dialogs, file pickers, password-manager popups, passkeys, and CAPTCHAs are out of reach.
- Chrome can't load this extension with `--load-extension` anymore; load it unpacked.
- After updating the package, reload Pi Browser in `chrome://extensions`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Chrome not connected" | Check that Pi Browser is enabled in `chrome://extensions`, then click its toolbar icon. |
| "in use" | Another Pi session owns the browser. Run `/browser take`. |
| Agent says a ref is gone | The page changed. It should `read` again. |
