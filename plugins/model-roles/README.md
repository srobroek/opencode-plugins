# model-roles

Gives agents a model *tier* instead of a fixed model: `cheap`, `standard`,
`strong` or `reviewer`, plus any tiers you add. Each tier is an ordered list of
candidate models, and the plugin picks the first one that is available on this
machine. With no options at all it works the tiers out from the model catalog, so
the same agent files run on Bedrock at work and on a ChatGPT or Claude
subscription at home.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/model-roles'
```

Keep the options in your **global** config (`~/.config/opencode/opencode.json`),
in the plugin entry's `options` (OpenCode rejects unknown top-level keys). A second
plugin entry in a project config replaces these options; it does not merge with
them. The `/tiers` command (see [Editing tiers in the TUI](#editing-tiers-in-the-tui))
writes them for you.

## Options

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/model-roles",
    "options": {
      "tiers": {
        "cheap": { "model": "auto", "effort": "low" },
        "strong": {
          "model": ["amazon-bedrock/global.anthropic.claude-opus-5-5#xhigh", "amazon-bedrock/global.openai.gpt-6.1-sol"],
          "effort": "high"
        },
        "reviewer": { "distinctVendor": true },
        "docs": { "model": "auto", "effort": "medium", "purpose": "writing and editing documentation" }
      },
      "prefer": ["openai"],
      "agents": { "compaction": "standard" },
      "guard": true
    }
  }]
}
```

