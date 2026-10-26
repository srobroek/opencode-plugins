# LSP on OpenCode V2 (opencode-plugins-ngm.8)

V2 2.1.4 runs no language servers (#38528 open). Tested six MCP bridges on TS,
Python, Go and Rust (typescript-language-server, pyright, gopls, rust-analyzer).

| Server | Tokens | Result |
| --- | --- | --- |
| code-yeongyu/lsp-tools-mcp (MIT) | ~600 | Pass (py/ts/go; rs nav empty while indexing). Root per file, works across worktrees. Rename writes to disk. Young, single maintainer: pin a commit. |
| oraios/serena 2.1.0 (GPL) | ~1.2k REPL, 6-8k tools | Pass all four; best freshness. One project per process; writes .serena/. |
| agent-lsp 0.23.2 | ~12.6k | Partial; one failing server fails start_lsp. |
| mcpls 0.8.0 | ~12.4k + schemas | Partial; gopls diagnostics fail; needs retries. |
| isaacphi/mcp-language-server | ~900 per process | Partial; stale. |
| cclsp 0.7.0 | ~1.6k | Fail; never sees external edits. |

OpenCode facts: one MCP process per location (root follows the worktree);
plugins can call MCP tools via `ctx.tool.list()` entries `<server>_<tool>` and
`execute(input, {sessionID, agent, messageID, id, signal, progress})`
(undocumented); `codemode: false` exposes tools directly.

Decision: hybrid. lsp-tools-mcp with `codemode: false` for navigation and rename,
plus a small V2 plugin that calls `lsp_diagnostics` on edited files in
`execute.after` and appends errors. Fallback if the undocumented MCP call breaks:
the IronWolf native plugin for diagnostics. Serena optional for symbol editing.
Scratch evidence: $TMPDIR/opencode/lspmcp.

Implemented in `plugins/lsp` (opencode-plugins-4p3.2). OpenCode names MCP tools
`<server>_<tool>` from the server's `tools/list` name, and lsp-tools-mcp lists
`diagnostics`, so under server `lsp` the tool is `lsp_diagnostics` (its
`lsp_diagnostics` alias is call-only). Live check on 2.1.4 with lsp-tools-mcp
9cc6f75: an edit introducing a TS2345 got it appended (~3 s cold, ~1.5 s warm);
a later session's edit shifting that error a line appended nothing.
