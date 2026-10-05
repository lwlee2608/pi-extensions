# Pi extensions

[Pi](https://pi.dev) extensions, each published as its own npm package.

| Package | Command | Description |
| --- | --- | --- |
| [`@lwlee2608/pi-model-plus`](packages/model-plus) | `/model-plus` | Bookmark favorite models and switch between them. |
| [`@lwlee2608/pi-session-board`](packages/session-board) | `/sessions` | Observe independent Pi terminal sessions. |
| [`@lwlee2608/pi-footer`](packages/footer) | Automatic | Context, cost, cache usage, and run timer in a compact footer. |
| [`@lwlee2608/pi-ask-user`](packages/ask-user) | `ask_user_question` tool | Lean inline questionnaires with previews, notes, and review. |

## Install

Install one package from npm:

```sh
pi install npm:@lwlee2608/pi-model-plus
pi install npm:@lwlee2608/pi-session-board
pi install npm:@lwlee2608/pi-footer
pi install npm:@lwlee2608/pi-ask-user
```

Ask-user must not load alongside rpiv's `ask_user_question`; if you use rpiv, read its [replacement instructions](packages/ask-user#replace-rpiv-user-action-after-verification) first.

Or install all of them from git:

```sh
pi install git:github.com/lwlee2608/pi-extensions
```

Run `/reload` in an existing Pi session after installation. Requires Node.js 22.19 or newer and Pi 1.0.0.

## Experimental

[`packages/code-blocks`](packages/code-blocks) hides Markdown code fences and uses the theme’s accent color for plain-text blocks. It patches a private Pi renderer method and is **opt-in**, not part of the root package’s automatic extension list.

```sh
pi -e ./packages/code-blocks/src/index.ts
```

## Local development

```sh
npm ci --ignore-scripts
npm run check
npm test
pi -e ./packages/<name>/src/index.ts
```

No build step is required. Pi loads the TypeScript source. Shared dev dependencies live in the root `package.json`; each package declares only its runtime `dependencies` and host `peerDependencies`.

## Publishing

GitHub Actions runs type checks, tests, and package dry runs on pull requests, pushes to `main`, and release tags. A tag named `<dir>-v<version>` (for example `session-board-v0.1.0`) publishes `packages/<dir>` to npm if its `package.json` version matches and the version is not already published, then creates a GitHub release with generated notes.

### One-time setup per package

CI publishes through npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); no npm token or repository secret is needed.

1. If the package is not on npm yet, publish its first version locally, because npm requires an existing package before a trusted publisher can be configured ([npm/cli#8544](https://github.com/npm/cli/issues/8544)):

   ```sh
   npm login
   npm publish -w packages/<dir> --access public --ignore-scripts
   ```

2. On npmjs.com, under the package's **Settings → Trusted Publisher**, add GitHub Actions with repository `lwlee2608/pi-extensions`, workflow `npm-publish.yml`, no environment, and **Allow `npm publish`** enabled.

### Release a version

On an up-to-date, clean `main`:

```sh
npm version patch -w packages/<dir>  # or minor / major; does not commit or tag
git commit -am "Release <dir> vX.Y.Z"
git tag <dir>-vX.Y.Z
git push origin main <dir>-vX.Y.Z
```

To retry a failed release, re-run the tag's workflow run or use **Actions → CI and npm publish → Run workflow** on the tag. Already-published versions and existing releases are skipped.

The `pi-package` keyword makes each npm package eligible for discovery at [pi.dev/packages](https://pi.dev/packages).

## License

MIT
