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

## Subagent model guard

An agent with no model and no resolvable role inherits the session's model. The
optional guard refuses a `subagent` spawn when that inherited model is
expensive. The refusal lists the subagents that pin a cheaper model and the
roles that resolve to one.

```jsonc
"guard": {
  "expensive": "auto",
  "threshold": 4,
  "allowInherit": ["fork"]
}
```

- `guard`: off when absent. `true` turns it on with the defaults.
- `expensive`: `"auto"` (default) counts a model as expensive when its
  base-tier input cost from `ctx.model.list()` is at least `threshold` USD per
  million tokens (default 4). It can also be a list such as
  `["amazon-bedrock/global.anthropic.claude-opus-5-5"]`. An entry with a
  `#variant` matches only that variant.
- `allowInherit`: agent ids that may inherit the session model.

A spawn is allowed if the target agent has a model, or a role that resolves
(through the `agents` option or the header). The session model is
`session.model`, or the calling agent's model if the session has none. If any
lookup fails, the spawn goes ahead. Resumed spawns (with `sessionID`) are not
checked.
