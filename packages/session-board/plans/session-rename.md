# Select and rename sessions

User-approved follow-up to the monitoring-only MVP: select any live registered
session with ↑/↓ and rename its actual Pi session via `r`, Enter saves, Esc cancels.
No task execution, terminal switching, or other session controls.

## Decisions
- Visible selection is independent from the current-terminal `›` marker.
- Retain selection by registration ID across refreshes and group changes; move to
  the first remaining session if it disappears. Keep selection in the viewport.
- Use Pi's native Input component inline; no extra blocking UI prompt.
- The owning extension calls `pi.setSessionName`; never edit another session's file.
- Private Unix sockets under the registry target one registration and session.
  Requests expire in three seconds, messages are bounded, and only rename is accepted.
- Reject Unknown sessions, empty names, controls, and names over 128 characters.
  `/name` remains the way to clear a name. Old extension versions have no endpoint.
- Shut endpoints down on session replacement/reload/quit. Socket-path length limits
  fail softly; no network server, global configuration, or separate daemon.

## Verification
- Type-check and 18 tests passed, including real socket requests, stale/wrong-session
  rejection, name validation, row selection and inline save/cancel.
- Two isolated real Pi terminals (regular and fullscreen): remote and local rename,
  owner footer update, Esc cancellation, and name retained after owner `/reload`.
  No model calls or credentials.
- Original monitoring plan is historical; this user-approved follow-up supersedes
  its no-session-mutation restriction only for explicit rename actions.

## Known unrelated issue
Provider-stream aborts can show Ready rather than Aborted; not changed here.
