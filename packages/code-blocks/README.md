# Pi code blocks

Cleaner code blocks for [Pi](https://pi.dev). Hides the ```` ``` ```` fence lines and shows plain-text blocks in your theme’s accent color. Blocks with a language label keep Pi’s syntax highlighting.

````text
Before          After
```text
  A -> B          A -> B
```
````

## Install

```sh
pi install npm:@lwlee2608/pi-code-blocks
```

Run `/reload` or start a new session. No commands or settings. Requires Node.js 22.19 or newer and Pi 1.0.0.

## Behavior

- Unlabeled, `text`, `txt`, `plaintext`, and `plain` blocks use the accent color, which depends on your theme.
- Other languages, including unknown ones, keep Pi’s normal formatting.
- Indentation, blank lines, and wrapping are preserved. Fence characters inside the code are kept.
- Applies wherever Pi renders Markdown in the terminal: messages, thinking, previews, and tool output.
- Display only. Saved sessions, what the model sees, and print/JSON/RPC output are unchanged.

## Compatibility

This extension relies on Pi internals that may change in a future release. If a Pi update changes how code blocks render, the extension shows a warning at startup and leaves code blocks as they are. Other extensions that change code block rendering may conflict.

## Remove

```sh
pi remove npm:@lwlee2608/pi-code-blocks
```

Restart Pi so earlier messages render with the default style again.

## License

MIT
