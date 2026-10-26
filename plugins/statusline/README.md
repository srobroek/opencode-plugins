# statusline

An omp-style status line for the OpenCode TUI. It appends one row above the
session composer (the `session.composer.top` slot) and keeps the built-in
spinner and prompt footer.

```
e876be5e  mac  Opus 4.5 · high  build  ~/dev/app  main *2      12.3%/1M  Fix login  ↑1.2k  ↓3.4k  ⟳5.6k  ✎780  48.2 tok/s  3m12s
```

The segment order mirrors the omp `statusLine` config:

| Side | Segment | Shows |
| --- | --- | --- |
| left | `session` | First 8 characters of the session id, in the session accent colour |
| left | `hostname` | Short host name |
| left | `model` | Selected model name, plus the variant when one is set |
| left | `agent` | Session agent (omp's `mode` slot) |
| left | `path` | Session directory via `ui.format.path`, tail-truncated to `pathMaxLength` |
| left | `git` | Branch and changed-file count (`main *2`) |
| right | `context_pct` | Context in use for the latest step, over the model's context window (`12.3%/1M`) |
| right | `session_name` | Session title, in the session accent colour |
| right | `token_in` / `token_out` | Session input and output tokens |
| right | `cache_read` / `cache_write` | Session cache tokens |
| right | `token_rate` | Output tokens per second of the latest step |
| right | `time_spent` | Total time spent in assistant steps |

The accent colour comes from a hash of the session title (the id until a title
exists), picked from the theme's categorical palette.

When the row is too wide, the title goes first, then right-side segments from
the far end. The left side truncates last.

omp-only segments (`pi`, omp modes, hook statuses, PR number) have no OpenCode
equivalent. The git segment counts changed files; OpenCode's VCS status does not
split staged, unstaged and untracked.

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
        "segments": ["session", "model", "git", "context_pct", "session_name", "time_spent"],
        "separator": "plain"
      }
    }
  ]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `segments` | all, in the order above | Segment ids to show. Each id keeps its side; order within a side follows this list. |
| `separator` | `powerline` | `powerline` uses Nerd Font thin arrows (U+E0B1 / U+E0B3); `plain` uses ` · `. |
| `pathMaxLength` | `60` | Column limit for the path segment. |

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
