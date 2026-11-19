# 0003. Statusline parity through a TUI plugin

## Context

The omp status line had 16 segments. OpenCode 2.1.4 shows three of them: model,
variant, and subagent and shell counts. About ten can be built from TUI plugin
data APIs. Three are omp-only (pi brand and profile, omp modes, hook statuses).
The compaction indicator is not exposed.

## Decision

`plugins/statusline` is a TUI-only package. It appends one row to the
`session.composer.top` slot, so the built-in spinner and footer stay. Segments
come from the session, message, model and VCS data APIs. Formatting functions
are pure and covered by `bun test`.

## Status

Accepted. Verified on 2.1.4:

- `"-opencode.prompt.footer"` in `plugins` disables the built-in footer
  plugin. A leading `-` disables the matching builtin id.
- A local directory plugin resolves `<dir>/tui` by path, not through
  `package.json` exports. The root `tui.js` shim covers this.
- The host registers the OpenTUI Solid transform only for `.tsx` outside
  `node_modules`. `scripts/build.ts` bundles `dist/tui.js` with the Solid
  plugin and keeps `@opentui/*` and `solid-js` external, because the host
  supplies them.
- `@opencode/client/solid` pulls in modules the host does not provide, so the
  plugin carries its own `lastAssistantWithUsage`, with a parity test.

## Consequences

- No server entry is needed.
- Staged and unstaged counts and the PR number need `git` and `gh` from the
  plugin, which work only on the local server.
