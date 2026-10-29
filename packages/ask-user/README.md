# Pi Ask User

Lets the agent stop and ask you questions in the terminal, like Claude Code's AskUserQuestion. The questionnaire renders inline in place of Pi's editor, so the transcript stays visible, and your draft editor text comes back when you're done.

```
────────────────────────────────────────
←   ☒ Storage   ☐ Features   ✔ Submit   →

Which features should we include?

❯ 1. [✔] Search
  2. [ ] Export
  3. [ ] Type something.
     Next
────────────────────────────────────────
  4. Explain this question
  5. Chat about this

Space/Enter toggle · ↑/↓ navigate · Tab/←→ switch · n note · Esc cancel
```

## Install

```sh
pi install npm:@lwlee2608/pi-ask-user
```

Start a new session afterward. Requires Node.js 22.19+ and Pi 1.0.0+. Don't load it alongside another extension that registers `ask_user_question`.

## Features

- 1–8 questions per call, each with 2–8 options. Single-select or multi-select (checkboxes).
- **Type something.**: write your own answer inline, right after the options. In multi-select it can go along with checked options.
- **Explain this question**: asks the session's current model to explain the question and its options in plain terms. The explanation appears above the options while the questionnaire stays open; Esc stops it. It's a separate model request that resends the conversation, and it's returned to the agent with your answers.
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

The tool works only in Pi's interactive terminal mode. It's hidden in print, JSON, and RPC runs.
