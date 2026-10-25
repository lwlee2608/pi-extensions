# Browser multi-session
**The Job** — Replace the single-owner WebSocket bridge with a native messaging host plus one Unix socket per pi session, so each pi session drives its own Chrome tab group at the same time, behind a transport seam that a later port-range + HMAC transport (issue #43 Option B) can plug into.
**The Why** — The user runs several pi sessions in parallel that each need the browser. Today the second session gets "in use", `/browser take` yanks Chrome from the first with a ~30s reconnect, and while no pi holds port 47823 any local process can squat it and drive the extension.
**The Guardrail** — Every v1 gate stays: per-host approval, eval confirmation, http/https-only navigate, pi-group-only tabs, no tool without UI. A session never sees or touches another session's tabs. The tool's actions and parameters stay the same.
**Done means** — Two pi sessions open at once each get their own labelled tab group in the user's Chrome, drive it concurrently without interfering, and no TCP port is open.

## Decisions
- **Interview depth** — Key decisions only
- **Scope** — Option A only. Option B is a later plan; this one leaves a transport seam on both the pi and extension side so B adds a transport without touching session or group logic
- **Session identity** — A session's identity is the socket it came in on, never a field in the message; the host tags each frame with the socket's session, and the extension trusts only that tag. Sockets named by `sessionId` (`getSessionId()` exists), group title uses the session name `research`
- **Isolation** — Enforced in the extension: every tab-taking action checks the tab is in the calling session's group by `groupId`, whatever `tabId` is sent. The session→group map lives in `chrome.storage.session`; `current`, refs, logs, dialogs and debugger attach are per session
- **Threat model** — Sockets 0600 in a 0700 dir block other OS users; Chrome's `allowed_origins` limits the host to the pinned extension ID. Same-user processes are out of scope (they can read the Chrome profile anyway); README says so
- **Native host location for e2e** — Chrome reads user-level host manifests from `<user-data-dir>/NativeMessagingHosts`, so e2e writes the manifest into its temp profile; phase 1 e2e proves this on Chrome for Testing, and a failure is a finding `research`
- **Removed** — Fixed port 47823, the take secret and HTTP endpoints, `/browser take`, the WebSocket keepalive and reconnect alarm (an open native port keeps the MV3 worker alive) `research`
- **Chrome + Brave both running** — First claim wins: each session socket accepts one host connection and refuses later ones; `/browser` names the browser that won
- **Session exit** — Tabs stay; the group is retitled `pi · <name> (ended)` and untracked. A resumed session with the same id re-adopts its group if it still exists
- **Host install** — Automatic on first browser use: pi writes the host manifest and a wrapper pinned to the current Node path into every detected Chrome, Brave and Chromium config dir, atomically, so Node upgrades self-heal
- **Group placement** — Every session's group opens in the user's current window; screenshots are serialized per window so concurrent sessions don't capture each other's tab
- **Platforms** — Linux and macOS. Windows gets a clear "not supported until the port transport" error
- **Labels** — Group title `pi · <session name>`, a distinct color per live session, `/browser` prints "Your group: pi · foo (red)", the overlay's Stop button names the session
- **Host program** — A Node script shipped in the package; it writes only framed messages to stdout and logs to stderr `agent`
- **Session discovery** — The host scans the sessions dir on start and watches it; it skips sockets that refuse. pi unlinks a stale socket at its own path before binding and removes it on shutdown `agent`
- **Socket path length** — If the socket path exceeds the OS limit (104 bytes on macOS), the browser fails with an error naming the path `agent`
- **Version handshake** — pi, host and extension exchange a protocol version on connect; a mismatch fails with "reload the Pi Browser extension" instead of odd errors `agent`
- **Host reconnect** — The extension reconnects to the host with backoff if it exits; a toolbar click reconnects at once `agent`
- **No host found** — When `connectNative` fails (Snap, Flatpak, missing manifest), the toolbar title says why and `/browser` mentions Snap/Flatpak `agent`
- **Group color** — The first color no other live pi group uses; repeats once all nine are taken `agent`
- **Renamed session** — The group title follows the session name on the next action `agent`
- **Tab dragged between groups** — Group membership is the truth: a tab the user drags into another session's group belongs to that session `agent`
- **Debugger cancel** — Chrome's Cancel on the debugging bar detaches every tab, so the canceled state stays browser-wide until a toolbar click `agent`
- **Overlay Stop** — Stops only the session that owns the tab `agent`
- **Old files** — The unused `pi-browser/secret` file is left in place `agent`
- **Release** — Minor version bump of package and manifest; README calls out that the extension must be reloaded and `/browser take` is gone, and gains a Security section `agent`
- **Integration branch** — `integrate/browser-sessions` holds the plan; each phase PRs into it; one final PR to `main`, as v1 did `agent`
- **Verification budget** — The v1 rules in `plans/browser.md` carry over: e2e under 30s cached, unit under 2s, own sessions dir for e2e, reviewers don't run e2e, one CI wait per phase `agent`
- **Build mode** — As v1: orchestrator with a fresh worker per phase in its own worktree, a fresh reviewer per review round; worker Opus 5.5 high, reviewer Opus 5.5 high
- **Demo** — User runs steps in their own Google Chrome (see Demo)
- **Phase count** — 4, sequential: phases share `chrome/background.js` and `src/host.ts`

## Progress
Active: 1 · 8/27 tasks

### Phase 1 — One session drives Chrome with no TCP port open
Today's single-session browser works exactly as before, but over the native host and a 0600 Unix socket, so nothing can squat a port.
**Blocked by:** none
- [x] Add a transport seam between session logic and the connection, pi side (`src/bridge.ts`) and extension side (`chrome/background.js`)
- [x] Listen on a per-session Unix socket under the agent dir, 0600 in a 0700 folder, unlinking a stale one first and removing it on shutdown (`src/bridge.ts`)
- [x] Add the native host: relay framed stdio to session sockets, scan and watch the sessions folder, skip sockets that refuse (`src/host.ts`)
- [x] Install the host manifest and Node-pinned wrapper into detected Linux Chrome, Brave and Chromium config dirs on first use (`src/install.ts`)
- [x] Connect to the host with `connectNative`, reconnect with backoff, and add the `nativeMessaging` permission (`chrome/background.js`, `chrome/manifest.json`)
- [x] Remove port 47823, the take secret and HTTP endpoints, `/browser take`, keepalive and the reconnect alarm (`src/bridge.ts`, `src/index.ts`, `chrome/background.js`)
- [x] Run e2e over the native host with the manifest in the temp profile and its own sessions folder (`test/e2e/`)
- [x] Unit-test host relay and socket lifecycle with fake stdio and sockets (`test/`)
- Note: the host is `src/host.js`, not `.ts`: Node refuses to strip types under `node_modules`, where pi installs packages, so a `.ts` host would only run from a checkout. Phases 2 and 4 edit `src/host.js`; it also holds the frame codec `src/bridge.ts` imports (`allowJs` in the package tsconfig)
- Note: e2e proves headless Chrome for Testing 156 reads the host manifest from `<user-data-dir>/NativeMessagingHosts`
- Note: with no alarm, a service worker stopped from outside restarts only on an event it listens to (tab update, toolbar click, browser startup via `runtime.onStartup`); the two e2e worker-restart cases now wake it by opening a tab
- Note: the bridge still refuses a second host connection, as v1 did; the refused host retries every 5s, so it takes over once the first Chrome leaves, and a toolbar click with no session linked restarts the host at once. Phase 2 replaces this with first-claim-wins
- Note: README still describes port 47823 and `/browser take` until phase 4 rewrites it; the `ws` dependency is gone and the e2e CDP client uses Node's built-in `WebSocket`
- Note: e2e on this host still needs a local, uncommitted `--no-sandbox` (AppArmor), as in v1
**Verify:** `npm run e2e` passes every existing case over the native host, plus a new case that asserts no TCP listener exists while the agent reads a page; `npm test` covers relay framing and stale-socket cleanup.

### Phase 2 — Two sessions drive their own groups at the same time
A second pi session gets its own `pi · <name>` group in a distinct color and works alongside the first; neither can touch the other's tabs.
**Blocked by:** 1
- [ ] Relay several sockets at once, tagging each frame with the socket's session; each socket accepts only its first host (`src/host.ts`)
- [ ] Map session to `groupId` in `chrome.storage.session` and find groups by id, not title (`chrome/background.js`)
- [ ] Keep `current`, refs, logs, dialogs and debugger attach per session (`chrome/background.js`)
- [ ] Refuse any tab outside the caller's group, whatever `tabId` is sent (`chrome/background.js`)
- [ ] Title groups `pi · <session name>` with the first unused color, following renames on the next action (`chrome/background.js`, `src/index.ts`)
- [ ] Serialize screenshots per window (`chrome/background.js`)
- [ ] Send overlay Stop only to the session owning the tab (`chrome/background.js`)
- [ ] Add e2e cases for two sessions: concurrent navigate and read, `tabs` lists only own tabs, another session's `tabId` is refused (`test/e2e/`)
**Verify:** `npm run e2e` two-session cases pass: both sessions read their own page concurrently, each `tabs` shows only its own tab, and session B acting on session A's `tabId` fails with "not in your group".

### Phase 3 — See which group is yours, and keep it after exit
`/browser` tells you your group and browser, the overlay names the session, and an exited session's tabs stay put as `(ended)`.
**Blocked by:** 2
- [ ] Print "Your group: pi · foo (red)" and the connected browser in `/browser` (`src/index.ts`)
- [ ] Name the session on the overlay's Stop button (`chrome/background.js`)
- [ ] Retitle a session's group `pi · <name> (ended)` and untrack it when its socket closes (`chrome/background.js`)
- [ ] Re-adopt the group when a session with the same id connects again (`chrome/background.js`)
- [ ] Add e2e cases for exit retitle and resume re-adopt, and unit tests for `/browser` output (`test/`)
**Verify:** `npm run e2e`: after a session shuts down its group title ends in `(ended)` and its tabs remain; reconnecting with the same session id acts in that same group. `npm test` checks `/browser` prints group, color and browser.

### Phase 4 — macOS install, clear errors, and release notes
macOS works, and every unsupported setup fails with a message saying what to do.
**Blocked by:** 3
- [ ] Install manifests into macOS Chrome, Brave and Chromium paths (`src/install.ts`)
- [ ] Refuse Windows with a "not supported until the port transport" error (`src/index.ts`)
- [ ] Fail with an error naming the path when the socket path is over the OS limit (`src/bridge.ts`)
- [ ] Exchange a protocol version on connect and fail with "reload the Pi Browser extension" on mismatch (`src/bridge.ts`, `src/host.ts`, `chrome/background.js`)
- [ ] Explain a failed `connectNative` in the toolbar title, and mention Snap/Flatpak in `/browser` (`chrome/background.js`, `src/index.ts`)
- [ ] Rewrite install and add a Security section, note the reload and that `/browser take` is gone; bump package and manifest minor version (`README.md`, `package.json`, `chrome/manifest.json`)
**Verify:** `npm test` writes manifests under a fake macOS home at the expected paths, rejects an over-long socket path and a Windows platform with their messages; `npm run e2e` with a mismatched extension version fails with "reload the Pi Browser extension".

## Demo
In your own Google Chrome, with the extension loaded unpacked (or reloaded):
1. Start two pi sessions with different names; ask each to open a different page.
2. See two groups, `pi · <name>`, in different colors, both working at once.
3. In session B, ask it to read session A's tab id; it is refused.
4. `/browser` in each prints its own group and color.
5. `ss -ltn | grep 47823` prints nothing.
6. Quit session A; its group becomes `pi · <name> (ended)` with tabs intact.

## Post-merge
- Publish the new version to npm, run by the user

## Stage 2 agent picks
- Phase 1 installs Linux manifests only; macOS paths wait for phase 4
- Phase 1 relays one socket at a time; multiplexing several lands in phase 2
- Phase 4 Verify proves macOS install with a fake home, not a real Mac, since the user tests on Linux
- Every phase blocked by the one before, since they share files
