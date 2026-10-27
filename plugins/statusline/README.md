# statusline

An omp-style status line for the OpenCode TUI. It appends one row above the
session composer (the `session.composer.top` slot) and keeps the built-in
spinner and prompt footer.

```
Opus 4.5 · high  build  ~/dev/app   main *2  12.3%/1M  $0.42        Fix login  42.0 tok/s
```

The default layout is omp's `default` preset: model and effort, agent, path, git,
context and cost on the left, the session title and tokens per second on the right.
On a narrow row `token_rate` is the first segment dropped, after the title has shrunk.

| Segment | Default side | Shows |
| --- | --- | --- |
| `model` | left | Model name in bold session accent, then the effort variant, dimmed |
| `agent` | left | Session agent (omp's `mode` slot), dimmed |
| `path` | left | Session directory via `ui.format.path`, parent faint and leaf bright |
| `git` | left | Branch and changed-file count; green when clean, amber when dirty |
| `context_pct` | left | Context in use over the model window (`12.3%/1M`); amber from 50% or 150k tokens, red from 90% or 500k |
| `cost` | left | Session spend (`$0.42`; two significant digits under a cent) |
| `session` | left | First 8 characters of the session id, in the session accent |
| `hostname` | left | Short host name |
| `session_name` | right | Session title, in the session accent |
| `token_in` / `token_out` | right | Session input and output tokens |
| `cache_read` / `cache_write` | right | Session cache tokens |
| `token_rate` | right | Output tokens per second of the latest step |
| `time_spent` | right | Total time spent in assistant steps |

`session`, `hostname`, the token and cache counts and `time_spent`
are off by default; list them in `segments` to show them.

Colours are theme tokens only: values use `text.base`, labels, units and
separators `text.faint`, secondary values `text.muted`, git and context state the
theme's `feedback` colours. The accent comes from a hash of the session title (the
id until a title exists), picked from the theme's categorical palette.

When the row is too wide it fits in omp's order: the title shrinks (to 8
columns), right-side segments drop from the far end, the path shrinks (to 8
columns), then left-side segments drop from the far end with the path last.

omp-only segments (`pi`, omp modes, hook statuses, PR number) have no OpenCode
equivalent. The git segment counts changed files; OpenCode's VCS status does not
split staged, unstaged and untracked. A model-roles tier is not shown: the TUI
has no read access to the tier a session runs under.

## Install

TUI plugins are configured in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["github:srobroek/opencode-plugins::path:plugins/statusline"]
}
```

With options:

```json
{
  "plugins": [
    {
      "package": "github:srobroek/opencode-plugins::path:plugins/statusline",
      "options": {
        "segments": { "left": ["model", "git", "context_pct"], "right": ["token_in", "token_out", "session_name"] },
        "separator": "plain"
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `segments` | the layout above | Order and visibility. `{ "left": [...], "right": [...] }` places each id on that side; a flat list keeps each id on its default side, in list order. |
| `separator` | `powerline` | `powerline` uses Nerd Font thin arrows (U+E0B1 / U+E0B3) and the branch glyph (U+E0A0); `plain` uses ` · ` and no glyphs. |
| `pathMaxLength` | `40` | Column limit for the path segment. |

To also hide the built-in footer (context, cost, shortcuts), add
`"-opencode.prompt.footer"` to `plugins`. The location line under the composer
stays.

## Development

`src/tui.tsx` is bundled to `dist/tui.js` by `bun run build` with the OpenTUI
Solid transform (OpenCode does not compile TSX under `node_modules`). Commit the
rebuilt `dist/` and root `tui.js` shim with source changes; `bun run check`
fails when they are stale.

All formatting, truncation and accent logic lives in `src/format.ts` and is
tested in `src/format.test.ts`.
