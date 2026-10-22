# Browser
**The Job** — A pi extension (`packages/browser`) plus a companion Chrome MV3 extension that let the agent drive the user's own signed-in Chrome.
**The Why** — General-purpose browser control: verify web apps the agent just changed, do chores on signed-in sites, and read pages that need login or JS rendering. Without it the agent is blind past `fetch` and the user must click through and report back by hand.
**The Guardrail** — Nothing reaches the browser unless the companion extension is installed and connected; only the pinned extension can talk to the bridge. Existing packages and the root extension list behave as before.
**Done means** — With the Chrome extension loaded, a pi session can open a page, read it, click and type into it, and screenshot it in the user's real Chrome profile.

## Decisions
- **Interview depth** — Key decisions only
- **Scope of use** — All of: localhost app verification, signed-in site automation, reading JS/login-gated pages
- **Who acts** — Agent controls the browser through pi tools; no user-initiated "send to pi" in v1
- **Transport** — Localhost WebSocket: pi extension runs the server on 127.0.0.1, Chrome extension service worker connects as client
- **Bridge auth** — Server accepts only `Origin: chrome-extension://<id>` where the id is pinned by the manifest `key`; no pairing token `agent`
- **Session ownership** — One pi session owns the browser at a time (first to bind the port); others get a clear "in use" error and retry binding on each tool call
- **Layout** — One package: pi extension in `src/`, unpacked MV3 extension in `chrome/`, both shipped in the npm tarball
- **Automation engine** — `chrome.debugger` (CDP): real input events, console/network access, accessibility-tree snapshots, background screenshots. Accepted cost: Chrome's "debugging this browser" bar while attached
- **Prompt-injection safeguard** — Per-domain approval in pi: the first action of any kind (read included) on a new domain prompts the user
- **Which tabs the agent may touch** — Only tabs in its own "pi" tab group, which it opens itself; it may list the user's other tabs but not act on them
- **Tool surface** — One `browser` tool with an `action` parameter
- **Approval duration** — Prompt offers allow once / for this session / always; "always" persists to a user-editable config under `getAgentDir()`
- **v1 actions** — tabs, navigate, read, click, type, keys, scroll, screenshot, console log, network log, evaluate JS
- **Evaluate JS gate** — Every eval shows its code and asks for confirmation, even on approved domains; "always" domain approval never covers eval
- **Install** — Load unpacked from the package's `chrome/` dir; a command prints that path. Web Store out of scope; adding it later means allowing a second origin
- **Approval scope** — Exact hostname; checked against the tab's current URL on every action and against the target URL before navigating, so redirects and link hops to a new host prompt again `agent`
- **No UI, no tool** — The tool is removed from active tools when `ctx.hasUI` is false (print mode, subagent children), since approvals need a user `agent`
- **Element refs** — `read` returns a snapshot from the CDP accessibility tree with numbered refs; refs go stale on navigation and the model must read again. Covers shadow DOM and same-process iframes; cross-origin iframes out of scope `agent`
- **Debugger lifetime** — Attach to pi-group tabs on first action; detach all when the bridge disconnects or the tab leaves the group, so the debugging bar disappears when pi exits `agent`
- **Service worker wake** — `chrome.alarms` wakes the worker to reconnect every 30s; a tool call waits up to ~35s for Chrome before failing with install instructions. Clicking the toolbar icon reconnects at once `agent`
- **Port** — Fixed localhost port shared by both sides; no config in v1 `agent`
- **Output size** — read, console, network, and eval output truncated with a note; screenshots as JPEG `agent`
- **Registration** — Added to root `pi.extensions` and the README table like other packages `research`
- **Existing draft** — Draft `src/bridge.ts` parked on local branch `wip/browser-bridge-draft`; phase 1 starts from it `agent`
- **Local e2e harness** — Chrome for Testing launched with `--load-extension` against a local fixture page server, driving the pi tool through a fake `ExtensionAPI`; local only, not in CI. Stable Chrome no longer honors `--load-extension` `agent`
- **Integration branch** — `integrate/browser` holds the plan and package skeleton. Each phase branches from it and PRs back into it; one final PR to `main`, as notify did `agent`
- **Phase count** — 4; phase 1 ships without the approval gate, acceptable because it only lands on `integrate/browser`

## Progress
Active: 1 · 0/23 tasks

