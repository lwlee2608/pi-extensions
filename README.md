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
| Enter | Switch to the selected model without changing the default. |
| Ctrl+S | Switch to the selected model and save it as the default for new sessions. |
| Ctrl+N | Open the full model browser to add favorites. |
| Ctrl+R | Remove the selected bookmark, including unavailable models. |
| Escape | Close the menu. |

In the model browser, type to search by provider, model ID, or name. Press Enter to toggle a bookmark (`★`). You can mark several models without closing the browser. Escape returns to the refreshed favorites menu. Changes save immediately and do not switch the active model.

Enter, arrow keys, Page Up/Down, and Escape follow Pi's selection keybindings. Ctrl+S follows Pi's `app.models.save` keybinding, shared with `/model`. To change the shortcuts, add overrides to `~/.pi/agent/keybindings.json`:

```json
{
  "pi-model-plus.add": "ctrl+n",
  "pi-model-plus.remove": "ctrl+r",
  "app.models.save": "ctrl+s"
}
```

The add/remove shortcuts only apply inside the favorites menu.

The picker marks the current model, the saved global default, and unavailable models. Search for `default` to find the bookmarked default. Unavailable bookmarks stay saved until you remove them and cannot be selected or saved as default.

Enter switches through Pi's API without changing defaults. Ctrl+S switches first, then saves `defaultProvider` and `defaultModel` in Pi's agent-directory `settings.json`, preserving unrelated settings. Failed switches do not change defaults; failed saves are reported separately. Project settings and startup CLI options can override this global default. Pi's built-in `/model` may need `/reload` to refresh its cached default badge after this extension saves it.

This extension does **not** modify or replace `/model`, `/scoped-models`, or Ctrl+P cycling. It does not register global keyboard shortcuts.

## Storage

Bookmarks are saved across projects and sessions at:

```text
~/.pi/agent/pi-model-plus/favorites.json
```

Pi's `PI_CODING_AGENT_DIR` override is respected. Only provider and model IDs are stored, not credentials or conversation data. Separate Pi processes lock updates to avoid losing bookmarks. File replacement is atomic; malformed files are reported rather than overwritten.

Adding/removing bookmarks and setting the default require interactive terminal mode. RPC clients with selection dialogs can use `/model-plus` to switch between existing favorites, but do not get the menu shortcuts. The model browser lists the current model catalog for configured providers; open `/model` first if you need Pi to refresh that catalog.

## Local development

```sh
npm ci --ignore-scripts
npm run check
node --test test/*.test.ts
pi -e ./src/index.ts
```

No build step is required. Pi loads the TypeScript source.

## Publishing

GitHub Actions runs type checks, tests, and a package dry run on pull requests, pushes to `main`, and version tags. Pushing a `v*` tag that matches the version in `package.json` publishes that version to npm (unless already published) and creates a GitHub release with generated notes. Versions are bumped manually, not by CI.

### One-time setup

CI publishes through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no npm token or repository secret is needed. On npmjs.com, under the package's **Settings → Trusted Publisher**, add GitHub Actions with repository `lwlee2608/pi-model-plus`, workflow `npm-publish.yml`, and **Allow `npm publish`** enabled. npm adds provenance to each published version.

### Release a version

```sh
npm version patch  # or minor / major; commits package.json and package-lock.json and tags vX.Y.Z
git push origin main --follow-tags
```

Run this on an up-to-date, clean `main`. CI fails if the tag does not match `package.json`. To retry a failed release, re-run the tag's workflow run, or use **Actions → CI and npm publish → Run workflow** and select the tag; already-published versions and existing releases are skipped.

No build step, npm token, or local `npm login` is required for CI publication. The workflow publishes the TypeScript source using `--ignore-scripts`.

The `pi-package` keyword makes the npm package eligible for discovery at [pi.dev/packages](https://pi.dev/packages). Gallery indexing is separate from npm publication; a listing is not guaranteed to appear immediately.

## License

MIT
