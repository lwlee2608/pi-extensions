# Browser Web Store
**The Job** — Publish Pi Browser to the Chrome Web Store, make pi and the extension keep working when their versions drift apart, and switch `/browser` and the README to the store install (issue #50).
**The Why** — Two equal pains: installing means Developer mode and Load unpacked, which puts off new users, and every package update needs a manual reload in `chrome://extensions`, and a protocol bump breaks everyone until they do it.
**The Guardrail** — Every v1 and multi-session gate stays: per-host approval, eval confirmation, http/https-only navigate, per-session group isolation, no tool without UI. No new manifest permissions, now or for #43 Option B later. Load unpacked keeps working as the dev path.
**Done means** — A user installs Pi Browser from the store in one click and pi connects; a later store update of the extension, or a pi update, keeps working without a reload in `chrome://extensions`.

## Decisions
- **Interview depth** — Key decisions only
- **Who owns the drift** — The native host ships inside the pi package, but Chrome spawns it and keeps it running across pi restarts, so a running host can be older than pi; all three can drift `research`
- **Store updates wait** — Chrome installs an extension update only when the service worker unloads or Chrome restarts; the open native port keeps the worker alive, so without `chrome.runtime.reload()` an update waits for a Chrome restart `research`
- **pi 0.2.0 hello** — pi 0.2.0 accepts only `version === 1 && host === 1` from the extension's `hello`; any other value is a hard mismatch `research`
- **Existing users** — Assume nobody runs pi 0.2.0 with the extension yet; the store launch may break 0.2.0 and the unpacked ID freely
- **Extension ID** — Adopt the store's key: create the store item, copy its public key into `chrome/manifest.json`, and point the host's `allowed_origins` at the new ID. One ID for store and unpacked dev; no key.pem experiment
- **Compatibility contract** — New `hello` at the store launch: pi, host and extension each list named capabilities; a feature runs only when every side it needs lists it, otherwise pi says which side to update. Methods are removed only after a deprecation window. pi 0.2.0 breaks
- **Listing visibility** — Unlisted until #43 Option B ships; README and `/browser` carry the link. Public later, no reinstall
- **Store release** — Manual: a script builds the store zip from `chrome/`; the user uploads it in the dashboard. No CI secrets
- **Applying store updates** — On `onUpdateAvailable` the extension reloads itself once no session has a call in flight; sessions reconnect and re-adopt their groups
- **Store assets** — A plain SVG icon rendered to the PNG sizes the store and manifest need; screenshots cropped from the existing browser-demo media
- **Demo** — User runs steps locally in their own Chrome with the built store zip loaded unpacked (see Demo)
- **Store zip strips `key`** — The store rejects `key`, so the zip script drops it from the zipped manifest; `chrome/manifest.json` keeps it so unpacked dev gets the store ID `agent`
- **Stale host** — When the running host lacks a capability pi needs, pi asks the extension to restart the native host instead of failing `agent`
- **Mismatch wording** — Extension behind: "update Pi Browser" (store updates arrive on their own; `chrome://extensions` → Update forces it). pi behind: "update pi", shown in `/browser` and the toolbar title `agent`
- **Deprecation window** — A capability or method is removed only after its replacement has shipped in both the store extension and npm for at least one minor release `agent`
- **Version numbers** — Manifest version is independent of the package version and bumped only when `chrome/` changes, since every store upload needs a higher version `agent`
- **Unpacked dev path** — The npm package keeps shipping `chrome/`; README's dev path says to remove the store copy first, since both share one ID `agent`
- **Privacy policy** — `PRIVACY.md` in the package, linked by its GitHub URL; covers the native host and the future localhost transport, the locally stored pairing secret, and that nothing leaves the machine `agent`
- **Listing text** — Store description and per-permission justifications (`debugger`, `nativeMessaging`, `tabs`, `tabGroups`, `storage`) live in the repo for review, outside the zip `agent`
- **Release** — Minor bump to 0.3.0; npm publish waits until the store approves the listing so `/browser`'s link works `agent`
- **Integration branch** — `integrate/browser-web-store` holds the plan; each phase PRs into it; one final PR to `main`, as before `agent`
- **Verification budget** — The v1 rules in `plans/browser.md` carry over `agent`
- **Build mode** — As multi-session: orchestrator, fresh worker per phase in its own worktree, fresh reviewer per round; worker and reviewer Opus 5.5 high `agent`
- **Phase count** — 4; 1a and 1b run in parallel (no shared files), then 2 and 3 in order

## Progress
Active: 1a, 1b · 0/17 tasks

### Phase 1a — Build a store-ready zip you can upload as a draft
You can run one command and upload the result to the Chrome Web Store dashboard, which gives you the store ID and public key phase 3 needs.
**Blocked by:** none
- [ ] Add an SVG icon and the PNG sizes, and reference them in the manifest (`chrome/icons/`, `chrome/manifest.json`)
- [ ] Add a script that zips `chrome/` with `key` removed from the manifest (`package.json`, `scripts/`)
- [ ] Write the privacy policy (`PRIVACY.md`)
- [ ] Write the store description and permission justifications, and crop the screenshots (`store/`)
- [ ] Assert the zip's manifest has no `key`, has icons, and lists the same permissions as `chrome/manifest.json` (`test/package.test.ts`)
**Verify:** `npm run zip` writes the zip; `unzip -p <zip> manifest.json` shows icons and no `key`; `npm test` passes the new package case.

### Phase 1b — pi says exactly which side to update
pi, host and extension exchange capabilities; a missing one names the side to update, and a stale host is restarted instead of failing.
**Blocked by:** none
- [ ] Replace the version `hello` with capability lists from pi, host and extension (`src/bridge.ts`, `src/host.js`, `chrome/background.js`)
- [ ] Refuse an action whose capability a side lacks, with "update Pi Browser" or "update pi" (`src/bridge.ts`, `src/index.ts`)
- [ ] Ask the extension to restart the native host when the running host is behind (`src/bridge.ts`, `chrome/background.js`)
- [ ] Show capabilities and any "update pi" in `/browser` and the toolbar title (`src/index.ts`, `chrome/background.js`)
- [ ] Unit-test the negotiation and messages; add e2e cases with an extension and a host that lack a capability (`test/`)
**Verify:** `npm test` covers each mismatch message; `npm run e2e` with an extension missing a capability fails that action with "update Pi Browser", and with a stale host recovers after the host restarts.

### Phase 2 — Store updates apply themselves
A store update reloads the extension once no session is mid-call, and every session picks up its group again.
**Blocked by:** 1b
- [ ] Reload on `onUpdateAvailable` once no session has a call in flight (`chrome/background.js`)
- [ ] Make sure sessions reconnect and re-adopt their groups after the reload (`chrome/background.js`, `src/bridge.ts`)
- [ ] Add an e2e case that fires the update handler mid-call through CDP (`test/e2e/`)
**Verify:** `npm run e2e`: firing the update handler during a `read` lets the read finish, then the extension reloads, and the next `read` in the same session runs in the same group.

### Phase 3 — Install from the store
`/browser` and the README send users to the store listing; Load unpacked becomes the dev path.
**Blocked by:** 1a, 1b, 2, and the user's draft store item (Post-merge step 2)
- [ ] Adopt the store's public key and point `ORIGIN` at the store ID (`chrome/manifest.json`, `src/install.ts`, `test/`)
- [ ] Print the store link in `/browser` and the not-connected errors instead of the unpacked path (`src/index.ts`, `src/bridge.ts`)
- [ ] Rewrite install as store-first with Load unpacked as dev path, drop the reload step, document the compatibility contract (`README.md`)
- [ ] Bump package and manifest to 0.3.0 (`package.json`, `chrome/manifest.json`)
**Verify:** `npm run e2e` passes with the extension loaded under the store ID; `npm test` checks `/browser` prints the store link.

## Demo
In your own Google Chrome, with the zip from `npm run zip` unpacked and loaded (Developer mode → Load unpacked):
1. `chrome://extensions` shows Pi Browser with the store ID.
2. Start pi, ask it to open a page; it works with no extra setup beyond `/browser`.
3. `/browser` prints the store link and your group.
4. Restart Chrome; pi reconnects without touching `chrome://extensions`.

## Post-merge
For the user, in order:
1. Register a Chrome Web Store developer account ($5).
2. After phase 1a: upload the zip as a new item, leave it as a draft, and hand the item's ID and public key (Package tab) to phase 3.
3. After the final merge: upload the 0.3.0 zip, paste the listing text, justifications and privacy URL from the repo, add the icon and screenshots, set visibility to Unlisted, and submit for review.
4. Once approved: tag `browser-v0.3.0` to publish npm.