### Phase 1 — Agent opens and reads a page in a "pi" tab group
The agent can open a URL in your real Chrome and get its text and numbered elements back.
**Blocked by:** none
- [ ] Finish the WebSocket bridge with origin pinning, single owner, and connect wait (`src/bridge.ts`)
- [ ] Add the MV3 manifest with pinned `key`, debugger/tabs/tabGroups/alarms permissions (`chrome/manifest.json`)
- [ ] Connect, keep alive, and reconnect on alarm or toolbar click; detach debugger on disconnect (`chrome/background.js`)
- [ ] Open tabs into a "pi" tab group and refuse actions on tabs outside it (`chrome/background.js`)
- [ ] Implement `tabs`, `navigate`, and `read` with accessibility-tree refs (`chrome/background.js`)
- [ ] Register the `browser` tool with those actions and truncated output (`src/index.ts`)
- [ ] Add a command that prints the `chrome/` path and connection state (`src/index.ts`)
- [ ] Add bridge unit tests: foreign origin rejected, round trip, port in use, disconnect fails pending calls (`test/bridge.test.ts`)
- [ ] Add the e2e harness and fixture pages (`test/e2e/`, `package.json` `e2e` script)
- [ ] Register the package and write install steps (root `package.json`, root `README.md`, `README.md`)
**Verify:** `npm test -w packages/browser` passes the bridge tests. `npm run e2e -w packages/browser` opens Chrome for Testing, the tool navigates to the fixture page, a "pi" tab group holds that tab, and `read` returns the fixture's heading text and a ref for its button; a `read` on a tab outside the group fails.

### Phase 2 — You approve each new site
The first action on any new host asks you in pi: allow once, this session, or always.
**Blocked by:** 1
- [ ] Load and save always-allowed hosts in a user config (`src/config.ts`)
- [ ] Gate every action on the tab's current host and every navigate on its target host (`src/approval.ts`, `src/index.ts`)
- [ ] Hide the tool when there is no UI (`src/index.ts`)
- [ ] Test allow once / session / always / deny, persistence, and redirect to a new host (`test/approval.test.ts`, `test/e2e/`)
**Verify:** `npm run e2e -w packages/browser`: navigating to the fixture host calls the stubbed prompt once; "deny" makes the tool fail; "session" skips the prompt on the next action; "always" writes the host to the config and a fresh session does not prompt; a fixture link that redirects to a second host prompts again.

### Phase 3 — Agent clicks, types, scrolls, and screenshots
The agent can fill and submit forms and see the page.
**Blocked by:** 2
- [ ] Implement `click`, `type`, `keys`, and `scroll` by ref with real CDP input events (`chrome/background.js`)
- [ ] Implement `screenshot` for background tabs as JPEG (`chrome/background.js`)
- [ ] Expose the actions and return screenshots as image content (`src/index.ts`)
- [ ] Add a fixture form and e2e cases for each action (`test/e2e/`)
**Verify:** `npm run e2e -w packages/browser`: the tool types into the fixture form, presses Enter, and the next `read` shows the fixture's "submitted: <text>" result; `scroll` reveals an element below the fold; `screenshot` returns a decodable JPEG while the tab is in the background.

### Phase 4 — Agent debugs apps: console, network, eval
The agent can see page errors and requests and run JS you approve.
**Blocked by:** 3
- [ ] Buffer console messages and network requests per pi tab (`chrome/background.js`)
- [ ] Implement `console`, `network`, and `eval` (`chrome/background.js`)
- [ ] Confirm every eval with its code shown, outside domain approval (`src/approval.ts`, `src/index.ts`)
- [ ] Add fixture errors and fetches, and e2e cases (`test/e2e/`)
- [ ] Document actions, safety model, and limits (`README.md`)
**Verify:** `npm run e2e -w packages/browser`: `console` returns the fixture's logged error; `network` lists the fixture's fetch with its status code; `eval` of `document.title` calls the stubbed confirm with that code and returns the title; a declined confirm makes the tool fail, even on an "always" host.

## Demo
Steps the user runs: load `chrome/` unpacked, start pi, ask it to open a localhost app and a signed-in site. Expect: a "pi" tab group appears, a domain approval prompt per new host, the agent reads the page, fills and submits a form, reports console errors, and returns a screenshot; an eval asks with its code shown; quitting pi clears the debugging bar.
