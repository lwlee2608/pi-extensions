# Pi Footer

A muted, two-line footer for [Pi](https://pi.dev). Enabled automatically in interactive mode, using your current theme. No special font required.

```text
(velocirouter) gpt-6-astra-fast [high] [━━━━━━━━────────────] 40% 280k / 700k tokens • $17.37 (98% cached, 475.6k new) • 19s
~/src/project (main) • extension statuses
```

## Install

Once published:

```sh
pi install npm:@lwlee2608/pi-footer
```

From this repository, try it for one session:

```sh
pi -e ./packages/footer/src/index.ts
```

Or install the local package:

```sh
pi install ./packages/footer
```

Run `/reload` after installation. Requires Node.js 22.19 or newer and Pi 1.0.0.

## Display

- **Provider, model, and thinking:** the active provider, model ID, and thinking level. Uses Pi's provider field, not the vendor label in the model's display name.
- **Context:** a 20-cell progress bar with bright filled cells and a muted empty track, percentage, and estimated tokens / context window. The fill uses the theme's text color for contrast on dark and light backgrounds. Unknown context (such as immediately after compaction) shows `?`.
- **Cost:** Pi's reported cost for the active session branch, including tool, compaction, summary, and background usage entries. This is an estimate, not a subscription bill.
- **Cache:** cached input / total input across that branch. `new` is uncached input plus cache writes, excluding output tokens; it is cumulative, not the current context size.
- **Timer:** elapsed wall time for the current or most recent agent run, including tools and retries, stopping when the agent settles. Resets on reload, session change, and tree navigation; historical run times are not restored.
- **Project:** working directory (home abbreviated as `~`), Git branch if present, and status messages from other extensions.

Usage figures update from persisted session entries, not individual streaming token deltas. Lines truncate to fit narrow terminals. RPC, JSON, and print modes are unchanged.

This replaces Pi's default footer. Do not enable another footer replacement at the same time. Remove this package and run `/reload` to restore the default.

## License

MIT
