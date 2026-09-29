# pi-model-plus

Bookmark favorite models in [Pi](https://pi.dev) and switch between them without searching the full model list.

## Install

Once published to npm:

```sh
pi install npm:pi-model-plus
```

Or, once the source is pushed to GitHub:

```sh
pi install git:github.com/lwlee2608/pi-model-plus
```

Run `/reload` in an existing Pi session after installation.

Requires Node.js 22.19 or newer. Developed and checked against `@earendil-works/pi-coding-agent` 0.87.1.

## Use

Run **`/model-plus`**. This is the extension's only command.

| Key in the favorites menu | Action |
| --- | --- |
| Type | Filter saved models. |
| Up / Down | Move the selection. |
| Page Up / Page Down | Move by 10 filtered entries, stopping at either end. |
| Enter | Switch to the selected model. |
| Ctrl+N | Open the full model browser to add favorites. |
| Ctrl+R | Remove the selected bookmark, including unavailable models. |
| Escape | Close the menu. |

In the model browser, type to search by provider, model ID, or name. Press Enter to toggle a bookmark (`★`). You can mark several models without closing the browser. Escape returns to the refreshed favorites menu. Changes save immediately and do not switch the active model.

Enter, arrow keys, Page Up/Down, and Escape follow Pi's selection keybindings. To change the menu's add/remove shortcuts, add overrides to `~/.pi/agent/keybindings.json`:

```json
{
  "pi-model-plus.add": "ctrl+n",
  "pi-model-plus.remove": "ctrl+r"
}
```

These shortcuts only apply inside the favorites menu.

The picker marks the current model and unavailable models. Unavailable bookmarks stay saved until you remove them. Model switching uses Pi's API and does not change the default model for new sessions.

This extension does **not** modify or replace `/model`, `/scoped-models`, or Ctrl+P cycling. It does not register global keyboard shortcuts.

## Storage

Bookmarks are saved across projects and sessions at:

```text
~/.pi/agent/pi-model-plus/favorites.json
```

Pi's `PI_CODING_AGENT_DIR` override is respected. Only provider and model IDs are stored, not credentials or conversation data. Separate Pi processes lock updates to avoid losing bookmarks. File replacement is atomic; malformed files are reported rather than overwritten.

Adding and removing bookmarks requires interactive terminal mode. RPC clients with selection dialogs can use `/model-plus` to switch between existing favorites, but do not get the menu shortcuts. The model browser lists the current model catalog for configured providers; open `/model` first if you need Pi to refresh that catalog.

## Local development

```sh
npm ci --ignore-scripts
npm run check
node --test test/*.test.ts
pi -e ./src/index.ts
```

No build step is required. Pi loads the TypeScript source.

## Publishing

After reviewing, committing, and pushing the package:

```sh
npm run check
node --test test/*.test.ts
npm pack --dry-run --ignore-scripts
npm login
npm publish --access public --ignore-scripts
```

The `pi-package` keyword makes the npm package eligible for discovery at [pi.dev/packages](https://pi.dev/packages). Gallery indexing is separate from npm publication; a listing is not guaranteed to appear immediately.

## License

MIT
