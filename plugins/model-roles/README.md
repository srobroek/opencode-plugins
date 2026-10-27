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
- `quotaCooldownMs`: how long a spent quota sits out when the provider names
  no reset time (default `21600000`, 6 h).
- `hostRetries`: how many retries the host may spend on the same model for a
  transient failure before the plugin switches the request (default `2`).
- `switchTimeoutMs`: how long the plugin waits for `session.switchModel`
  during a retry (default `2000`).
  See [Runtime fallback](#runtime-fallback).
- `purposes`: role name to a short text saying when to pick it, shown to the
  spawner. `smol`, `task`, `slow` and `challenger` have built-in texts. See
  [Choosing a role per spawn](#choosing-a-role-per-spawn).
- `guard`: see [Subagent model guard](#subagent-model-guard).
- `auto`: see [Auto routing](#auto-routing). Off when absent.

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
expensive. The refusal asks the spawner to pass `role` with the cheapest role
that resolves to a cheaper model and lists the other cheaper roles. It also
names up to five subagents that pin a cheaper model, by id and model. Their
descriptions (first sentence, at most 80 characters) appear only when no role
is cheaper.

```jsonc
"guard": {
  "expensive": "auto",
  "threshold": 4,
  "allowInherit": ["fork"],
  "allowModels": []
}
```

- `guard`: off when absent. `true` turns it on with the defaults.
- `expensive`: `"auto"` (default) counts a model as expensive when its
  base-tier input cost from `ctx.model.list()` is at least `threshold` USD per
  million tokens (default 4). It can also be a list such as
  `["amazon-bedrock/global.anthropic.claude-opus-5-5"]`. An entry with a
  `#variant` matches only that variant.
- `allowInherit`: agent ids that may inherit the session model.
- `allowModels`: expensive models a spawn may name in its own `model`
  argument. Same format as `expensive`.
- `mode`: `"refuse"` (default) refuses the spawn. `"auto"` asks the
  [auto decider](#auto-routing) for a role instead, offering only roles whose
  model is not expensive, and refuses only when none resolves. It uses the
  `auto` settings, or their defaults when `auto` is absent.

A spawn is allowed if it passes a `role` that resolves, or if the target agent
has a model, or a role that resolves (through the `agents` option or the
header).

Models often set the `subagent` tool's `model` argument even though its
description says not to. So a spawn that names an expensive `model` itself
(not one filled in from `role`) is refused too, unless the target agent pins
that model or `allowModels` lists it. The refusal asks for the cheapest role
instead, and names the role that resolves to the requested model, if there is
one. The session model is
`session.model`, else the calling agent's model, else the parent session's
(a session that inherits carries no model), else the default model. A root
session on the configured default model has no `session.model`. If any
lookup fails, the spawn goes ahead. Resumed spawns (with `sessionID`) are not
checked.

## Runtime fallback

OpenCode doesn't fall back to another model on its own: its retries stay on
the same model. The plugin adds the fallback in the host's `retry` hook, which
runs before every retry of a failed model request, in root and child sessions
alike:

1. It checks whether the model or provider caused the error, and how:

   | Kind | Examples | Cools down | Budget |
   | --- | --- | --- | --- |
   | `rate-limit` | 429, throttling | the model | transient |
   | `server` | 5xx, overloaded | the model | transient |
   | `outage` | connection refused, DNS, fetch failed | the provider | transient |
   | `auth` | 401/403, bad or expired credentials or SSO | the provider | permanent |
   | `quota` | 402, spent quota, billing, weekly or daily usage limit, subscription session or usage limits (`claude_session_limit`, `usage_limit_reached`, `subscription_sharing_usage_limit_exceeded`) | the provider | permanent |
   | `unavailable` | unknown or retired model, Bedrock's `The provided model identifier is invalid` | the model | permanent |
   | `content-filter` | blocked by a content or safety filter | the model | permanent |

   User interrupts, tool errors and context overflow don't count, and the
   host's own decision stands.
2. A transient failure stays on the same model for the first `hostRetries`
   retries. A permanent one switches on the first retry.
3. The failed model, or its whole provider, is marked unhealthy in plugin
   storage, under `health`. A model's variants share its health. The cooldown
   is `cooldownMs`. A spent quota sits out until the reset time the error
   reports (an ISO time, a unix `reset` stamp, a `resets_in_seconds` or
   `Retry-After` count, or a span such as `resets in 3h 20m`), else for `quotaCooldownMs`. Roles are resolved again,
   so agents on that role move to the next candidate. When a cooldown ends,
   the roles are resolved again.
4. The request moves to the next healthy candidate of the session's role: the
   `role` the session was spawned with, else its agent's role, else the first
   role that lists the failed model. The plugin calls `session.switchModel`
   and tells the host to retry at once. The host reloads the session before
   each attempt, so the same turn continues on the new model. Nothing is
   replayed and no message is sent. This also covers errors the host would
   not retry, such as a 401.
5. If `session.switchModel` takes longer than `switchTimeoutMs`, the host's
   own decision stands. The switch keeps landing in the background and is
   picked up by the next attempt. Until it lands, the session isn't switched
   again.
6. A model that is cooling down is never a target, so two failing models
   can't take turns. When no healthy candidate is left, the host's own
   decision stands.

Without the plugin's switch, the host retries a transient error on the same
model about ten times over roughly 80 seconds (seen with a provider that keeps
answering 503) before `session.execution.failed` fires. With a healthy
candidate left, the switch happens after `hostRetries` retries.

Some failures never reach the `retry` hook, such as a spawn whose model is
unavailable. And sometimes nothing healthy is left. For those, on
`session.execution.failed` or a failed `subagent` call, the plugin marks the
model unhealthy and leaves a note that does not start a turn
(`session.synthetic`, steer):

- A **root session** gets a note naming the failed model and what its role
  resolves to now. The plugin doesn't switch or wake it: switching an idle
  session could change a turn the user starts later.
- A **subagent session**, or a failed `subagent` call, leaves the note in the
  parent. The note names the failed model and the next one, and says the
  spawn may be retried. The child's failure event and the tool error produce
  one note between them. For a child spawned with `role`, the plugin also
  switches the child to the role's next model, and the note says to spawn
  again with the same `role` or resume the child by `sessionID`.

Every fallback is logged (`console.warn`). The model is the one the error
names (`Model unavailable: provider/model`), else the session's model, found
the same way as for the guard. Notes leave out the host's `#default` variant.

## Choosing a role per spawn

The plugin adds an optional `role` parameter to OpenCode's built-in
`subagent` tool, so the spawner picks the model tier for each call. It is an
enum of the configured roles. Each role is described with its purpose and a
cost tier, taken from the cheapest available candidate's input cost:

- `smol`: cheap and fast work, such as lookups, summaries, log and diff
  reading, and mechanical edits.
- `task`: everyday implementation and investigation.
- `slow`: hard reasoning, such as design, root-cause debugging, and subtle
  concurrency or data-integrity work.
- `challenger`: an independent second opinion or review.

Other roles use the text from the `purposes` option. The descriptions are
refreshed when model availability changes.

Before the tool runs, the plugin resolves the role the same way as for agents,
skipping unhealthy models, then sets the call's `model` to the result and
removes `role`. The model is chosen in this order:

1. an explicit `model` in the call
2. the `role` in the call
3. the target agent's role (from the `agents` option or the header)
4. the target agent's own model
5. the session's model, which the child inherits

The plugin never overrides an explicit `model` or a resumed spawn. An unknown
role refuses the spawn and lists the configured roles. A role with
nothing available falls through to step 3. A resumed spawn (with
`sessionID`) keeps its model. The plugin records the role each child was
spawned with (in plugin storage, under `spawn-role:<sessionID>`), so a
fallback for that child stays in the same role.

## Auto routing

Experimental, and off unless you set `auto`. When a fresh `subagent` spawn
names no `model` and no `role`, and its agent has no model and no role of its
own, a small model picks a role for it through `ctx.generate.text`.

```jsonc
"auto": {
  "decider": "@tiny",
  "roles": ["smol", "task"],
  "default": "task",
  "timeoutMs": 5000,
  "capAtParent": true
}
```

- `auto`: `true` turns it on with the defaults.
- `decider`: the role (`@tiny`) or `provider/model#variant` the decider runs
  on (default `@smol`). A role resolves like any other, skipping unhealthy
  models.
- `roles`: the roles the decider may pick (default `smol` and `task`). Roles
  that aren't configured are dropped. With none left, auto routing is off.
- `default`: the role a spawn gets when the decider isn't confident, replies
  with something other than the JSON it was asked for, fails, takes longer
  than `timeoutMs` (default 5000), or has no model. Defaults to `task` when
  allowed, else the first allowed role.
- `capAtParent`: when on (default), a role whose model costs more than the
  calling session's model steps down to the dearest allowed role at or under
  that cost.

The decider sees the agent id and description, the spawn's description, the
first 6000 characters of its prompt, and each allowed role's purpose and cost
tier. It answers `{"role": …, "confident": true|false}`; a code fence around
it is fine. The chosen role then applies as if the spawner had passed it, so
fallback stays in that role. The spawn description gets a tag such as
`[auto: smol, confident]` (or `unsure`, `invalid`, `timeout`, `error`,
`no-decider`, `capped from slow`), which becomes the child session's title.
`model_roles_check` lists the last 20 decisions of this server.

Auto routing never overrides an explicit `model` or `role`, a resumed spawn,
or an agent's own model or role, and it never touches a root session. The
spawn waits for the decider: about 1.5 s with Claude Haiku 4.5 on Bedrock
(p50 1.5 s, p95 1.8 s over 30 calls). The host ignores abort signals on
`ctx.generate.text`, so a decider past `timeoutMs` keeps running in the
background and its answer is dropped.

## Check

`model_roles_check` is a read-only tool. It checks every role candidate
against `ctx.model.list()` across all providers, enabled or not, and reports
one of: available, unknown id, unknown variant (listing the ones that
exist), provider unavailable, unhealthy until a time, or a link to another
role. It also shows what each role resolves to, the model each
role-bearing agent ends up on, and the values the `subagent` tool's `role`
parameter offers, with their purpose and cost tier, and the recent
[auto routing](#auto-routing) decisions.

The same check is exported for scripts: `checkRoles(options, models, agents,
health?, now?, purposes?)` returns the report, and `formatCheck(report)` turns it into
text. Pass `parseOptions(yourOptions)` and the `data` of a `model.list` call.
