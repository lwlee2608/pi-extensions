# Coordinate actions
**The Job** — Let the `browser` tool act on a point in the page, taken from a `screenshot`, not only on an accessibility ref: click, hover, drag, wheel-scroll, type into whatever has focus, and zoom into a region to aim at small targets.
**The Why** — Parity with Claude in Chrome: canvas apps, unlabeled custom widgets, position-based input (sliders, drag-and-drop, points on a chart or map), and cross-site iframes are visible in a screenshot but unreachable today, so the agent falls back to `eval`, which prompts the user every time (#52).
**The Guardrail** — Ref-based actions, site approval, the eval gate, the pi-tab-group boundary, and the overlay stay as they are; a point never lets the agent act outside its own pi tab.
**Done means** — On a canvas fixture page, the agent screenshots, clicks a point, drags across it, and types into it, and the page records each input at the right place without any `eval`.

## Decisions
- **Interview depth** — Key decisions only
- **Intent** — Parity with Claude in Chrome
- **Which actions** — Full Claude in Chrome parity: click at a point (left, right, double, triple), hover, drag from one point to another, wheel scroll at a point, type into whatever has focus, and a zoomed screenshot of a region for small targets
- **Coordinate space** — x,y are pixels in the extension's own screenshot. The extension captures at a size models do not shrink, states the image's width and height in the result, and maps points back to the page itself; the model never scales
- **Cross-site frames at a point** — Before acting, find the innermost frame under each point; if it is cross-site to the tab's page, its host needs approval like any new host, with the same choices
- **Demo** — User runs a short script in their own Chrome on real sites
- **Pointer actions on a tab not in front** — Hover, drag, and wheel bring the pi tab to the front of its window first, as `screenshot` and `click` do; `type` does not
- **Tool shape** — `click` and `scroll` take either a ref or a point, never both; `type` takes a ref or nothing, typing into the current focus; new actions `hover`, `drag`, and `zoom`. `click` gains a button (left or right) and a click count (1–3), for refs too `agent`
- **Which screenshot a point refers to** — The tab's last screenshot; its scale is kept per tab. A point action on a tab with no screenshot fails and asks for one. Points are not invalidated on scroll or navigation; the tool description says to screenshot again after the page moves `agent`
- **Capture size** — Long edge at most 1568 px and about 1.15 megapixels, which Anthropic models take unshrunk and pi's 2000 px default leaves alone; Chrome scales during capture. Providers that shrink further on their side (OpenAI's 768 px short side) can still skew points; accepted and noted in README Limits `agent`
- **Zoom** — Takes a rectangle in the last screenshot's pixels and returns it at higher detail; it is for looking only, so points stay in the full screenshot's space and `zoom` does not replace the stored scale `agent`
- **Drag** — Press, a few intermediate moves, release, all mouse events; Chrome's DevTools drag controller (M117+) keeps a native HTML5 drag started this way inside the page, so it drops at the checked end, never at the user's real cursor; a failed drag calls `Input.cancelDragging` before releasing at the start (amended after phase 3 review round 4) `agent`
- **Approval for a drag** — Both endpoints go through the frame-host check `agent`
- **What a point action reports** — The result names the element under the point (role and name when it has one), so the user and model can see what was hit `agent`
- **Overlay** — The blue dot moves to the point and ripples on click, as with refs; a drag moves it from start to end `agent`
- **Typing without a ref** — Inserts text at the current focus; the tool description points canvas apps that read keystrokes to `keys` `agent`
- **Typing into a cross-site frame** — `type` with no ref and `keys` find the frame that holds focus; if it is cross-site to the tab's page, its host needs approval like a point in that frame (amended after phase 1 review)
- **Wheel amount** — Given as pixel deltas in screenshot space and mapped like points `agent`
- **Phase count** — 4, merged in order
- **Branching** — Phases PR into `integrate/coordinate-actions`; one final PR to `main` after the demo, which the user merges. Phase 1 still refuses points in cross-site frames so the guardrail holds on the integration branch between phases `agent`
- **Fixture pages** — New e2e fixtures write every input they receive (type, position, button, count) into page text, so Verify reads results with `read`, never `eval` `agent`
- **Phase e2e tags** — Each phase's new e2e case names start with its tag (`points:`, `frames:`, `pointer:`, `zoom:`) so its Verify runs only those cases `agent`
- **Build mode** — Orchestrator: a fresh worker subagent per phase (Opus, high effort), a fresh reviewer per round (Opus, high effort)
- **Verification budget** — See `## Verification budget`; it binds every phase, review round, and merge `agent`
- **Pi resizes tool images** — pi normalizes tool-result images (default max 2000×2000, or the model's own limit) and adds a "multiply coordinates by N" note when it shrinks one; providers may shrink again without a note `research`
- **Background tabs** — Chrome does not answer mouse moves or wheel events in a tab that is not in front, and drops clicks and key presses there (README Limits, #54); `screenshot`, `click`, and `keys` already bring their tab to the front `research`
- **Input routing** — `Input.dispatchMouseEvent` on the tab's target takes main-viewport CSS pixels and Chrome routes it into any frame under the point, cross-site ones included `research`

## Verification budget
Carried over from `plans/browser.md`; these rules bind every phase, review round, and merge.
- **Before the PR** — Unit tests, the phase's tagged e2e cases, and existing cases for actions it changes.
- **After a review fix** — Unit tests, plus e2e cases for actions the fix changed.
- **Before merge** — The full `npm run e2e -w packages/browser`, once, even if no fix touched e2e: e2e is not in CI, so this is the only regression check on the other cases.
- **Reviewers don't run e2e** — They read the diff; the worker owns verification.
- **Time** — Targets: full e2e under 30s with Chrome cached, unit tests under 2s. A target, not a cap: never cut coverage to fit. Over target, the phase report gives the time, the slow cases, and why.
- **Waste to avoid** — Sleeps instead of page events, real timeouts where injected ones would do, re-running checks the change could not affect. Hover and drag in phase 3 wait on fixture events, not fixed delays.
- **Setup** — Chrome for Testing stays cached outside the repo; e2e keeps its own port so it never clashes with an open pi session.

## Progress
Active: 4 · 21/23 tasks

### Phase 1 — Click and type at a point from a screenshot
The agent can click anywhere it sees in a screenshot (left, right, double, triple) and type into whatever that focused, on canvas and unlabeled widgets.
**Blocked by:** none
- [x] Capture screenshots within the size cap, report the image's width and height, and keep the tab's scale (`chrome/background.js`)
- [x] Accept a point on `click`, with button and click count for refs and points alike (`chrome/background.js`, `src/index.ts`)
- [x] Fail a point action on a tab with no screenshot, or a point outside the image (`chrome/background.js`)
- [x] Refuse a point that lands in a cross-site frame (`chrome/background.js`)
- [x] Name the element under the point in the result, and move the overlay dot to it (`chrome/background.js`)
- [x] Let `type` run without a ref, into the current focus (`chrome/background.js`, `src/index.ts`)
- [x] Bump `PROTOCOL` so a stale extension reports a mismatch instead of failing on point params and new actions (`src/host.js`, `chrome/background.js`)
- [x] Describe points, their coordinate space, and going stale in the tool description and README (`src/index.ts`, `README.md`)
- [x] Add a canvas fixture that records each input it receives, and e2e cases for this phase (`test/e2e/fixtures`, `test/e2e/browser.test.ts`)
**Note:** Point clicks under pinch zoom are unverified end to end (hit check now uses the visual viewport; press mapping not tested).
**Note:** Phase 1 spots a cross-site frame as a frame owner whose document is in another process (`DOM.describeNode` gives no `contentDocument`); Chrome may isolate sandboxed same-site iframes too, so those are refused as well. Phase 2 needs the frame's real host.
**Verify:** `node --test --test-name-pattern "^points:" test/e2e/browser.test.ts` from `packages/browser`, plus `npm test -w packages/browser`. With a viewport wider than 1568 px: `screenshot` reports an image at most 1568 px wide; a click at the fixture target's position in that image makes `read` show the canvas got a click within 2 CSS px of the target, and right, double, and triple clicks show their button and count; clicking a text field by point then `type` with no ref puts the text in it; a point action before any screenshot fails asking for one; a point inside the fixture's cross-site frame fails and the frame records nothing.

### Phase 2 — Act inside cross-site iframes, with approval
A point inside an embed from another host asks the user to approve that host, then acts there.
**Blocked by:** 1
- [x] Find the host of the innermost frame under a point, through nested cross-site frames, and pass it to pi's approval before acting (`chrome/background.js`, `src/index.ts`)
- [x] Replace phase 1's refusal with that approval, same choices and denial behavior as navigate (`chrome/background.js`, `src/index.ts`)
- [x] Ask the same frame-host approval when `type` with no ref or `keys` goes into a focused cross-site frame (`chrome/background.js`, `src/index.ts`)
- [x] Explain frame approval for points in the README's Site approval section (`README.md`)
- [x] Add e2e cases for allow, deny, and an already-approved frame host (`test/e2e/browser.test.ts`)
**Note:** A hostile page could slide a cross-site frame under the pointer between check and press. Done: click re-checks after `mouseMoved` and before each press and stops on an unapproved frame; `keys` re-checks focus before each combo and stops mid-sequence rather than prompting again.
**Note:** OOPIFs are reached with `Target.setAutoAttach` (flatten) per traversed session, since `chrome.debugger` refuses `Target.attachToTarget`; child sessions need Chrome 125, so `minimum_chrome_version` is now 125. "Cross-site" compares Page frame `domainAndRegistry`, so same-site frames (and sandboxed same-site OOPIFs) don't ask.
**Note:** A dialog opened inside a cross-site frame reaches the tab's own `Page.javascriptDialogOpening`, so `guarded` fails the click at once; child sessions need no `Page.enable` (e2e probe kept).
**Note:** The top-frame `main` fix in `frameAt` (cross-site frames hit-tested in-process when site isolation is off) has no e2e; e2e Chrome runs with site isolation on.
**Note:** Unverified: a service-worker restart may leave `frameSessions` empty while the debugger stays attached, so frame lookups fail with "may still be loading" until reload; fix idea: toggle `setAutoAttach` off and on after a miss.
**Note:** Remaining check-to-input races: `type` between `focusIn` and `insertText`, `keys` checked per combo not per key event, and mouse moves (not presses) reaching a frame slid in after the check.
**Note:** Frame offsets use the iframe's content-box top-left only; a CSS-scaled or rotated cross-site iframe can make the inner hit-test (and so the asked host) miss. Not handled.
**Note:** `PROTOCOL` not bumped: the new `hosts` param and `ask` reply only exist on the unreleased integrate branch, already at 2 versus main's 1.
**Verify:** `node --test --test-name-pattern "^frames:" test/e2e/browser.test.ts` from `packages/browser`, plus `npm test -w packages/browser`: a click inside the fixture's cross-site frame prompts for the frame's host, not the tab's; deny fails the call and the frame records nothing; allow once lets the frame record the click; after "this session", a second click does not prompt; `type` with no ref into a focused field in the cross-site frame prompts for the frame's host, and deny leaves the field empty.

### Phase 3 — Hover, drag, and wheel-scroll at a point
The agent can hover to open menus and tooltips, drag sliders and canvas strokes, and wheel-scroll an inner panel, even when the pi tab was behind another tab.
**Blocked by:** 2
- [x] Add `hover` at a point, bringing the tab to the front first (`chrome/background.js`, `src/index.ts`)
- [x] Add `drag` from one point to another, checking both endpoints' frame hosts and moving the overlay along it (`chrome/background.js`, `src/index.ts`)
- [x] Let `scroll` take a point and wheel deltas (`chrome/background.js`, `src/index.ts`)
- [x] Update the tool description and README, replacing the "no hover and no wheel scrolling" limit, and note native drag-and-drop if it does not fire (`src/index.ts`, `README.md`)
- [x] Add fixtures and e2e cases for hover, drag (mouse and native HTML5), and wheel on a tab behind another (`test/e2e/fixtures`, `test/e2e/browser.test.ts`)
**Note:** A drag asks up front for every host along its straight path (both ends and the points between), checks both ends again before pressing, each point on its path before moving there, and the end again before releasing; if one turned unapproved it jumps straight back and releases at the start, so a frame slid onto the path gets no event (e2e). The jump back does not re-check the start.
**Note:** Drag interception (`Input.setInterceptDrags` with a drag-event replay) was added in review round 3 and reverted in round 4: Chrome's DevTools drag controller already keeps a drag started by CDP mouse events inside the page, and interception lost File drag items and added a stray mouseup. A failed drag calls `Input.cancelDragging` before releasing at the start; e2e shows no drop with it, but headless drops nothing at the start without it either, so that call is not mutation-checked.
**Note:** Mouse moves, presses, and wheels sent to a pi tab hidden behind another get no answer from Chrome until the call times out, as the e2e mutation check without `inFront` showed.
**Note:** `PROTOCOL` not bumped: `hover`, `drag`, and wheel params only exist on the unreleased integrate branch, already at 2 versus main's 1.
**Verify:** `node --test --test-name-pattern "^pointer:" test/e2e/browser.test.ts` from `packages/browser`, plus `npm test -w packages/browser`. With the pi tab behind another tab before each case: `hover` makes `read` show the fixture's hover-only menu and the pi tab is now active; `drag` on the fixture's canvas records a press at the start, moves, and a release within 2 CSS px of the end, and on the slider changes its value; wheel at a point scrolls the fixture's inner panel, not the page; the native drag-and-drop case's outcome is recorded and matches README.

### Phase 4 — Zoom into a region to aim at small targets
The agent can look closer at a small part of the screen before clicking, without changing what its points mean.
**Blocked by:** 3
- [x] Add `zoom` on a rectangle in the last screenshot's pixels, returning that region at higher detail (`chrome/background.js`, `src/index.ts`)
- [x] Keep the stored scale untouched by `zoom` (`chrome/background.js`)
- [ ] Describe `zoom` in the tool description and README (`src/index.ts`, `README.md`)
- [ ] Add e2e cases for zoom detail and clicks after a zoom (`test/e2e/browser.test.ts`)
**Note:** `zoom` takes `region: [x0, y0, x1, y1]` and renders it at up to 4 image pixels per CSS pixel, within the screenshot's 1568 px / 1.15 MP cap; Chrome re-rasterizes text and vector content at that scale, while bitmaps and canvases are only upscaled past the device pixel ratio.
**Note:** `PROTOCOL` not bumped: `zoom` only exists on the unreleased integrate branch, already at 2 versus main's 1.
**Verify:** `node --test --test-name-pattern "^zoom:" test/e2e/browser.test.ts` from `packages/browser`, plus `npm test -w packages/browser`: `zoom` on the fixture's small-print region returns an image larger than that region's size in the screenshot; a click after `zoom`, at a point taken from the full screenshot, still lands within 2 CSS px of the target; `zoom` before any screenshot fails asking for one.

## Demo
**Note:** Check in the demo whether a right click on a page with no menu of its own leaves Chrome's native context menu open; if so add a README Limits line.
**Note:** In the demo, drag a native draggable (e.g. reorder a list) on macOS or Windows, if available, with the real cursor parked over another window; the drop must land on the target in the pi tab.
In your own Chrome with Pi Browser reloaded, in a pi session, ask the agent to:
1. Draw a shape on a canvas drawing app (e.g. excalidraw.com) and type a label into it.
2. Drag a map (e.g. openstreetmap.org) and wheel-zoom it at a point.
3. Hover a site's hover-only menu and click an item in it.
4. Click a field inside a cross-site embed; confirm pi asks for the embed's host, not the page's.
5. Zoom into small text, then click a small link near it.
Each step works without an `eval` prompt, and the blue dot lands where the agent acts.

## After merge
- Bump and release the browser package once the demo passes, as in `8ac23dc`.
