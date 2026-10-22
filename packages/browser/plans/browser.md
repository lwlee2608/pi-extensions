# Browser
**The Job** — A pi extension (`packages/browser`) plus a companion Chrome MV3 extension that let the agent drive the user's own signed-in Chrome.
**The Why** — General-purpose browser control: verify web apps the agent just changed, do chores on signed-in sites, and read pages that need login or JS rendering. Without it the agent is blind past `fetch` and the user must click through and report back by hand.
**The Guardrail** — Nothing reaches the browser unless the companion extension is installed and connected; only the pinned extension can talk to the bridge, and only sessions with a UI ever bind it. Existing packages and the root extension list behave as before.
**Done means** — With the Chrome extension loaded, a pi session can open a page, read it, click and type into it, and screenshot it in the user's real Chrome profile.

## Decisions
- **Interview depth** — Key decisions only
- **Scope of use** — All of: localhost app verification, signed-in site automation, reading JS/login-gated pages
- **Who acts** — Agent controls the browser through pi tools; no user-initiated "send to pi" in v1
- **Transport** — Localhost WebSocket: pi extension runs the server on 127.0.0.1, Chrome extension service worker connects as client
- **Bridge auth** — Server accepts only `Origin: chrome-extension://<id>` where the id is pinned by the manifest `key`; no pairing token `agent`
- **Session ownership** — Amended after plan review. One UI session owns the browser at a time: the first to use it (a browser tool call or `/browser`) binds the port; nothing binds at startup. `/browser take` in another session makes the owner release it. Others get an "in use" error naming `/browser take`. Accepted cost: first use after a handover waits up to ~30s for Chrome to reconnect
- **Takeover auth** — A take request is authenticated by a user-only secret on disk, never by origin, so web pages and other extensions cannot force a release `agent`
- **One Chrome at a time** — While one extension connection is live, later ones are refused with a clear error; no replacing, so two profiles cannot flap `agent`
- **Layout** — One package: pi extension in `src/`, unpacked MV3 extension in `chrome/`, both shipped in the npm tarball
- **Automation engine** — `chrome.debugger` (CDP): real input events, console/network access, accessibility-tree snapshots, background screenshots. Accepted cost: Chrome's "debugging this browser" bar while attached
- **Prompt-injection safeguard** — Per-domain approval in pi: the first action of any kind (read included) on a new domain prompts the user
- **Which tabs the agent may touch** — Only tabs in its own "pi" tab group, which it opens itself. Amended after plan review: `tabs` lists only pi-group tabs plus a count of others, so browsing history never reaches the model `agent`
- **Tool surface** — One `browser` tool with an `action` parameter
- **Approval duration** — Prompt offers allow once / for this session / always; "always" persists to a user-editable config under `getAgentDir()`
- **v1 actions** — tabs, navigate, read, click, type, keys, scroll, screenshot, console log, network log, evaluate JS
- **Evaluate JS gate** — Every eval shows its code and asks for confirmation, even on approved domains; "always" domain approval never covers eval
- **Install** — Load unpacked from the package's `chrome/` dir; a command prints that path. Web Store out of scope; adding it later means allowing a second origin
- **Navigate schemes** — `navigate` accepts only `http` and `https`; `javascript:`, `data:`, `file:` and others are refused, since they would bypass the eval gate or host approval `agent`
- **Approval scope** — Exact hostname; checked against the tab's current URL on every action and against the target URL before navigating, so redirects and link hops to a new host prompt again `agent`
- **No UI, no tool** — When `ctx.hasUI` is false (print mode, subagent children), the tool is removed from active tools and the bridge never binds, since approvals need a user `agent`
- **Element refs** — `read` returns a snapshot from the CDP accessibility tree with numbered refs; refs go stale on navigation and the model must read again. Covers shadow DOM and same-process iframes; cross-origin iframes out of scope `agent`
- **Debugger lifetime** — Attach to pi-group tabs on first action; detach all when the bridge disconnects or the tab leaves the group, so the debugging bar disappears when pi exits `agent`
- **Service worker wake** — `chrome.alarms` wakes the worker to reconnect every 30s; a tool call waits up to ~35s for Chrome before failing with install instructions. Clicking the toolbar icon reconnects at once `agent`
- **Port** — Fixed localhost port shared by both sides; no config in v1 `agent`
- **Screenshot** — Brings the pi tab to the front of its own window before capturing; background capture is unreliable because Chrome may not render hidden tabs `agent`
- **Log content** — The network log carries method, URL, status, and resource type only, never headers or bodies; console output passes through truncation like other output `agent`
- **Same-site prompt injection** — Not mitigated: an approved host's content can steer the agent on that host. The README states this plainly next to "always"
- **Local Network Access** — Manifest grants host permission for `127.0.0.1`; phase 1's e2e on current Chrome for Testing proves the extension can reach the bridge, and any LNA block is a finding, not a workaround `research`
- **Output size** — read, console, network, and eval output truncated with a note; screenshots as JPEG `agent`
- **Registration** — Added to root `pi.extensions` and the README table like other packages `research`
- **Existing draft** — Draft `src/bridge.ts` parked on local branch `wip/browser-bridge-draft`; phase 1 starts from it `agent`
- **Local e2e harness** — Chrome for Testing launched with `--load-extension` against a local fixture page server, driving the pi tool through a fake `ExtensionAPI`; local only, not in CI. Stable Chrome no longer honors `--load-extension` `agent`
- **Integration branch** — `integrate/browser` holds the plan and package skeleton. Each phase branches from it and PRs back into it; one final PR to `main`, as notify did `agent`
- **Phase count** — 4; phase 1 ships without the approval gate, acceptable because it only lands on `integrate/browser`
- **README first** — `README.md` is written up front as the v1 spec; each phase keeps it true and amends it where the build proves it wrong `agent`
- **Build mode** — Orchestrator: fresh worker per phase in its own worktree (opus, medium effort); fresh reviewer per round (opus, high effort)
- **Verification budget** — Past builds stalled on wasteful verification; the rules below bind every phase, review round, and merge. Slow is acceptable, waste is not

