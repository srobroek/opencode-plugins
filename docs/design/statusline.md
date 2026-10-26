# Statusline parity (opencode-plugins-ngm.3)

Of the 16 omp status line segments (`~/.omp/agent/config.yml`, owned by chezmoi
`.chezmoitemplates/omp/policy.yml.tmpl`), OpenCode 2.1.4 already shows 3 (model,
variant, subagent/shell counts), about 10 can be built from TUI plugin data APIs,
and 3 are omp-only (pi brand/profile, omp modes, hook statuses). The compaction
indicator is not exposed.

Design: a TUI plugin `plugins/statusline` exporting `./tui`, appending one row to
the `session.composer.top` slot (keeps the built-in spinner and footer). Segments
from `data.session.get` (title, tokens, cost), `data.session.message.list`
(context %, tok/s, time spent), `ui.model.current` + `data.location.model.list`
(context window), `data.location.vcs.info` (branch), `client.vcs.status` (dirty
count). Exact staged/unstaged split and PR number need `git`/`gh` from the plugin
(local server only). Pure formatting functions under `bun test`.

Repo changes: tsconfig `jsx: preserve`, `jsxImportSource: @opentui/solid`,
include `*.tsx`; devDependencies `@opentui/core`, `@opentui/solid`, `solid-js`,
`@opencode/theme@2.1.4` (peers >= 0.6.8).

Verified on 2.1.4 (opencode-plugins-4p3.5):

- `"-opencode.prompt.footer"` in `cli.json` `plugins` disables the built-in
  `opencode.prompt.footer` TUI plugin (a leading `-` disables matching builtin
  ids). The usage/cost/shortcuts text goes; the location line stays.
- A local directory plugin resolves `<dir>/tui` by path (`Bun.resolveSync`), not
  through `package.json` exports; a package plugin resolves `<name>/tui` through
  exports. The root `tui.js` shim from `scripts/build.ts` covers the first case.
- The CLI registers the OpenTUI Solid transform for `.tsx` outside
  `node_modules` only. TSX inside `node_modules` falls back to Bun's JSX and
  fails (`Cannot find package 'react'`). `scripts/build.ts` therefore applies
  `@opentui/solid/bun-plugin` and keeps `@opentui/*` and `solid-js` external,
  since the host provides them alongside `@opencode/plugin/*`. A bundled
  `dist/tui.js` loaded from under `node_modules` renders and updates reactively.
- The host does not provide `@opencode/client`, and `@opencode/client/solid`
  pulls in effect and schema modules. The plugin keeps a local
  `lastAssistantWithUsage` with a parity test against the upstream one.
- No server entry is needed; a TUI-only package loads.

Effort: 2-3 days. Sketch: `statusline-sketch.tsx`.
