# lsp

Appends new LSP errors to `edit`, `write` and `patch` results. OpenCode V2
runs no language servers itself, so this plugin calls the `diagnostics` tool of
[lsp-tools-mcp](https://github.com/code-yeongyu/lsp-tools-mcp), an MCP server
that also gives the agent go-to-definition, references, symbols and rename.

After each completed edit the plugin asks the diagnostics tool for errors in
every file the call touched and appends only the errors the edit introduced:

```
Edited src/main.ts (1 replacement)
LSP: 1 new error after this edit
src/main.ts
  error[typescript] (2345) at 3:29: Argument of type 'string' is not assignable to parameter of type 'number'.
```

- New means not in the baseline for that session and file. The first time a
  session touches an existing file, the plugin records its errors before the
  edit runs; after each edit the baseline becomes the errors it just saw. An
  error that only moved to another line is not new.
- Warnings, hints and pre-existing errors are never appended.
- Each check has an 8 s budget. A slow, failing or missing diagnostics tool
  leaves the result unchanged.
- Patch deletes and the source of a patch move are skipped. Shell commands
  are not checked.

## Install

1. Install a language server for each language you want checked and put it on
   `PATH`, for example `npm i -g typescript typescript-language-server`,
   `pyright`, `gopls` or `rust-analyzer`.
2. Build lsp-tools-mcp at the pinned commit. It is young and single-maintainer,
   so pin it rather than following `main`:

   ```sh
   git clone https://github.com/code-yeongyu/lsp-tools-mcp ~/.local/share/lsp-tools-mcp
   cd ~/.local/share/lsp-tools-mcp
   git checkout 9cc6f753d04834c148d08bbca72e3b483d6301b2
   npm ci && npm run build
   ```

3. Register it as the MCP server `lsp` with Code Mode off, and add the plugin:

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "mcp": {
       "servers": {
         "lsp": {
           "type": "local",
           "command": ["node", "/Users/you/.local/share/lsp-tools-mcp/dist/cli.js", "mcp"],
           "codemode": false
         }
       }
     }
   }
   ```

   ```sh
   opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/lsp'
   ```

The server name `lsp` makes the diagnostics tool `lsp_diagnostics`, which is
the plugin's default. `codemode: false` exposes the LSP tools to the agent
directly instead of behind Code Mode's `execute`. lsp-tools-mcp picks a
workspace root per file, so one server serves every worktree. To configure
servers beyond its built-in defaults, point `LSP_TOOLS_MCP_PROJECT_CONFIG` or
`LSP_TOOLS_MCP_USER_CONFIG` at a config file (see its README).

The plugin calls the MCP tool as `lsp_diagnostics`, so a permission rule for
that action also applies to the plugin's calls. Leave it allowed.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `tool` | `lsp_diagnostics` | Effective name of the diagnostics tool: `<server>_diagnostics` |
| `timeout` | `8000` | Budget per check, in milliseconds |
| `maxLines` | `20` | Most diagnostic lines appended to one result |
| `baseline` | `true` | Record a file's errors before a session's first edit to it. `false` reports every error on that first edit |

## Caveat

Plugins reach MCP tools through `ctx.tool.list()` and the tool's `execute`.
That path works on OpenCode 2.1.4 but is not documented. If it breaks, the
plugin goes silent rather than failing edits.
