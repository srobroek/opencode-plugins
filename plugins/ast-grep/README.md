# ast-grep

Structural code search with the [ast-grep](https://ast-grep.github.io/) CLI, and a skill on
when to use it, Semgrep, or a language server instead.

| Skill | When |
| --- | --- |
| `ast-grep-search` | Finding call sites, API usage or code shapes by syntax rather than text; bounded CLI output; per-language gotchas (Rust macro arguments need a token-tree arm, a bare Go qualified call parses as a type conversion, `typescript` skips `.tsx`); rewrites as a preview diff applied through the edit tool; Semgrep for context-dependent queries; Serena or `rust-analyzer ssr` for renames and macro-wide Rust rewrites; `gopls rename -d`, `tsc --noEmit`, `pyright --outputjson` and `rust-analyzer diagnostics` as read-only checks |

The plugin registers the skill. It ships no MCP server: the old `ast-grep-mcp` server took
about 10 s to start cold and returned every match in full unless the agent passed
`max_results` (2 MB for one broad Rust pattern), while the CLI answers in well under a
second and its output is bounded with `head`. Without `ast-grep` on the `PATH` OpenCode
starts with (or `AST_GREP_PATH`), the plugin logs one warning and the skill falls back to
grep; run `/reload` after installing it. `sg` alone does not count, since on Linux it is
usually shadow-utils' group command.

Prerequisites: `ast-grep` (`brew install ast-grep`, `mise use -g ast-grep`,
`cargo install ast-grep --locked` or `npm i -g @ast-grep/cli`). Semgrep is optional
(`mise use -g pipx:semgrep` or `brew install semgrep`).

### Agents

`agent-coder`'s `coder` runs the CLI through its shell. `agent-reviewer`'s
`code-reviewer` may run `ast-grep run`/`scan` and `semgrep scan`, with the writing flags
(`-U`, `--update-all`, `-i`, `--autofix`) denied. `security-reviewer` has no shell, so it
loads the skill and searches with grep.

### Claude Code and Codex

The marketplace export ships the same skill.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/ast-grep'
```

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install ast-grep@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add ast-grep@srobroek-opencode
```