- `tiers`: tier name to its settings. Every field is optional, and a missing tier
  uses the defaults.
  - `model`: `"auto"` (default) derives the candidates from the catalog (see
    [Derived tiers](#derived-tiers)). Otherwise one candidate or an ordered list,
    which is the fallback order. A candidate is `provider/model`,
    `provider/model#effort` or `@tier`.
  - `effort`: a level (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`)
    applied to every candidate without its own `#effort`, mapped to the nearest
    variant the model has (ties go lower; a model with no variants gets none).
    `"auto"` leaves the variant to the [auto decider](#auto-routing) per spawn when
    `auto` is on, else to the model's default. Defaults: `cheap` low, `standard`
    medium, `strong` and `reviewer` high; custom tiers none.
  - `purpose`: when the spawner should pick the tier. The built-in tiers have
    texts of their own; set one for every custom tier, or `model_roles_check` warns.
  - `distinctVendor`: put candidates from another vendor than the calling
    session's model first. On by default for `reviewer` only.
- Built-in tiers: `cheap`, `standard`, `strong` and `reviewer`. `reviewer` with no
  model of its own uses `strong`'s candidates at its own effort. A custom tier with
  no model uses `standard`'s.
- `prefer`: provider ids, vendors (`anthropic`, `openai`, `google`) or
  `provider/model*` globs; derived candidates they name come first, within the
  same billing kind.
- `avoid`: the same forms; never derived (an explicit `model` list still wins).
- `include`: family prefixes the derivation keeps (default `claude`, `gpt`, `gemini`).
- `premium`: USD per million input tokens at or above which a model is premium
  (default 8). Premium models are never derived, and they are what the
  [guard](#subagent-model-guard) protects.
- `agents`: agent id to tier, for builtins or to override an agent's own tier.
  Without it, `explore` and `compaction` get `cheap`, `title` and `summary` get
  `cheap` at effort `none`, and `general` gets `standard` (unless `auto` is on).
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
- `guard`: see [Subagent model guard](#subagent-model-guard).
- `auto`: see [Auto routing](#auto-routing). Off when absent.

### Deprecated: `roles` and `purposes`

The old `roles` option (role name to a candidate list) still works. A role named
like a tier, or an old name for it, gives that tier its candidates when the tier
sets no `model`: `cheap` from `smol` (else `commit`), `standard` from `task`,
`strong` from `slow` (else `plan`, `architect`, `designer`), `reviewer` from
`reviewer` (else `challenger`, `judge`). The list is used as is, with no tier
effort unless the tier sets one. Every role also keeps resolving under its own
name, and a role with any other name becomes a custom tier. `purposes` (role name
to text) is read as the `purpose` of those tiers. Move both into `tiers`.

### Old role names

Headers and spawns that use the old role names keep working:

| Old name | Tier |
| --- | --- |
| `smol`, `commit` | `cheap` |
| `tiny` | `cheap` at effort `none` |
| `task` | `standard` |
| `slow`, `plan`, `architect`, `designer` | `strong` |
| `challenger`, `judge` | `reviewer` |
| `default` | none: the agent inherits the session model |

## Derived tiers

With `model: "auto"` (or no tier config) the plugin builds the tiers from
`ctx.model.list()` and the models.dev records OpenCode already loads:

1. **Billing kind.** `cost: []` is a flat plan (ChatGPT sign-in, `claude-code`),
   all-zero is free (dropped), anything else is metered (Bedrock, API keys).
2. **Price.** Metered models are ranked by their own base input price.
   Subscription models are ranked by the list price of the matching first-party
   models.dev record (`anthropic`, `openai`, `google`), which the plugin reads
   through a read-only model transform even when those providers are not
   connected. A model with neither is dropped as unranked.
3. **Pruning**, each reported by `model_roles_check`:
   - disabled, non-`active`, no tools or no text output;
   - families outside `include`;
   - special-purpose ids (`realtime`, `image`, `audio`, `tts`, `transcribe`,
     `embed`, `research`, `preview`, `search`, `computer-use`, `latest`, `live`,
     `oss`) and speed variants (`-fast`, `-ultrafast`);
   - Bedrock region duplicates (`global.` wins, then unprefixed, then regional);
   - superseded: an older model of the same provider, vendor and family;
   - stale: released more than 120 days before the newest of its provider and vendor;
   - dominated: a newer model of the same provider and vendor within 10% of its price;
   - premium: priced at or above `premium`.
4. **Lineup** per provider and vendor, cheapest first: `cheap` is the cheapest,
   `strong` the dearest, `standard` the ones between (with two, the dearer one).
5. **Order** within a tier across lineups: subscription before metered, then
   `prefer`, then price (ascending for `cheap` and `standard`, descending for
   `strong`), then newer first, then id.

On a Bedrock-only machine this gives `cheap` = Haiku 5.5, GPT-6 Luna;
`standard` = GPT-6.1 Sol, Sonnet 5.5; `strong` = Opus 5.5, GPT-6.1 Sol.

## Declaring a tier in an agent file

Put the tier in a request header. The plugin removes this header before any
request reaches a provider. Without the plugin, the agent uses its own `model`.

```md
---
description: Reviews changes
mode: subagent
model: anthropic/claude-sonnet-5-5#high
request:
  headers:
    x-opencode-model-role: reviewer
---
```

Don't use a frontmatter `role:` key. OpenCode either drops it, or reads the
file as V1 and drops a `#variant` model.

If both are set, the `agents` option wins over the header.

### Agents that declare no tier

A subagent (`mode: subagent`) with no model and no tier is classified **once**
from its description: the decider (the [auto](#auto-routing) `decider`, by default
`cheap` at effort `none`) picks one of the tiers by purpose. The answer is stored
in plugin storage under `classify:<agent id>` with a hash of the description, so
it is asked again only when the description changes. Until the answer arrives the
agent inherits; when the decider fails, the agent runs on `standard` for this run
and is asked again on the next start. `general` is never classified: it gets
`standard`, or the per-spawn auto picker when `auto` is on.

## Resolution

1. The plugin tries the tier's candidates in order.
2. It follows `@tier` links. A link that loops back or names an unknown tier is
   skipped.
3. A candidate counts only if `ctx.model.list()` returns it as enabled, which
   accounts for credentials and `provider.use` policies, and only if its
   variant (when given) exists.
4. If nothing matches, or the tier is unknown, the agent keeps its own model.
   The plugin never sets a model that isn't available.

Config and markdown agents load after user plugins. On `agent.updated`,
`model.updated` and `provider.updated` the plugin re-registers its agent
transform, which puts it last again. It does this only when an agent's model is
out of date or availability has changed. It gives up after three attempts in a
row that don't converge.

## Subagent model guard

An agent with no model and no resolvable tier inherits the session's model. The
optional guard refuses a `subagent` spawn when that inherited model is
expensive. The refusal asks the spawner to pass `tier` with the cheapest tier
that resolves to a cheaper model and lists the other cheaper tiers. It also
names up to five subagents that pin a cheaper model, by id and model. Their
descriptions (first sentence, at most 80 characters) appear only when no tier
is cheaper.

```jsonc
"guard": {
  "expensive": "auto",
  "allowInherit": ["fork"],
  "allowModels": []
}
```

- `guard`: off when absent. `true` turns it on with the defaults.
- `expensive`: `"auto"` (default) counts only **premium** models as expensive:
  priced at or above the `premium` option (default $8 per million input tokens,
  such as Claude Fable and GPT-6 Astra). Strong models such as Opus are not
  guarded. A subscription model is priced by its models.dev list price. It can
  also be a list such as `["amazon-bedrock/global.anthropic.claude-opus-5-5"]`,
  which replaces the premium rule. An entry with a `#variant` matches only that
  variant.
- `allowInherit`: agent ids that may inherit the session model.
- `allowModels`: expensive models a spawn may name in its own `model`
  argument. Same format as `expensive`.
- `mode`: `"refuse"` (default) refuses the spawn. `"auto"` asks the
  [auto decider](#auto-routing) for a tier instead, offering only tiers whose
  model is not expensive, and refuses only when none resolves. It uses the
  `auto` settings, or their defaults when `auto` is absent.

A spawn is allowed if it passes a `tier` that resolves, or if the target agent
has a model, or a tier that resolves (through the `agents` option, the header,
the built-in defaults or its classification).

Models often set the `subagent` tool's `model` argument even though its
description says not to. So a spawn that names an expensive `model` itself
(not one filled in from `tier`) is refused too, unless the target agent pins
that model or `allowModels` lists it. The refusal asks for the cheapest tier
instead, and names the tier that resolves to the requested model, if there is
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
   `Retry-After` count, or a span such as `resets in 3h 20m`), else for `quotaCooldownMs`. Tiers are resolved again,
   so agents on that tier move to the next candidate. When a cooldown ends,
   the tiers are resolved again.
4. The request moves to the next healthy candidate of the session's tier: the
   `tier` the session was spawned with, else its agent's tier, else the first
   tier that lists the failed model. The plugin calls `session.switchModel`
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

- A **root session** gets a note naming the failed model and what its tier
  resolves to now. The plugin doesn't switch or wake it: switching an idle
  session could change a turn the user starts later.
- A **subagent session**, or a failed `subagent` call, leaves the note in the
  parent. The note names the failed model and the next one, and says the
  spawn may be retried. The child's failure event and the tool error produce
  one note between them. For a child spawned with `tier`, the plugin also
  switches the child to the tier's next model, and the note says to spawn
  again with the same `tier` or resume the child by `sessionID`.

Every fallback is logged (`console.warn`). The model is the one the error
names (`Model unavailable: provider/model`), else the session's model, found
the same way as for the guard. Notes leave out the host's `#default` variant.


## Choosing a tier per spawn

The plugin adds an optional `tier` parameter to OpenCode's built-in `subagent`
tool, so the spawner picks the model tier for each call. It is an enum of the
built-in tiers and your custom ones. Each is described with its purpose and the
cost class of its first available candidate (`metered, $2/M input tokens`,
`subscription, list price $4/M input tokens`, or `free`):

- `cheap`: cheap and fast work, such as lookups, summaries, log and diff
  reading, and mechanical edits.
- `standard`: everyday implementation and investigation.
- `strong`: hard reasoning, such as design, root-cause debugging, and subtle
  concurrency or data-integrity work.
- `reviewer`: an independent second opinion or review, from another model
  vendor than the caller's when one is available.

The descriptions are refreshed when model availability changes. The old `role`
parameter is still accepted (free-form, so it also takes the
[old role names](#old-role-names)); `tier` wins when both are set.

Before the tool runs, the plugin resolves the tier the same way as for agents,
skipping unhealthy models, then sets the call's `model` to the result and
removes `tier` and `role`. For a tier with `distinctVendor` it first looks up
the calling session's model and moves candidates from another vendor to the
front; an agent whose own tier has `distinctVendor` is moved the same way on
each spawn. The model is chosen in this order:

1. an explicit `model` in the call
2. the `tier` (or `role`) in the call
3. the target agent's tier (from the `agents` option, the header, the built-in
   defaults or its classification)
4. the target agent's own model
5. the session's model, which the child inherits

The plugin never overrides an explicit `model` or a resumed spawn. An unknown
tier refuses the spawn and lists the tiers. `default` passes no tier. A tier with
nothing available falls through to step 3. A resumed spawn (with `sessionID`)
keeps its model. The plugin records the tier each child was spawned with (in
plugin storage, under `spawn-role:<sessionID>`), so a fallback for that child
stays in the same tier.

## Auto routing

Experimental, and off unless you set `auto`. When a fresh `general` spawn names
no `model` and no `tier`, a small model picks a tier for it through
`ctx.generate.text`. Other agents get a tier [once, from their
description](#agents-that-declare-no-tier) instead. With `auto` on, a tier whose
`effort` is `"auto"` also gets its variant from the decider on each spawn.

```jsonc
"auto": {
  "decider": "@tiny",
  "roles": ["cheap", "standard"],
  "default": "standard",
  "timeoutMs": 5000,
  "capAtParent": true
}
```

- `auto`: `true` turns it on with the defaults.
- `decider`: the tier (`@tiny`, which is `cheap` at effort `none`, the default) or
  `provider/model#variant` the decider runs on. A tier resolves like any other,
  skipping unhealthy models.
- `roles`: the tiers the decider may pick (default `cheap` and `standard`).
  Unknown names are dropped. With none left, auto routing is off.
- `default`: the tier a spawn gets when the decider isn't confident, replies
  with something other than the JSON it was asked for, fails, takes longer
  than `timeoutMs` (default 5000), or has no model. Defaults to `standard` when
  allowed, else the first allowed tier.
- `capAtParent`: when on (default), a tier whose model sits higher in its
  derived lineup (cheap, standard, strong; premium counts as strong) than the
  calling session's model steps down to the highest allowed tier at or under it.

The decider sees the agent id and description, the spawn's description, the
first 6000 characters of its prompt, and each allowed tier's purpose and cost
class. It answers `{"role": …, "confident": true|false}`; a code fence around
it is fine. The chosen tier then applies as if the spawner had passed it, so
fallback stays in that tier. The spawn description gets a tag such as
`[auto: cheap, confident]` (or `unsure`, `invalid`, `timeout`, `error`,
`no-decider`, `capped from strong`), which becomes the child session's title.
`model_roles_check` lists the last 20 decisions of this server.

Auto routing never overrides an explicit `model` or `tier`, a resumed spawn,
or an agent's own model or tier, and it never touches a root session. The
spawn waits for the decider: about 1.5 s with Claude Haiku 4.5 on Bedrock
(p50 1.5 s, p95 1.8 s over 30 calls). The host ignores abort signals on
`ctx.generate.text`, so a decider past `timeoutMs` keeps running in the
background and its answer is dropped. A classification gets at least 30 s,
since it runs in the background.

## Check

`model_roles_check` is a read-only tool. It shows each tier with where its
candidates come from (`config`, `roles`, `derived`, or borrowed from `strong` or
`standard`), its effort and whether it puts another vendor first, then checks
every candidate against `ctx.model.list()` across all providers, enabled or not,
and reports one of: available, unknown id, unknown variant (listing the ones that
exist), provider unavailable, unhealthy until a time, or a link to another tier.
It also shows old role names with lists of their own, the model each tiered agent
ends up on, the values the `subagent` tool's `tier` parameter offers with their
purpose and cost class, warnings (a custom tier with no purpose, a tier with no
candidates), the derived lineups, every model the derivation dropped grouped by
reason, and the recent [auto routing](#auto-routing) decisions.

The same check is exported for scripts: `checkRoles(options, models, agents,
health?, now?, purposes?, derived?)` returns the report, and `formatCheck(report)`
turns it into text. Build the options as
`{ ...parseOptions(yourOptions), ...buildTiers(parseTierSettings(yourOptions), models, buildReferenceIndex(referenceModels)) }`,
where `models` is the `data` of a `model.list` call.
