# Pi code blocks

An experimental Pi extension that hides code-block fences and colors plain-text blocks with the current theme’s accent color. Recognized code languages keep Pi’s syntax highlighting. The accent is theme-dependent, not always blue.

## Try it

From this repository:

```sh
pi -e ./packages/code-blocks/src/index.ts
```

For persistent use, install the local package with an absolute path:

```sh
pi install /absolute/path/to/pi-extensions/packages/code-blocks
```

Run `/reload` afterward, or start a new session. No command or settings are needed. This package is not yet published to npm.

To remove the local installation:

```sh
pi remove /absolute/path/to/pi-extensions/packages/code-blocks
```

Restart Pi after removal so all cached output uses the default renderer.

## Behavior and limits

- Removes generated opening and closing fences, not fence characters inside the code.
- Uses the accent color for unlabeled, `text`, `txt`, `plaintext`, and `plain` blocks, including indented code.
- Keeps Pi’s formatting for other language labels, including unknown languages.
- Preserves indentation, blank lines inside blocks, syntax highlighting, and wrapping.
- Applies to all instances of Pi’s shared Markdown renderer: assistant and user messages, thinking, previews, and tools that use it.
- Does not alter stored messages, model context, print/JSON/RPC output, or Pi’s installed files.

The extension patches the private `Markdown.prototype.renderToken` method in TUI sessions. It checks the expected rendering behavior before installation and leaves the default renderer in place with a warning if that check fails. It restores the original method on reload/shutdown, unless another extension has since replaced it.

This is not a public Pi API. Compatibility checks cannot catch every future change. Tested with Pi 1.0.0, including the installed bundled CLI. If an update breaks it, disable the extension and restart Pi. Other extensions that patch the same renderer may conflict.

## Development

```sh
npm run check -w packages/code-blocks
npm test -w packages/code-blocks
```

## License

MIT
