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
- `cooldownMs`: how long a failed model sits out (default `600000`, 10 min).
  See [Runtime fallback](#runtime-fallback).
- `retryOnFallback`: retry a failed root session once on the next model
  (default `true`).
- `roleAgents`: roles that get a `general-<role>` subagent (default
  `["smol", "task", "slow", "challenger"]`, limited to the roles you
  configured; `[]` turns them off). See [Role subagents](#role-subagents).
- `guard`: see [Subagent model guard](#subagent-model-guard).

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
`session.model`, else the calling agent's model, else the parent session's
(a session that inherits carries no model), else the default model. A root
session on the configured default model has no `session.model`. If any
lookup fails, the spawn goes ahead. Resumed spawns (with `sessionID`) are not
checked.

The `general-<role>` subagents are listed first in the refusal.

## Runtime fallback

OpenCode doesn't fall back to another model on its own. The `retry` hook can
only retry the same model, and a subagent whose model is unavailable fails
with `Model unavailable`. The plugin adds the fallback:

1. On `session.execution.failed`, or when a `subagent` call fails, it checks
   whether the model or provider caused the error: model unavailable,
   auth or credential errors, 401/403, 429 or throttling, 5xx or overloaded,
   and Bedrock's `The provided model identifier is invalid`.
   User interrupts, tool errors and context overflow don't count.
2. The failed model (all its variants) is marked unhealthy for `cooldownMs`
   in plugin storage, under `health`.
3. Roles are resolved again. Unhealthy candidates are skipped, so agents on
   that role move to the next candidate. If every available candidate is
   unhealthy, the one that failed longest ago is used. When a cooldown ends,
   the roles are resolved again.
4. Then, depending on the session:
   - **Root session** with `retryOnFallback`: the plugin switches the session
     to the next model (`session.switchModel`) and sends one short message
     asking it to continue. A session is retried at most once per
     `cooldownMs`. After that it only gets a note.
   - **Subagent session**, or a failed `subagent` call: the parent gets a
     note that does not start a turn (`session.synthetic`, steer). The note
     names the failed model and the next one, and says the spawn may be
     retried. The child's failure event and the tool error produce one note
     between them.

Every fallback is logged (`console.warn`) and shown in the session. The model
is the one the error names (`Model unavailable: provider/model`), else the
session's model, found the same way as for the guard.

## Role subagents

For each role in `roleAgents`, the plugin registers a `general-<role>`
subagent. It copies `general`'s system prompt, steps and permissions, and
carries the role header, so it runs on that role's model. Its description
gives the role's purpose and the resolved model's cost tier:

- `smol`: cheap and fast work, such as lookups, summaries, log and diff
  reading, and mechanical edits.
- `task`: everyday implementation and investigation.
- `slow`: hard reasoning, such as design, root-cause debugging, and subtle
  concurrency or data-integrity work.
- `challenger`: an independent second opinion or review.

The parent then picks a role for each spawn by agent name. Fields you set
yourself for an agent with the same id take precedence, except the role
header.

## Check

`model_roles_check` is a read-only tool. It checks every role candidate
against `ctx.model.list()` across all providers, enabled or not, and reports
one of: available, unknown id, unknown variant (listing the ones that
exist), provider unavailable, unhealthy until a time, or a link to another
role. It also shows what each role resolves to, and the model each
role-bearing agent ends up on.

The same check is exported for scripts: `checkRoles(options, models, agents,
health?, now?)` returns the report, and `formatCheck(report)` turns it into
text. Pass `parseOptions(yourOptions)` and the `data` of a `model.list` call.
