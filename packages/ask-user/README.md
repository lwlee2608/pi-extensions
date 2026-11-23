# Pi Ask User

Lets the agent stop and ask you questions in the terminal, like Claude Code's AskUserQuestion. The questionnaire renders inline in place of Pi's editor, so the transcript stays visible, and your draft editor text comes back when you're done.

![Pi asking which visual style a developer portfolio should use, with a Markdown preview of the highlighted option beside the choices](https://github.com/lwlee2608/pi-extensions/releases/download/media/ask-user-demo.png)

## Install

```sh
pi install npm:@lwlee2608/pi-ask-user
```

Start a new session afterward. Requires Node.js 22.19+ and Pi 1.0.0+. Don't load it alongside another extension that registers `ask_user_question`.

## Features

- 1–8 questions per call, each with 2–8 options. Single-select or multi-select (checkboxes).
- **Type something.**: write your own answer inline, right after the options. In multi-select it can go along with checked options.
- **Explain this question**: asks the session's current model to explain the question and its options in plain terms. The explanation appears above the options while the questionnaire stays open; Esc stops it. It's a separate model request that resends the conversation; its tokens count toward the session's usage, and the explanation is returned to the agent with your answers.
- **Chat about this**: closes the questionnaire and tells the agent you want to talk it over first. Any answers and notes you've already given are sent along.
- **Notes**: press `n` to attach a note to a question, or a global note from the review screen.
- **Previews**: options can carry Markdown previews, shown beside the options on wide terminals and below them on tall ones.
- **Review**: with several questions, a final tab shows all answers before you submit.
- **Safe cancel**: Esc cancels. If you've entered anything, you're asked to confirm before it's discarded.
- **Type-ahead guard**: keys you were typing when the questionnaire opened can't answer it by accident.
- Small footprint: the tool declaration is about 1 KB of model context.

## Keys

| Key | Action |
|-----|--------|
| ↑ / ↓ | Move between options |
| Enter | Choose an option; in multi-select, toggle it |
| Space | Toggle a multi-select option |
| 1–9 | Pick an option by number |
| Tab / Shift+Tab, ← / → | Switch question or go to review |
| `n` | Add or edit a note |
| PageUp / PageDown | Scroll the option's preview |
| Ctrl+↑ / Ctrl+↓ | Scroll long question text |
| Esc | Cancel (or close the note editor) |

On the **Type something.** row, keys type text, ←/→ move the cursor, and Enter confirms. Use Tab to leave the row.

In the note editor, Enter saves and Shift+Enter adds a newline.

## Custom keybindings

Pi's own selection and editor bindings apply. You can also remap these actions in Pi's keybindings file with a key, a list of keys, or `[]` to disable:

| Action | Default |
|--------|---------|
| `pi-ask-user.note` | `n` |
| `pi-ask-user.previewUp` | `pageUp` |
| `pi-ask-user.previewDown` | `pageDown` |

These aren't checked for conflicts, so avoid keys Pi already uses for editing or navigation.

The terminal experience is unchanged. The tool is hidden in print and JSON runs, and in RPC runs unless explicitly enabled.

## Opt-in RPC clients (proposal)

Clients implementing the contract below can start Pi with `pi --mode rpc --ask-user-rpc`. Do not enable this flag for a generic editor-only client. There are no client-specific dependencies or additional network services.

The adapter calls Pi's documented `ctx.ui.editor(title, prefill)` transport. Handle an `extension_ui_request` only when `method` is `"editor"` and `title` is exactly `"pi-ask-user:questionnaire:v1"`. Parse `prefill` as JSON:

```json
{"protocol":"pi-ask-user","version":1,"timeoutMs":600000,"questions":[{"question":"Pick one","options":[{"label":"A"},{"label":"B"}]}]}
```

`questions` is a validated, detached snapshot of the tool arguments, including optional `header`, `multiSelect`, option `description`, and Markdown `preview`. Render these as untrusted content. Collect and review answers, then send an `extension_ui_response` with the request's **Pi-generated `id`** and a **JSON string** in `value`:

```json
{"type":"extension_ui_response","id":"<request id>","value":"{\"protocol\":\"pi-ask-user\",\"version\":1,\"answers\":[{\"questionIndex\":1,\"selected\":[\"A\"]}]}"}
```

Answer indices are one-based. `selected` contains exact option labels (no duplicates). Each answer may include a nonblank `custom` string and a `notes` string; the envelope may include `globalNote`. Single-select requires exactly one option **or** a custom answer; multi-select permits both. Normal submission must answer every question exactly once. With `chat: true`, partial or empty answers are allowed so the user can discuss first. Unknown fields, versions, questions, labels, and invalid selection counts are rejected as tool errors, without retrying the dialog. Explanations are not accepted from the client.

To cancel explicitly, send `{"type":"extension_ui_response","id":"<request id>","cancelled":true}`. This returns `{cancelled:true,answers:[]}`. Abort, session shutdown, transport failure, and the fixed ten-minute deadline instead fail the tool without claiming the user cancelled. The first observed settlement wins; later replies cannot change its result.

**Limitations:** this is a one-shot questionnaire contract, not a custom Pi RPC method or a capability-negotiation protocol. Clients own review, draft handling, safe cancellation, and preview rendering. Model-powered explanations and reconnect/resume are not supported. Pi's editor API has no abort/timeout parameter or remote dismiss event: the adapter stops waiting locally, but Pi may retain the outstanding editor request until a reply or runtime teardown. Clients should dismiss stale questionnaires on tool completion/abort and send a cancellation response to release the outstanding request. The deadline is included in the envelope for client UI cleanup; process exit/disconnection must also close the client UI.
