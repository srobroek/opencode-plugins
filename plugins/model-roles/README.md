# model-roles

Gives agents a model *role* instead of a fixed model. Each role is an ordered
list of candidate models, and the plugin picks the first one that is available
on this machine. The same agent files can then run on Bedrock at work and on
Anthropic at home.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/model-roles'
```

Keep the options in your **global** config (`~/.config/opencode/opencode.json`).
A second plugin entry in a project config replaces these options; it does not
merge with them.

## Options

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/model-roles",
    "options": {
      "roles": {
        "task": ["amazon-bedrock/global.anthropic.claude-sonnet-5-5#high", "anthropic/claude-sonnet-5-5#high"],
        "smol": ["anthropic/claude-haiku-5-5", "ollama/qwen3:8b"],
        "slow": ["anthropic/claude-opus-5-5#max", "@task"]
      },
      "agents": { "general": "task", "explore": "smol", "title": "smol" },
      "fallback": "keep"
    }
  }]
}
```

- `roles`: role name to one candidate or a list. A candidate is
  `provider/model` or `provider/model#variant`. `@other` tries another role's
  candidates at that point in the list.
- `agents`: agent id to role. Use this for builtins (`general`, `explore`,
  `title`, `compaction`) or to override an agent's own role.
- `fallback`: only `"keep"` is supported. If nothing matches, the agent keeps
  its own model, or inherits one if it has none.

## Declaring a role in an agent file

Put the role in a request header. The plugin removes this header before any
request reaches a provider. Without the plugin, the agent uses its own `model`.

```md
---
description: Reviews changes
mode: subagent
model: anthropic/claude-sonnet-5-5#high
request:
  headers:
    x-opencode-model-role: task
---
```

Don't use a frontmatter `role:` key. OpenCode either drops it, or reads the
file as V1 and drops a `#variant` model.

If both are set, the `agents` option wins over the header.

## Resolution

1. The plugin tries the role's candidates in order.
2. It follows `@role` links. A link that loops back or names an unknown role is
   skipped.
3. A candidate counts only if `ctx.model.list()` returns it as enabled, which
   accounts for credentials and `provider.use` policies, and only if its
   variant (when given) exists.
4. If nothing matches, or the role is unknown, the agent keeps its own model.
   The plugin never sets a model that isn't available.

Config and markdown agents load after user plugins. On `agent.updated`,
`model.updated` and `provider.updated` the plugin re-registers its agent
transform, which puts it last again. It does this only when an agent's model is
out of date or availability has changed. It gives up after three attempts in a
row that don't converge.
