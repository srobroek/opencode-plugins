# fnox MCP server (optional)

Source: https://fnox.jdx.dev/guide/mcp. `fnox mcp` serves secrets to an agent over stdio.
Default for projects: do not enable it; `fnox exec` from the shell tool is enough. Enable
only when the user asks, for example to let the agent request a missing secret.

Redaction and allowlists are not isolation: the agent chooses the command, and a command
can encode or send a value. Never enable `get_secret`, which returns raw values.

```toml
# fnox.toml
[mcp]
tools = ["exec", "request_secret"]     # the default is ["get_secret", "exec"]: set it explicitly
secrets = ["STRIPE_KEY", "SENTRY_TOKEN"]   # allowlist; default is every secret in the profile
```

- `exec` runs a command with the allowed secrets and returns output with values replaced
  by `[REDACTED]` (literal matches only; base64 slips through).
- `request_secret` asks the agent's client for a one-time local page where the user types the
  value; the model never sees it. It needs MCP URL-mode elicitation; otherwise fnox tells
  the agent to ask the user to run `fnox set NAME`. fnox refuses plaintext storage: the
  secret's provider (or `default_provider`) must encrypt (age), be a local store
  (`keychain`), or be remote (1password, which is read-only for `fnox set`, so prefer a
  keychain or age provider here).
- The machine keys the user's shells load at start, and anything the OpenCode service
  inherited, stay readable by the agent regardless of `[mcp]`; keep project secrets
  `env = "exec"`.

OpenCode project config (`opencode.jsonc`, V2 `mcp.servers`; start from the project
directory so `fnox.toml` is found, and sign in to providers first because the server
never prompts):

```jsonc
{
  "mcp": {
    "servers": {
      "fnox": { "type": "local", "command": ["fnox", "mcp"] }
    }
  }
}
```

Use `["fnox", "-P", "staging", "mcp"]` to serve a profile. Ask before adding it.
