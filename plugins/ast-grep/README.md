# ast-grep

Structural code search with [ast-grep](https://ast-grep.github.io/): the
[ast-grep MCP server](https://github.com/ast-grep/ast-grep-mcp), added where the
`ast-grep` binary is installed, and a skill on when and how to use it.

| Skill | When |
| --- | --- |
| `ast-grep-search` | Finding call sites, API usage or code shapes by syntax rather than text; pattern syntax and per-language gotchas (Rust macro arguments are not matched, `typescript` skips `.tsx`); rewrites as a preview diff applied through the edit tool; `gopls rename -d`, `tsc --noEmit`, `pyright --outputjson` and `rust-analyzer diagnostics` as read-only checks |

## MCP server

The plugin adds the server in [`.mcp.json`](.mcp.json), pinned to a commit since the
project has no releases. `--python 3.13` matches the project's `.python-version`: without
it uvx picks the newest Python, where `pydantic-core` may have no wheel yet and builds from
source with a Rust toolchain:

| Server | Command | Tools |
| --- | --- | --- |
| `ast-grep` | `uvx --python 3.13 --from git+https://github.com/ast-grep/ast-grep-mcp@149e20d47bb7125fb0c1451feea2f48a98742034 ast-grep-server` | `find_code`, `find_code_by_rule`, `dump_syntax_tree`, `test_match_code_rule`; all read-only |

In OpenCode it runs in Code Mode (`tools["ast-grep"].find_code(...)`) with a 120 s
startup timeout, since the first start builds the `uvx` environment from git (about
18 s on a fast link).

Prerequisites: `uv` and `ast-grep` on `PATH` (`brew install ast-grep`,
`cargo install ast-grep --locked`, `npm i -g @ast-grep/cli` or `pip install ast-grep-cli`).
The server calls `ast-grep`, or the command in `AST_GREP_PATH` when that is set.

### When OpenCode adds it

By default (`mcp: "auto"`) the plugin adds the server only when `ast-grep` is on the
`PATH` OpenCode starts with, or `AST_GREP_PATH` is set. Otherwise it logs one warning and
registers only the skill, which falls back to grep. `sg` alone does not count: the server
never calls it, and on Linux `sg` is usually shadow-utils' group command. If your only
binary is `sg`, set `AST_GREP_PATH=sg`. The check runs when the plugin loads; run
`/reload` after installing ast-grep.

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/ast-grep",
    "options": {
      "mcp": "always"   // "auto" (default), "always", or "off" for no server
    }
  }]
}
```

A server named `ast-grep` in your `opencode.json` wins: the plugin leaves it as you
configured it.

### Agents

`agent-coder`'s `coder` and `agent-reviewer`'s `code-reviewer` and `security-reviewer`
may load `ast-grep-*` skills and call `ast-grep_*` tools through Code Mode.

### Claude Code and Codex

The marketplace export ships the same skill and `.mcp.json`, so the server starts in
every project there, with no binary check. Its tools fail until `ast-grep` is installed.

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
