# 0004. LSP through an MCP bridge plus a diagnostics plugin

## Context

On the 2.1.4 spike, OpenCode ran no language servers itself (upstream issue
#38528 was open). Six MCP bridges were tested on TypeScript, Python, Go and Rust.
Only `code-yeongyu/lsp-tools-mcp` and `oraios/serena` passed on all four.

## Decision

- Navigation and rename use `lsp-tools-mcp`, pinned to a commit, with
  `codemode: false`.
- A small V2 plugin calls `lsp_diagnostics` on edited files in `execute.after`
  and appends the errors to the tool result.
- Fallback for diagnostics, if the undocumented MCP call breaks: the
  IronWolf native plugin. Serena is optional for symbol editing.

OpenCode names MCP tools `<server>_<tool>`, so under the server `lsp` the tool
is `lsp_diagnostics`.

## Status

Accepted and implemented in `plugins/lsp`. Re-verified against the installed
`@opencode/plugin` 2.3.2 and `@opencode/schema` typings: neither exposes a
language-server or LSP API (no `lsp` or `language server` match). This checks
the typings only. The runtime behaviour of 2.3.2 and the status of #38528 were
not checked, so the original claim that OpenCode runs no language servers is
unconfirmed for later releases.

## Consequences

- Diagnostics add about 1.5 to 3 seconds per edit.
- The bridge is a dependency that needs pinning and review on each bump.