## Verification budget
- **Time budget** — Targets: full e2e under 30s with Chrome cached, unit tests under 2s. A target, not a cap: never cut coverage to fit. When a run exceeds it, flag it in the phase report with the time, the slow cases, and why they cost that. Waste to avoid: sleeps instead of events, real timeouts where injected ones would do, re-running checks the change could not affect
- **Different checks at each point** — Before the PR: the phase's Verify (its own e2e cases plus unit tests). After a review fix: unit tests plus e2e for the actions the fix touched. Before merge: the full e2e, once
- **Reviewers don't run e2e** — Reviewers read the diff; the worker owns verification
- **Chrome cache outside the repo** — Chrome for Testing downloads once to a shared user cache so worktrees don't re-download it
- **Configurable port for e2e** — e2e runs on its own port, set on both bridge and extension, so it never clashes with a pi session the user has open
- **One CI wait per phase** — Push fixes freely; block on CI once, right before merge

## Progress
Active: 1 · 5/25 tasks

### Phase 1 — Agent opens and reads a page in a "pi" tab group
The agent can open a URL in your real Chrome and get its text and numbered elements back.
**Blocked by:** none
- [x] Finish the WebSocket bridge: origin pinning, one live connection, connect wait, bind on first use in UI sessions only (`src/bridge.ts`, `src/index.ts`)
- [x] Add `/browser take` with secret-authenticated release of the current owner (`src/bridge.ts`, `src/index.ts`)
- [x] Add the MV3 manifest with pinned `key`, debugger/tabs/tabGroups/alarms permissions, and `127.0.0.1` host permission (`chrome/manifest.json`)
- [x] Connect, keep alive, and reconnect on alarm or toolbar click; detach debugger on disconnect (`chrome/background.js`)
- [x] Open tabs into a "pi" tab group and refuse actions on tabs outside it (`chrome/background.js`)
- [ ] Implement `tabs` (pi group plus count of others), `navigate` (http/https only), and `read` with accessibility-tree refs (`chrome/background.js`)
- [ ] Register the `browser` tool with those actions and truncated output (`src/index.ts`)
- [ ] Add `/browser` to print the `chrome/` path, connection state, and owner (`src/index.ts`)
- [ ] Add bridge unit tests: foreign origin rejected, second connection refused, round trip, port in use, take with and without the secret, disconnect fails pending calls (`test/bridge.test.ts`)
- [ ] Let tests set the port, timeouts, and alarm period on both sides (`src/bridge.ts`, `chrome/background.js`)
- [ ] Add the e2e harness and fixture pages, with Chrome cached outside the repo (`test/e2e/`, `package.json` `e2e` script)
- [ ] Register the package and bring the README's install steps in line with what shipped (root `package.json`, root `README.md`, `README.md`)
**Verify:** `npm test -w packages/browser` passes the bridge tests: a second extension connection is refused, a take without the secret is refused, and a take with it frees the port for the taker. `npm run e2e -w packages/browser` opens Chrome for Testing, the extension reaches the bridge on `127.0.0.1`, the tool navigates to the fixture page, a "pi" tab group holds that tab, and `read` returns the fixture's heading text and a ref for its button; a `read` on a tab outside the group fails; `tabs` shows the pi tab and only a count for the others; `navigate` to a `javascript:` URL fails; closing the bridge detaches the debugger from the tab; after the test stops the service worker, it reconnects on its own within the test alarm period. The phase report states the full-run time and flags it if over budget.

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
- [ ] Implement `screenshot` as JPEG, bringing the pi tab to the front of its window first (`chrome/background.js`)
- [ ] Expose the actions and return screenshots as image content (`src/index.ts`)
- [ ] Add a fixture form and e2e cases for each action (`test/e2e/`)
**Verify:** `npm run e2e -w packages/browser`: the tool types into the fixture form, presses Enter, and the next `read` shows the fixture's "submitted: <text>" result; `scroll` reveals an element below the fold; `screenshot` of a pi tab that was behind another tab in its window returns a decodable JPEG of the fixture page.

### Phase 4 — Agent debugs apps: console, network, eval
The agent can see page errors and requests and run JS you approve.
**Blocked by:** 3
- [ ] Buffer console messages and network requests per pi tab; network keeps method, URL, status, and type only (`chrome/background.js`)
- [ ] Implement `console`, `network`, and `eval` (`chrome/background.js`)
- [ ] Confirm every eval with its code shown, outside domain approval (`src/approval.ts`, `src/index.ts`)
- [ ] Add fixture errors and fetches, and e2e cases (`test/e2e/`)
- [ ] Bring the README in line with what shipped and drop its "In development" note (`README.md`)
**Verify:** `npm run e2e -w packages/browser`: `console` returns the fixture's logged error; `network` lists the fixture's fetch with its status code and no header or body content, even though the fixture sends an `Authorization` header; `eval` of `document.title` calls the stubbed confirm with that code and returns the title; a declined confirm makes the tool fail, even on an "always" host.

## Demo
Steps the user runs: load `chrome/` unpacked, start pi, ask it to open a localhost app and a signed-in site. Expect: a "pi" tab group appears, a domain approval prompt per new host, the agent reads the page, fills and submits a form, reports console errors, and returns a screenshot; an eval asks with its code shown; quitting pi clears the debugging bar; `/browser take` in a second pi session moves the browser to it.
