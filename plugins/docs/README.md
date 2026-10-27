# docs

Documentation MCP servers for OpenCode, added by the plugin so you do not have to
configure them:

| Server | Default | What it serves |
| --- | --- | --- |
| `context7` | on | Current library and framework docs and code examples from [Context7](https://context7.com) (`https://mcp.context7.com/mcp`) |
| `openaiDeveloperDocs` | off | The OpenAI developer documentation (`https://developers.openai.com/mcp`) |

Both are remote servers that answer without signing in, so the plugin sets
`oauth: false` and no sign-in step is needed. Context7 has a lower rate limit
without an API key: set `CONTEXT7_API_KEY` in the environment OpenCode starts in
and the plugin sends it as the `CONTEXT7_API_KEY` header. OpenCode does not expand
`{env:...}` in configs a plugin sets, so the plugin reads the variable itself when
it loads.

Both servers run in Code Mode: their tools are listed in the Code Mode catalog and
called through `execute`, instead of each tool schema going into every request.

## Options

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/docs",
    "options": {
      "mcp": "auto",                                    // "auto" (default) or "always" add the servers; "off" adds none
      "mcpServers": { "openaiDeveloperDocs": true }     // turn single servers on or off by name
    }
  }]
}
```

These servers help in any project, so `auto` and `always` behave the same here.

## Overriding a server

A server under the same name in your `opencode.json` wins: the plugin leaves it as
you configured it. Use that to change a URL, headers or `codemode`, or set
`"disabled": true` to keep a server configured but off. To drop one entirely, set it
to `false` in `mcpServers`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/docs'
```

The plugin is OpenCode-only and not in the Claude Code or Codex marketplace; Context7
ships its own plugins for those.
