# Pi Browser

Let Pi use the Chrome you're already signed into. The agent opens pages, reads them, fills forms, takes screenshots, and checks console and network errors, in your real profile, without a separate automation browser.

![Pi filling a conference registration form in Chrome while its browser tool calls stream in the terminal](https://github.com/lwlee2608/pi-extensions/releases/download/media/browser-demo.gif)

## What you can do

| Use case | Ask Pi |
| --- | --- |
| Verify your own app | "Open localhost:3000, submit the signup form with a test email, and tell me what errors show up in the console." |
| Read a signed-in page | "Open my Linear inbox and summarize what's assigned to me. Don't change anything." |
| Do a chore | "On the staging admin page, turn off the beta banner and screenshot the result." |
| Read JS-rendered pages | "Open this dashboard and list the numbers on it." |

## How it works

```
 Pi session "api"            Pi session "docs"
┌────────────────────┐      ┌────────────────────┐
│ browser tool       │      │ browser tool       │
│ approval prompts   │      │ approval prompts   │
│ <session>.sock     │      │ <session>.sock     │
└─────────┬──────────┘      └─────────┬──────────┘
          └──────────────┬────────────┘
                ┌────────┴────────┐
                │   native host   │ started by Chrome
                └────────┬────────┘
                         │ stdio
          ┌──────────────┴──────────────┐
          │ Pi Browser extension (MV3)  │
          │ chrome.debugger (CDP)       │
          └──────┬───────────────┬──────┘
                 │               │
          "pi · api" group  "pi · docs" group
```

Each Pi session listens on its own Unix socket under `~/.pi/agent/pi-browser/sessions/`. Chrome starts a small native messaging host that ships with this package; it finds every session's socket and relays between them and the companion extension, which drives tabs through Chrome's debugger API. No TCP port is opened. Each session works only in the tabs in its own tab group, named **pi · <session name>**. Your other tabs, and other sessions' tabs, stay out of reach.

## Install

**Requirements:** desktop Google Chrome 125+, Brave, or Chromium on Linux or macOS; Node.js 22.19+; Pi 1.0.0 installed with npm. Windows is not supported yet, and neither are Snap or Flatpak browsers, which can't start the native host.

1. Install the Pi package:

   ```sh
   pi install npm:@lwlee2608/pi-browser
   ```

   Run `/reload` if Pi is already open.

2. Run `/browser` in Pi. It prints the path to the bundled Chrome extension and installs the native host: a manifest and a small launcher, pinned to the Node.js running Pi, in the `NativeMessagingHosts` folder of every Chrome, Brave, and Chromium user data folder it finds (`~/.config/...` on Linux, `~/Library/Application Support/...` on macOS). Pi rewrites them on each session's first browser use, so after a Node.js upgrade the host works again once a Pi session uses the browser and the extension reconnects, or you click its icon.

3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select that path. On macOS, press **Cmd+Shift+G** in the folder picker to paste it.

4. Run `/browser` again. It should report Chrome as connected. If not, click the Pi Browser toolbar icon to reconnect; its tooltip says why if it can't start the native host.

Then try a read-only first task:

```text
Open https://example.com and tell me what the page says.
```

> **Trust:** the companion has the `debugger` permission in the profile you load it into, plus `scripting` on all sites, which it uses only to remove other extensions' frames that block the debugger. Read [`chrome/`](chrome/) before loading it. Consider a separate Chrome profile if you don't want the agent anywhere near your main one.

### Upgrading from 0.1

- **Reload the extension.** Open `chrome://extensions` and click reload on Pi Browser after every package update. The 0.1 extension still looks for the old WebSocket bridge, so until you reload it, Pi reports Chrome as not connected and the toolbar icon does nothing. Restart Pi too if it was open during the update.
- **`/browser take` is gone.** Every session gets the browser at once, in its own tab group.
- **No port.** The WebSocket bridge on `127.0.0.1:47823` is gone. The old `~/.pi/agent/pi-browser/secret` file is no longer used; you can delete it.

## Use

The agent gets one `browser` tool:

| Action | What it does |
| --- | --- |
| `tabs` | List tabs in your session's group. Other tabs are only counted, never listed. |
| `navigate` | Load an `http`/`https` URL in the current pi tab, or a new one. Other schemes are refused. |
| `read` | Page text plus numbered element refs from the accessibility tree. |
| `click` | Click a ref, or a point in the tab's last screenshot, with real mouse events: left or right button, once, twice, or three times. Brings that tab to the front of its window first. Fails naming the element on top if something else covers a ref's center; a point's result names the element under it. |
| `type` | Focus a ref and insert text at its cursor, or with no ref, insert it into whatever has focus, such as a field just clicked by point, and fail if nothing has. |
| `keys` | Press keys or combos, like `Enter`, `Shift+Tab`, or select-all (`Meta+a` on macOS, `Control+a` elsewhere), after focusing a ref if given. Brings that tab to the front of its window first. |
| `scroll` | Scroll a ref into view. |
| `screenshot` | JPEG of a pi tab's visible area at CSS pixel size, so high-density screens don't produce oversized images, shrunk to at most 1568 pixels on its long edge and about 1.15 megapixels so models see it unshrunk. The result states its size. Brings that tab to the front of its window first. Also saved to a private `pi-browser-*` folder in the system temp dir; the result gives the path. |
| `console` | Console messages, uncaught exceptions, and Chrome's own warnings from the tab's current page. |
| `network` | Requests from the tab's current page: method, status, type, and URL. Never headers or bodies. |
| `eval` | Run JavaScript in the page's main frame like the DevTools console, and return the last value as JSON, awaiting a promise. Runs without asking on approved sites unless you turn on **Ask before eval** in `/browser settings`. |

Page actions take an optional tab id and default to the current pi tab. Refs come from the tab's last `read` and go stale when the page navigates (or, for refs inside a frame, when that frame does); the agent reads again to get fresh ones. `click`, `type`, and `keys` don't wait for a page they trigger to load; the agent reads to see the result.

A point is `[x, y]` in pixels of the tab's last screenshot, for canvas apps and widgets `read` gives no ref; the extension maps it back to the page, so the model never scales it. A point on a tab with no screenshot fails and asks for one. Points don't follow the page: after it scrolls, navigates, or changes, the agent takes a new screenshot. A point inside a cross-site frame first asks you to approve that frame's host; see [Site approval](#site-approval).

`network` only sees requests made since the agent first acted on the tab, or since Pi last reconnected; when that came after the page loaded, it says so, and reloading the page shows every request. Both logs start over when the tab's page navigates, so they only ever show the page the agent is looking at. They keep the last 200 entries per tab and cut each message or URL at 1,000 characters. Requests and messages from cross-site frames aren't recorded. `eval` returns values that survive JSON, so for a DOM node it should return a property such as `outerHTML`. Synchronous code is stopped after 10 seconds. Output is truncated to 2,000 lines or 50KB, keeping the start of a page and the newest log entries.

| Command | Result |
| --- | --- |
| `/browser` | Extension path, connection state, the connected browser, and your group, like "Your group: pi · api (red)". |
| `/browser settings` | Turn **Ask before eval** on or off, remove one approved site, or forget all approved sites. |

### Site approval

The first action on a new host, reads included, asks you in Pi:

- **Allow once:** this action only.
- **This session:** until the session ends.
- **Always:** saved to `~/.pi/agent/pi-browser/config.json` (under `PI_CODING_AGENT_DIR` when set) as `{ "allowedHosts": ["example.com"] }`. Remove a host with `/browser settings`, or edit the file; it is read on every action.
- **Deny:** the action fails. The next action on that host asks again.

Approval matches the exact hostname, so `github.com` doesn't cover `gist.github.com`. It covers the tab's page and the same-site frames inside it, so a `github.com` page that embeds a `gist.github.com` frame shows that frame's text too. `read` skips cross-site frames, but `screenshot` shows whatever is visible in the tab, cross-site frames included. It is checked against the tab's page before every action, against the target before every navigation, and against where the page ended up after it, so a redirect or link to a new host asks again. `tabs` asks nothing; a pi tab on a host you haven't approved shows only its host, never its title or full URL. `eval` doesn't ask on its own: once a site is approved, eval runs there like any other action, as in Claude in Chrome. A page can carry text that steers the agent into an eval that reads your cookies or sends them elsewhere, so turn on **Ask before eval** in `/browser settings` if you use the browser on sites you don't trust. Then Pi shows you the code and runs it only if you pick **Run all N lines**; anything else fails the call. Eval code is capped at 20 lines and 1,500 characters, may not have two blank lines in a row, and may not contain invisible or control characters other than newline and tab. On a short terminal the top of the code can still scroll out of view, so check that the line count in that option matches the code you see.

A cross-site frame, such as an embed from another site, needs its own host approved before the agent acts in it. A click, at a point or a ref, finds the innermost frame under where it presses, through frames nested in frames; `type` and `keys` find the frame that has focus, through shadow roots too. If the tab's page itself moved to a new host while you were deciding, Pi asks for that host before any input. If that frame is cross-site to the tab's page, Pi asks for the frame's host, not the tab's, with the same choices as above and the same store, so a host approved by navigating to it, clicking in it, or typing into it isn't asked again by another route. One action asks at most once per host: **Allow once** covers that one click, `type`, or `keys`, and the next action in that frame asks again. **Deny** fails the action before any input reaches the frame. A frame on the tab's own site never asks. A click checks the point again after the pointer moves and before each press, and stops if the page slid an unapproved frame under it; `keys` stops if a key moves focus into one, leaving the rest unpressed.

A pi tab showing anything other than an `http`/`https` page, such as `about:blank`, `data:`, or `chrome:`, has no host to approve, so every action on it is refused and `tabs` shows only its scheme. That stops a page from writing into a blank tab it opened and having the agent read it unasked. Navigate the tab to use it again.

### Several sessions at once

Every Pi session that uses the browser gets its own tab group, titled `pi · <session name>` (or the working folder's name for an unnamed session), in a color no other live session uses. Sessions work at the same time without waiting for each other. A session sees and acts only on tabs in its own group, whatever tab id it sends, and `tabs` only counts the rest. Dragging a tab into another session's group hands it to that session. Renaming a session retitles its group on its next action.

When a session exits, its tabs stay open and its group is retitled `pi · <name> (ended)`. Resuming that session takes the group back.

If both Chrome and Brave run the extension, each session goes to whichever browser reached it first; `/browser` names it.

The tool only exists in interactive sessions. Print mode, JSON/RPC mode, and subagent children never see it, because approvals need you.

### While the agent works

Chrome shows a "Pi Browser started debugging this browser" bar while the agent is attached. It goes away when no Pi session is attached. Clicking **Cancel** on the bar takes control away from every session: Pi Browser refuses every action until you click its toolbar icon.

A tab the agent is using glows blue at its edges. A blue dot slides to each element or point the agent clicks, types into, or scrolls to, and pulses on a click. **Stop pi · <name>** at the bottom aborts that session's turn only. All three disappear when the turn ends and are left out of screenshots. The page's own scripts can't see or press them.

Once the agent uses `console` on a tab, Chrome reports that tab's console to the debugger, which some sites detect as automation and answer with a challenge. Other actions don't turn this on.

## Security

**Threat model.** Pi Browser defends against web pages, other extensions, and other users on the same machine. It does not defend against programs running as you: those can already read your Chrome profile, cookies included, so no local check would stop them. A session's boundary is its tab group: a tab you drag into the group, or one a pi tab opens with `window.open`, joins it, and any other extension can move tabs into a pi group. Site approval still gates every action on those tabs.

- **Other OS users can't reach a session.** Each session's socket is readable and writable only by you (`0600`), inside a folder only you can enter (`0700`).
- **Only this extension can start the host.** The native host manifest lists the companion's pinned extension ID in `allowed_origins`, so Chrome refuses to start it for web pages or any other extension. Nothing listens on a TCP port, so there is nothing for a web page or a local process to squat.
- **Sessions can't impersonate each other.** The host labels every message with the socket it came in on, and the extension trusts only that label, never a session name in the message. A session can act only on tabs in its own group.
- **Approved sites can steer the agent.** Approval is about where the agent may go, not what it reads there. Text on an approved site, such as an issue comment, an email, or a review, can contain instructions the agent may follow on that site. Use "always" only for sites whose content you trust, and watch the agent on sites with user-written content.
- **Page content goes to your model provider**, like any other tool output.
- **Network logs skip headers and bodies**, so tokens and cookies in them don't land in the transcript. URLs are kept whole, query strings included. Page text, console output, and eval results are returned as-is, only truncated.
- **A session's socket exists only while it uses the browser.** Pi removes it when the session exits.

## Limits

- Linux and macOS only. Windows waits for a port-based transport ([#43](https://github.com/lwlee2608/pi-extensions/issues/43)).
- Snap and Flatpak browsers can't start the native host. Use a browser installed from a `.deb`, `.rpm`, or the vendor's own package.
- Pi must run on Node.js. A Bun-compiled or single-executable Pi can't pin a Node.js for the host and refuses the browser.
- Each session goes to one browser: the first Chrome profile to reach it. Another profile with the extension is refused for that session until the first lets go.
- The socket path, `~/.pi/agent/pi-browser/sessions/<session id>.sock`, must fit the OS limit (104 bytes on macOS, 108 on Linux). If `PI_CODING_AGENT_DIR` is very long, the browser fails with an error naming the path.
- A session that exits while Chrome has the extension's worker asleep keeps its live group title until Chrome restarts.
- `read` skips cross-site iframes, so the agent reaches them only by points from a screenshot.
- Points assume the model sees the screenshot at the size it was taken. A provider that shrinks images further on its side, such as OpenAI's 768-pixel short side, can make points miss.
- Native dialogs, file pickers, password-manager popups, passkeys, and CAPTCHAs are out of reach.
- An action or `eval` that opens an `alert`, `confirm`, or `prompt` dialog fails at once and leaves the dialog for you to answer in Chrome; the tab is blocked until you do.
- No hover and no wheel scrolling: Chrome doesn't answer those events in a tab that isn't in front. `scroll` brings a ref into view instead.
- Chrome drops clicks and key presses in a tab that isn't in front, and may not render it, so `click`, `keys`, and `screenshot` switch to the pi tab in its window. In a hidden window (minimized, fully covered, on another desktop, or with the screen locked) they fail until you bring it into view.
- Chrome can't load this extension with `--load-extension` anymore; load it unpacked.
- After updating the package, reload Pi Browser in `chrome://extensions`. A stale extension shows up as not connected, or as a protocol mismatch when the update changed the protocol.
- Chrome blocks the debugger on any tab holding another extension's frame, which password managers such as LastPass add to form pages. Pi Browser removes those frames and retries, so the password manager's popup is gone on that page. If a frame can't be removed, actions fail; turn it off for that site, or use a Chrome profile without it ([#34](https://github.com/lwlee2608/pi-extensions/issues/34)).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Chrome extension is not connected" | Check that Pi Browser is enabled in `chrome://extensions`, and reload it there after an update. Then click its toolbar icon. Hover the icon: if it says it can't start the native host, run `/browser` once to install it and click the icon again. |
| "Pi Browser protocol versions do not match" | Reload Pi Browser in `chrome://extensions`. If that doesn't help, restart Pi. |
| "Tab N is not in your group" | That tab belongs to another session or to none. Use your own pi tabs, or `navigate` with `newTab`. |
| Agent says a ref is gone | The page changed, or Chrome restarted the extension. It should `read` again. |

## Development

`npm run e2e -w packages/browser` loads `chrome/` into Chrome for Testing, headless with a temporary profile, and drives the tool against local fixture pages, with the native host manifest in that profile and its own sessions folder. The first run downloads Chrome for Testing to `~/.cache/pi-browser/` (or `$XDG_CACHE_HOME`). It runs locally only, not in CI.
