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

To verify: `"-opencode.prompt.footer"` disables the built-in footer; how a TSX
`./tui` export is compiled at runtime.

Effort: 2-3 days. Sketch: `statusline-sketch.tsx`.
