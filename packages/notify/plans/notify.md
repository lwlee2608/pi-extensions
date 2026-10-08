# Notify
**The Job** — A pi extension that pings the user's phone (Telegram, or any service via a shell command) when an agent run finishes, armed on demand with `/notify`.
**The Why** — Users walk away from long runs and have to keep checking back; without a ping, finished or blocked runs sit idle unnoticed.
**The Guardrail** — Off by default; never sends anything unless armed in the current session. Never sends prompt or code content off the machine. Sending never blocks or slows the session.
**Done means** — `/notify` armed, a run finishes, a Telegram message arrives on the phone; unarmed runs send nothing.

## Decisions
- **Build mode** — Orchestrator; worker `velocirouter/gpt-6-astra` at `medium` effort; fresh reviewer `velocirouter/gpt-6-astra` at `high` effort each round
- **Where does it live?** — New workspace package `packages/notify`, registered in root `package.json` `pi.extensions`, same layout as `packages/footer` `research`
- **Connectors** — Two: `telegram` (built-in HTTP call) and `command` (runs a shell command with `PI_NOTIFY_TEXT` in env; covers Slack/ntfy/apprise/etc.). No per-service connectors beyond these.
- **Config location** — `~/.pi/agent/pi-notify/config.json` via `getAgentDir()`, like model-plus `research`
- **Config shape** — `{ onPrompt, connectors: [{ type: "telegram", botToken, chatId } | { type: "command", run }] }`; all connectors fire on each ping
- **Secrets** — String values of the form `"$VAR"` resolve from env
- **Arming** — Off by default, per session, never persisted; resets to off on any `session_start` (new/resume/fork). `/notify` = next run only, `/notify on` = every run, `/notify off` = disarm
- **TUI only** — Subagent children inherit parent extensions `research`, so the extension is inert unless `ctx.mode === "tui"`; `notify_me` is removed from active tools outside TUI, same as ask-user's `excludeOutsideTerminal`
- **Armed indicator** — `ctx.ui.setStatus("notify", ...)`; footer already renders extension statuses `research`
- **Ping on blocking prompt** — `onPrompt` config flag; uses `ui_prompt_start` (fires for any blocking extension UI prompt, e.g. ask-user) `research`. Only pings while an agent run is active (`agent_start` → `agent_settled`). Text is "waiting for input" — never the prompt `title`. Known gotcha: commands run immediately mid-run and the event has no source, so opening `/sessions`, `/subagents` or `/model-plus` during a run also pings; accepted since the user is at the keyboard
- **Settle detection** — `agent_before_settle` is not final (other extensions or queued messages can continue the run) and is skipped on abort `research`. So: clear outcome on `agent_start` (fires per continuation too), record it on `agent_before_settle`, send on `agent_settled` only if outcome is `completed` / `error`. Same pattern as session-board
- **Agent-callable `notify_me` tool** — Amended (was: not in v1). Tool arms one-shot, same as `/notify`; user can say "notify me when you finish". Description restricts use to explicit user requests. Invalid config → tool returns error so agent tells user. Hidden outside TUI. Known gotcha: if the agent stops to ask a question, that settle consumes the ping
- **Message content** — Session name (if set) + cwd + outcome, e.g. `✅ fix-login · ~/src/app · done`. No prompt/reply text
- **Aborted runs** — No ping; one-shot stays armed for the next run
- **Send failures / missing config** — `/notify` with no valid config warns and stays off; failed send shows a UI warning per connector
- **Test command** — `/notify test` sends a test message through all connectors now
- **Config load timing** — Read on every `/notify` and every send; edits apply without `/reload`
- **One-shot vs prompt ping** — Prompt ping does not consume one-shot; one-shot disarms only when a run settles with `completed` or `error`

## Progress
Phase 1 of 2 · 0/13 tasks

### Phase 1 — Get a Telegram ping when an armed run finishes
User can `/notify`, walk away, and get a Telegram message when the run completes or errors.
- [ ] Scaffold `@lwlee2608/pi-notify` package and register it in root `package.json` (packages/notify)
- [ ] Load and validate config with `$VAR` env resolution (packages/notify/src/config.ts)
- [ ] Send via Telegram connector with a timeout (packages/notify/src/connectors.ts)
- [ ] Track armed state: once / on / off, abort keeps one-shot armed, reset on session start (packages/notify/src/state.ts)
- [ ] Format message from session name, cwd, outcome (packages/notify/src/message.ts)
- [ ] Register `/notify` with `on`, `off`, `test`; refuse to arm on bad config; inert outside TUI (packages/notify/src/index.ts)
- [ ] Track run outcome (clear on `agent_start`, record on `agent_before_settle`) and ping on `agent_settled` when armed; warn per failed connector (packages/notify/src/index.ts)
- [ ] Show 🔔 status while armed (packages/notify/src/index.ts)
- [ ] Test config, state, message, settle lifecycle, Telegram request with stubbed fetch (packages/notify/test)
**Verify:** `npm test -w packages/notify` passes (state incl. session reset, config, message, telegram tests; settle lifecycle: run continued after `agent_before_settle` pings once at `agent_settled`, aborted run pings nothing and keeps one-shot armed); user step: `pi -e ./packages/notify/src/index.ts` with a real bot config → `/notify test` delivers to phone

### Phase 2 — Ask the agent to notify you, reach any service, and get pinged when it waits on you
User can ask the agent "notify me when you finish", route pings to Slack/ntfy/apprise via a shell command, and gets a ping when ask-user blocks.
- [ ] Register `notify_me` tool that arms one-shot exactly like `/notify`; remove from active tools outside TUI (packages/notify/src/index.ts)
- [ ] Add `command` connector passing `PI_NOTIFY_TEXT` in env, with a timeout (packages/notify/src/connectors.ts)
- [ ] Ping on `ui_prompt_start` when armed and `onPrompt` is set, without consuming one-shot (packages/notify/src/index.ts)
- [ ] Write package README and add row/install line to root README (packages/notify/README.md, README.md)
**Verify:** `npm test -w packages/notify` with new tests: command connector writes `$PI_NOTIFY_TEXT` to a temp file; prompt event pings when armed + `onPrompt` during a run, does not ping outside a run, never includes the title, and one-shot still pings on settle; `notify_me` tool call arms one-shot, returns error on bad config, and is not active when mode is not `tui`. Manual: tell agent "notify me when done" → 🔔 appears, ping arrives on settle

## Demo
User runs, with their phone:
1. Create Telegram bot, write `~/.pi/agent/pi-notify/config.json` with a `telegram` connector
2. `/notify test` → message arrives
3. `/notify`, run a short prompt → done message arrives, 🔔 indicator clears
4. Run another prompt unarmed → nothing arrives
5. Ask the agent "implement X and notify me when you finish" → 🔔 appears, message arrives when the run ends
