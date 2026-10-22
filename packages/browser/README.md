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

**Requirements:** desktop Google Chrome 120+, Node.js 22.19+, Pi 1.0.0.

1. Install the Pi package:

   ```sh
   pi install npm:@lwlee2608/pi-browser
   ```

   Run `/reload` if Pi is already open.

2. Run `/browser` in Pi. It prints the path to the bundled Chrome extension and claims the browser for this session.

3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select that path. On macOS, press **Cmd+Shift+G** in the folder picker to paste it.

4. Run `/browser` again. It should report Chrome as connected. If not, click the Pi Browser toolbar icon to reconnect.

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
| `navigate` | Load an `http`/`https` URL in the current pi tab, or a new one. Other schemes are refused. |
| `read` | Page text plus numbered element refs from the accessibility tree. |
| `click` | Click a ref with real mouse events. |
| `type` | Focus a ref and insert text at its cursor. |
| `keys` | Press keys or combos, like `Enter`, `Shift+Tab`, or select-all (`Meta+a` on macOS, `Control+a` elsewhere), after focusing a ref if given. |
| `scroll` | Scroll a ref into view. |
| `screenshot` | JPEG of a pi tab's visible area at CSS pixel size, so high-density screens don't produce oversized images. Brings that tab to the front of its window first. |
| `console` | Recent console messages from a pi tab. |
| `network` | Recent requests: method, URL, status, and type. Never headers or bodies. |
| `eval` | Run JavaScript in the page. You confirm the code every time. |

Page actions take an optional tab id and default to the current pi tab. Refs come from the tab's last `read` and go stale when the page navigates (or, for refs inside a frame, when that frame does); the agent reads again to get fresh ones. `click`, `type`, and `keys` don't wait for a page they trigger to load; the agent reads to see the result.

| Command | Result |
| --- | --- |
| `/browser` | Extension path, connection state, and which session owns the browser. |
| `/browser take` | Move the browser to this session. |

### Site approval

The first action on a new host, reads included, asks you in Pi:

- **Allow once:** this action only.
- **This session:** until the session ends.
- **Always:** saved to `~/.pi/agent/pi-browser/config.json` (under `PI_CODING_AGENT_DIR` when set) as `{ "allowedHosts": ["example.com"] }`. Remove a host there to revoke it; the file is read on every action.
- **Deny:** the action fails. The next action on that host asks again.

Approval matches the exact hostname, so `github.com` doesn't cover `gist.github.com`. It covers the tab's page and the same-site frames inside it, so a `github.com` page that embeds a `gist.github.com` frame shows that frame's text too. `read` skips cross-site frames, but `screenshot` shows whatever is visible in the tab, cross-site frames included. It is checked against the tab's page before every action, against the target before every navigation, and against where the page ended up after it, so a redirect or link to a new host asks again. `tabs` asks nothing; a pi tab on a host you haven't approved shows only its host, never its title or full URL. `eval` always asks, even on an "always" host.

A pi tab showing anything other than an `http`/`https` page, such as `about:blank`, `data:`, or `chrome:`, has no host to approve, so every action on it is refused and `tabs` shows only its scheme. That stops a page from writing into a blank tab it opened and having the agent read it unasked. Navigate the tab to use it again.

### One session at a time

The first Pi session to use the browser owns it; others get an "in use" error. Run `/browser take` in the session that should have it. Chrome reconnects to the new owner within about 30 seconds; click the Pi Browser toolbar icon to reconnect at once.

The tool only exists in interactive sessions. Print mode, JSON/RPC mode, and subagent children never see it, because approvals need you.

### While the agent works

Chrome shows a "Pi Browser started debugging this browser" bar while the agent is attached. It goes away when Pi exits. Clicking **Cancel** on the bar takes control away from the agent: Pi Browser refuses every action until you click its toolbar icon.

## Safety

- **Pi accepts only this extension.** The bridge listens on loopback and accepts only the companion's pinned extension ID, so web pages and other extensions can't reach it. A local program running as you could forge that, but such a program can already read your Chrome profile.
- **The extension does not authenticate Pi.** While no Pi session holds the port, any local process that listens on `127.0.0.1:47823` can drive the extension, skipping Pi's site approval and eval confirmation. The extension still refuses anything but `http`/`https` on its own. This matters most on machines shared with other OS users or running untrusted local apps.
- **Approved sites can steer the agent.** Approval is about where the agent may go, not what it reads there. Text on an approved site, such as an issue comment, an email, or a review, can contain instructions the agent may follow on that site. Use "always" only for sites whose content you trust, and watch the agent on sites with user-written content.
- **Page content goes to your model provider**, like any other tool output.
- **Network logs skip headers and bodies**, so tokens and cookies don't land in the transcript. Page text, console output, and eval results are returned as-is.
- **Only you can move the browser.** `/browser take` proves itself with a secret in `~/.pi/agent/pi-browser/secret`, readable only by you, so a web page can't make the owning session let go.
- **The bridge exists only while a Pi session uses the browser.** It closes when Pi exits.

## Limits

- One Chrome profile at a time. A second connected Chrome is refused.
- Cross-origin iframes, native dialogs, file pickers, password-manager popups, passkeys, and CAPTCHAs are out of reach.
- An action that opens an `alert`, `confirm`, or `prompt` dialog fails at once and leaves the dialog for you to answer in Chrome; the tab is blocked until you do.
- No hover and no wheel scrolling: Chrome doesn't answer those events in a tab that isn't in front. `scroll` brings a ref into view instead.
- Chrome can't load this extension with `--load-extension` anymore; load it unpacked.
- After updating the package, reload Pi Browser in `chrome://extensions`.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Chrome not connected" | Check that Pi Browser is enabled in `chrome://extensions`, then click its toolbar icon. |
| "in use" | Another Pi session owns the browser. Run `/browser take`. |
| Agent says a ref is gone | The page changed, or Chrome restarted the extension. It should `read` again. |

## Development

`npm run e2e -w packages/browser` loads `chrome/` into Chrome for Testing, headless with a temporary profile, and drives the tool against local fixture pages on its own port. The first run downloads Chrome for Testing to `~/.cache/pi-browser/` (or `$XDG_CACHE_HOME`). It runs locally only, not in CI.
