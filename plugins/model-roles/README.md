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
writes them for you. The `/tiers` command (see [Editing tiers in the TUI](#editing-tiers-in-the-tui))
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
    `auto` is on. When `auto` is off, or the decider fails, times out or gives no
    valid effort, the spawn runs at the effort the tier would have without
    `"auto"`. Defaults: `cheap` low, `standard` medium, `strong` and `reviewer`
    high. A custom tier takes its base tier's effort (`standard`'s, configured or
    built in) unless it sets its own. See [Precedence](#precedence).
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
  It does not override a [model pin](#model-pins-win-over-tiers).
  Without it, `explore` and `compaction` get `cheap`, `title` and `summary` get
  `cheap` at effort `none`, and `general` gets `standard` (unless `auto` is on).
- `fallback`: only `"keep"` is supported. If nothing matches, the agent keeps
  its own model, or inherits one if it has none.
- `runtimeFallback`: `true` by default. Set `false` to turn off the retry hook,
  health marking and cooldowns, failure and provider-outage notices, and
  context-overflow model switching. The host then does its own retry. Tier
  routing, the `tier` parameter, resume handling, the guard and `auto` keep
  working. See [Runtime fallback](#runtime-fallback).
- `cooldownMs`: how long a failed model first sits out (default `60000`, 1 min).
  Each cooldown in a row doubles it. See [Runtime fallback](#runtime-fallback).
- `maxCooldownMs`: the longest cooldown (default `600000`, 10 min).
- `flapCount` and `flapWindowMs`: a model sits out once it has failed in
  `flapCount` separate episodes within `flapWindowMs` (defaults `3` and
  `600000`, 10 min). Set `flapCount: 1` to sit it out on its first failure.
- `quotaCooldownMs`: how long a spent quota sits out when the provider names
  no reset time (default `21600000`, 6 h).
- `hostRetries`: how many retries a transient failure gets on the same model
  before the plugin switches the request (default `2`).
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

## Editing tiers in the TUI

The package also has a TUI entry (`./tui`), loaded from the same install. `/tiers`
(slash command, or **Model tiers** in the command palette) lists the tiers with
what they resolve to now, for the current session's location. Pick a tier to open
its menu, **Agents…** to see every agent and change its tier, or **Add a tier…**
(name, then purpose, then the same menu).

Your changes live in a draft until you save. **Esc** goes back one level and keeps
the draft. The tier menu has:

- **Models**: one list of every available model. Selected models come first,
  numbered in fallback order (`☑ 2. provider/model#high`); the rest are `☐`.
  **Enter** selects or deselects the highlighted model and keeps the highlight on it.
  Keys act on the highlighted model without closing the list:
  - `ctrl+e`: set its variant, or **Inherit tier effort** to drop the `#variant`.
  - `alt+up` / `alt+down`: move it earlier or later in the fallback order.
  - `ctrl+s`: save the tier.
- **Effort**: the tier's level, `auto`, or **Tier default** (removes the setting).
  A model with its own `#variant` ignores it.
- **Purpose**: the text the spawner sees.
- **Preview**: what the tier resolves to with the draft, from the server.
- **Reset to auto**: a built-in tier loses its settings; a custom tier keeps only
  its purpose.
- **Save** writes the tier, applies it, shows a toast and returns to the tier list,
  so the next edit starts from the saved state. A validation error keeps the draft
  and returns to the menu.
- **Cancel**, or **Esc** at the menu with unsaved changes, asks before discarding.

Before it writes, `/tiers` checks every model you picked against what the
providers list:

- A model no provider knows, or a `#variant` the model does not have, is refused
  with an error, and nothing is written.
- A known model that is not available now (its provider is not connected, or the
  model is disabled) is saved with a warning.

A save goes to `options.tiers` of the model-roles entry in the global config:
`$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode`. The file is `opencode.jsonc` when it has the entry, else
`opencode.json`. The edit keeps comments and formatting, and turns a bare string
plugin entry into `{ "package": …, "options": … }`. The write is atomic: the new
text goes to a temp file in the same directory, is synced, then renamed over the
config, which keeps its file mode, owner and group, so a crash never leaves a
half-written config. A config owned by another user is refused rather than
re-owned. Before the rename the old content is copied to `<config>.model-roles.bak`,
and the directory is synced after it. There is
one backup per file, overwritten on each save, so it holds the config as it was
before the last save.

### Agents

**Agents…** lists every agent the host reports, primary agents and subagents,
sorted. A row is the agent id and its tier (or `no tier`, with `· own model` when
the agent pins a model). **Enter** opens the agent's details, one row per fact:

- **Tier**: the tier, or `no tier (session model)`.
- **From**: `your setting` (`options.agents`), `agent default` (the agent's
  request header), `auto-classified`, or `none`.
- **Resolves to**: `provider/model#variant` the tier gives now.
- **Own model**: the model the agent pins, which wins over its tier.
- **About**: the agent's description, if the host gives one.

**Change tier…** opens every tier with its summary, plus **Agent default**, which
removes `options.agents.<agent>` so the header or classification applies again.
The current choice is marked. A choice saves at once, the same way a tier save
does: it writes the global config, refuses an unknown tier or agent without
writing, applies live, and returns to the refreshed details. **Esc** or **Back**
returns to the Agents list on the same row. **Esc** in the picker changes nothing.
The `setAgent` call (`{ agent, tier }`, `tier` null to remove) does the write.

A model-roles entry in a project config (`opencode.json(c)` or `.opencode/opencode.json(c)`
in the session's directory or an ancestor) replaces the global entry as a whole, so
its `tiers` and `agents` are the ones in force. In the tier list, the tiers then say
`overridden by the project config`, and **Save** in a tier asks first: a save goes to
the global config and will not change this project's tiers; if you continue, the
toast says nothing changed here. A global save or hand edit never replaces a
project entry's tiers in the running plugin. On the Agents screen the details then say `Set by project config (<path>)`,
and **Change tier…** warns the same way. Edits to the
project file apply on the next config reload, also when the global file has no entry.
OpenCode keys plugin entries by the exact package string: only a project entry with
the same string as the global one shadows it. One with another string runs as a second
instance, and the Agents list notes it. A save needs the host to name exactly one
loaded model-roles entry that matches a config entry; with two loaded, or no answer,
`/tiers` refuses before writing and reloads keep the agents from startup.

### Live config

The running plugin applies a save straight away. It reads the global file again,
rebuilds the tiers, and moves the agents that are now on another model. On the
host's `config.updated` event it does the same when the file's tiers changed, so
a hand edit applies too, to the tiers and to `options.agents`. A spawn that starts during a reload waits for it, so its
model and receipt both come from the new tiers. If moving the agents or the tool
fails, the previous tiers stay in use, the save reports that it was written but
not applied, and the next config reload tries again. The `tier`
parameter's text and enum change only for sessions started after the edit, so
running sessions keep their prompt cache.

A config with no model-roles entry in the global files (for example, only in a
project config) is not edited; `/tiers` says so. While that file has an entry,
its tiers replace the ones the plugin got at startup each time they change.

The dialog's `state` call takes an optional `draft`: tier name to a tier config,
or `null` for a tier removed. The reply resolves the saved tiers with those edits
on top, without saving them, so the dialog can show an edit before you keep it.
The reply also has:

- each candidate's status: available, unhealthy, unknown id or variant, or
  provider unavailable;
- every tiered agent with its tier and where the tier comes from (`options`,
  `header`, or `implicit` for a built-in default or a classification);
- what each agent resolves to, and its own model when that model pins it.

The server side is the RPC `model-roles` (`state`, `set`), which scripts can call
through `POST /api/rpc/model-roles/{state|set}` with `{ "input": … }`; `set` takes
`{ "tier": "<name>", "value": <tier config> | null }`.

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
request reaches a provider. Without the plugin, the agent inherits the session
model.

```md
---
description: Reviews changes
mode: subagent
request:
  headers:
    x-opencode-model-role: reviewer
---
```

Don't use a frontmatter `role:` key. OpenCode either drops it, or reads the
file as V1 and drops a `#variant` model.

If both are set, the `agents` option wins over the header.

### Model pins win over tiers

A model you set on an agent is a pin: `agents.<id>.model` in `opencode.json`, or
`model:` in a markdown agent file. The plugin leaves a pinned agent on that model,
whatever tier its header, the `agents` option, the built-in defaults or a
classification give it, and drops a `tier` passed when spawning it. Only an
explicit `model` in the spawn call wins over a pin. `model_roles_check` lists a
pinned agent as `pinned in config; tier not applied`.

A plugin that gives a shipped agent a fallback model (delivery does, when
model-roles is not detected) marks it in the `x-opencode-model-fallback` request
header with the same `provider/model#variant`. That model gives way to the tier.
A config pin replaces the model but not the header, so it no longer matches and
counts as a pin. This plugin marks the models it sets the same way, and removes
the header before any request reaches a provider.

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
transform, which puts it last again; it still leaves pinned agents alone. It does this only when an agent's model is
out of date or availability has changed. It gives up after three attempts in a
row that don't converge, logs which agents are still off their tier's model, and
`model_roles_check` lists them under its warnings.

## Precedence

For each spawn, the first rule that applies decides the model and its variant:

1. **Explicit model.** A `model` on the spawn wins over any `tier`. A regional
   Bedrock id (`amazon-bedrock/eu.…`, `us.`, `jp.`, `au.`, `in.`, `apac.`) runs as
   its `global.` profile when the catalog lists one, keeping any `#variant`. The
   account's Bedrock profiles are global. Other ids run as given.
2. **Agent's own model.** A model pinned on the agent (`agents.<id>.model` in
   config, or `model:` in an agent file) wins over the tier the agent declares and
   over a `tier` the spawn passes. See [Model pins win over tiers](#model-pins-win-over-tiers).
3. **Candidate variant.** A candidate written as `provider/model#variant` keeps
   that variant, even when the tier's effort says otherwise. This holds within
   the tier that lists it: a tier that borrows those candidates (`reviewer` from
   `strong`, a custom tier from `standard`) sets them to its own effort.
4. **Tier effort.** The tier's own `effort`, mapped to the nearest variant.
5. **Built-in default.** `cheap` low, `standard` medium, `strong` and `reviewer`
   high.
6. **Base tier effort.** A custom tier with no effort of its own takes
   `standard`'s, as configured, else as built in.
7. **Model default.** A model with no variants, or none near the effort, runs
   without one.

A resume keeps its child's model, unless the [guard](#subagent-model-guard) refuses it now: the child then moves to its tier's first allowed candidate.

`effort: "auto"` sits at rule 4: the [decider](#auto-routing) picks the variant per
spawn, for a spawn that passes the tier, an agent that declares it, and an
auto-routed spawn. When the decider cannot pick, the spawn falls back to rule 5,
else 6, else 7. A candidate variant the tier itself lists (rule 3) still wins
over `auto`; a variant that comes through an `@tier` link does not.

The tier itself comes from the first of these that names one:

1. the spawn's `tier`, or the old `role`;
2. the agent's tier: the `agents` option, its header, or a built-in default or
   classification;
3. [auto routing](#auto-routing), for `general`.

### Spawn receipts

Each spawn the plugin routes leaves a receipt with:

- the tier it asked for and where it came from (`tier` or `role` parameter, the
  agent's tier, or auto routing), with the old role name if one was used;
- the `provider/model#variant` it runs on;
- the precedence rule that won;
- the candidates it fell back past, with the reason (provider unavailable, unknown
  id or variant, unhealthy);
- warnings for settings that were dropped. That covers a spawn model or agent pin
  over a tier, a candidate variant over the tier effort, a model with no variant
  near the effort, and `auto` falling back.

The last 50 receipts are kept in plugin storage. `model_roles_check` lists them
newest first, one line each. Every warning also goes to the OpenCode log
(`opencode.log`).

## Outcome ledger

The plugin keeps one record per child session in plugin storage, under
`outcome:<sessionID>`: the agent, tier, model, routing source and rule, parent
session, how often the child was resumed, summed tokens (input, output, reasoning,
cache read and write), cost, step count, elapsed time, how the run ended
(`succeeded`, `failed:<class>` or `interrupted`) and whether a failover moved it.
It stores no prompt, description, result or command text. Nothing decides from the
ledger; it is the evidence for later evaluation-based routing, and a read-only
usage report (below) summarises it.

Three outcome signals come from the child's own session, as enums and a boolean
only; the text and commands they are read from are parsed in memory and dropped:

- `verdict` (`approve`, `request-changes` or `comment`): the last
  `VERDICT: …` line of the child's final text, outside fenced code, indented code
  (four spaces or a tab) and `>` quotes; unset when there is none.
- `tests` (`pass`, `fail` or `none`): the last shell call that ran a test command and
  reported an exit status. `none` when the child ran none. A shell call reports one
  exit status for the whole invocation, so it counts only when that status is the
  test command's own: the test command is the last command, anything before it is
  setup (`cd <path>`, `NAME=value`, `export NAME=value`) joined by `&&` (or `;`), and
  only a redirect such as `2>&1` or `> file` follows it. After `&&` setup the test runs
  only if the setup succeeded, so a non-zero exit may be the setup's: that call leaves
  `tests` unset (a zero exit still counts as `pass`). After `;` or a newline the test
  always runs, so its exit counts. The test command is matched word by word, so a
  quoted `'bun test'` is one word and not a test run. `bun test; echo ok`,
  `bun test && false`, `bun test | tail`, a subshell, a substitution, a here-document,
  `eval`, `sh -c` and unbalanced quotes are ambiguous: that call is ignored, and it
  neither sets nor clears an earlier result. A command counts after env assignments
  and `bun run`/`npm run` wrappers. Quoted text is data, not a command boundary
  (the plugin reuses the repository's shell tokenizer). A result without an exit
  status in its metadata (`exit` or `exitCode`) is not counted either; the host's
  types do not promise one, so such a run leaves `tests` at `none`.
- `touchedTests` (boolean): any step's edited files (`session.step.ended.files`)
  matched a test glob.

Options, under `evaluate`; an array replaces its default:

- `testCommands`: default `bun test`, `bun run test`, `bun run check`, `npm test`,
  `pnpm test`, `yarn test`, `pytest`, `python -m pytest`, `go test`, `cargo test`,
  `cargo nextest`.
- `testGlobs`: default `**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/tests/**`,
  `**/__tests__/**`, `**/*_test.go`, `**/test_*.py`.
- `agents`, `explore`, `maxArms`, `minN`, `margin`, `costTolerance`: see [Exploration](#exploration-opt-in).

This first phase records only tier-routed spawns: those that reach a session
through a tier, role or `auto` decision, which the plugin links to the child
session it created. Not recorded: spawns without a tier (the agent keeps its own
model), spawns whose explicit `model` or agent pin wins, resumed children with
no earlier record, and the parent session itself. Records older than 90 days go,
and only the newest 1000 stay.

### Usage report

`model_roles_check` ends with a "Usage per tier" section, and `/tiers` has a
"Usage…" entry (Enter on a tier lists its agents; Esc goes back; its only action is
[Adopt recommendation](#assessment)). Both
come from one pure summary over the ledger, covering the whole 90-day retention.
Per tier, and per agent within it (the check shows the top 3 agents), it gives:

- `n`: runs that ended, with the succeeded, failed and interrupted counts and the
  success rate (succeeded ÷ n). A record still running is not counted.
- Elapsed time: mean, p50 and p90 (nearest rank), from the first spawn to the last end.
- Tokens: totals and per-run means for input, output, reasoning, cache read and
  cache write, over the runs that reported tokens. Cache share is
  read ÷ (input + read).
- Cost: the sum as the host reported it, and cost per success: the cost of the
  runs with a known cost ÷ the successes among them; n/a without either.
- Coverage: when only some runs of a group reported cost or tokens, the line says
  how many, for example `cost 12/20`. Totals and means cover those runs only.
- Fallback rate: the share of runs a failover moved to another model, and the
  resume count.

A usage field (tokens, cost) is stored only once the host reported it for a step;
until then it is absent, and the report shows n/a, never 0. A reported 0 is 0.
Records carry a schema version `v` (currently 2). Records without it are legacy:
they stored 0 for usage the host never reported, so a legacy 0 is ambiguous and the
report reads it as unknown. A resumed child counts as running from the start of its
new run: it leaves the outcome counts until that run ends. Spawns without a tier
appear under `(none)`.

The ledger is advisory telemetry: nothing decides anything from it. Writes to one
record land in order, and the plugin assumes plugin storage calls settle. At shutdown
it waits up to 10 seconds for pending writes and logs what stays unwritten. A write
still in flight after that can finish after a reload and overwrite the new instance's
write for the same record. That is accepted.

## Exploration (opt-in)

Exploration collects ledger evidence for alternatives inside a tier. It never writes
config; the [assessment](#assessment) reads the evidence and recommends, and only you adopt.
It is off by default, and off it changes no routing, receipt or record.

Options, under `evaluate`:

- `agents`: agent ids that may explore (default `[]`). Exploration is on only when
  this is non-empty and `explore` is above 0.
- `explore`: ε, the share of eligible spawns that leave the control (default `0.05`,
  clamped to 0 through 0.1).
- `maxArms`: most alternatives to the control (default `3`, clamped to 1 through 6).
  A small set keeps each arm's share of ε high enough to gather evidence.
- `minN` (30), `margin` (0.05), `costTolerance` (0): read by the [assessment](#assessment); exploration does not read them.

A bad value logs a warning and falls back to its default (or the clamp).

An eligible spawn draws once: the control (the model and effort the tier resolved) with
probability 1 − ε, otherwise one alternative uniformly. The alternatives, in order, capped at `maxArms`:

1. the control model one effort step up, when the model has that variant;
2. the control model one effort step down, when it has one;
3. the tier's next candidate at its configured (or default) variant;
4. further candidates, when `maxArms` is above 3.

Steps follow the effort scale `none < minimal < low < medium < high < xhigh < max`, among
the variants the model has. A control without a variant on that scale has no up or down.
Filters apply after the cap: a filtered alternative leaves its slot empty, a later one does not replace it.
An alternative must be available, out of cooldown (the health view the tier resolution uses, so a quota-exhausted
or cooled-down model or provider is never an arm) and allowed by the guard.

Not eligible: a spawn with an explicit `model`, an agent with its own model, a resume,
a tier or agent with effort `auto`, an agent outside `evaluate.agents`, a spawn with only
one arm, and reviewers, whose verdicts are the rewards. A reviewer is a tier with
`distinctVendor`, or an agent named `*-reviewer` or `adversarial-challenger`.
Exploration covers every spawn that runs on a tier: one with a `tier` parameter, and one
with none whose agent has its own tier (an `x-opencode-model-role` header or an `agents`
mapping). The second kind gets a ledger record only while exploration is on and the spawn is
eligible; with exploration off nothing changes.

The guard comes first. An arm is a model the plugin picks, so the agent's own tier model
does not exempt it: an expensive model, an effort variant included, is never an arm unless
`guard.allowModels` lists it. The offered set is final before the draw, so `p` is always
the probability under the arms actually offered.

The ledger record of an eligible spawn gets `policy` (`explore-v1`), `eligible` (the arm
labels, control first), `arm` and `p`, the probability of the arm drawn from the offered set. A control
draw is logged too; without it the propensities cannot be corrected for. The model
snapshot keeps the same facts, so a resume stays on the arm and does not redraw. The
receipt keeps its rule and adds `exploring arm <model#variant>` when the arm is not the
control. `model_roles_check` shows `exploration: on for <agents>, ε=<x>`, and the usage
report adds a row per arm under a tier that has any. A child that a failover, a context-overflow switch or a resume reroute (an explicit `model` or `tier`, or a guard switch) moved to another model left its arm: it keeps its `arm` facts and `failedOver`, but the arm rows do not count it (the ledger marks a reroute `leftArm`).

### Assessment

The assessment reads the explored runs of each tier and agent and says `keep`,
`recommend <arm>` or `rollback to <arm>`. Only you change the config, through `/tiers`.
It runs only for the agents that explore now: with exploration off, or for an agent no
longer in `evaluate.agents`, past runs give no assessment and no adopt action.

- Reward per run:
  - 0 for a failure, an interruption or a failing last test run.
  - 1 when the tests passed and the run edited no test file.
  - Otherwise the first reviewer from another vendor after the run decides. REQUEST-CHANGES
    is 0. APPROVE, or a review that succeeded without a change request, is 1.
  - A reviewer counts for the latest run of the same parent session that ended before the
    review started. A review that ended at the hold timeout, or that a failover or reroute
    moved off its model, gives no reward.
  - The rates leave out runs with no signal, and the line counts them. They skip runs that
    left their arm or ended at the hold timeout.
- Rate per arm: each run weighs 1/p, normalized over the arm (inverse-propensity weights).
  A run drawn under a smaller ε counts for more. The interval uses the effective sample
  size (Σw)²/Σw².
- `recommend` needs all three of these:
  - at least `minN` scored runs on the arm and on the control, and an effective sample
    size of at least `minN` on each, so a few heavy weights cannot stand in for many runs;
  - a Newcombe 95% lower bound (Wilson-score hybrid) of arm rate − control rate above `margin`;
  - a cost per success at most the control's × (1 + `costTolerance`). An unknown cost fails.
- `rollback` applies when the tier's latest `/tiers` adoption made the current control, and
  the control it replaced now passes the same test against it. Without such an adoption the
  previous control is an ordinary arm.
- Otherwise `keep`, with the reason: too few runs (`keep (n=12/30)`), a lower bound not
  above the margin, or cost.

`model_roles_check` ends with an "Assessment" section, one line per tier and agent, for
example `standard/coder assessment: recommend p/m#high: +8.1 pts (95% LB +5.3),
cost/success $0.120 vs $0.140`. In `/tiers`, the "Usage…" view of a tier lists the same
lines. A recommendation or rollback shows as "Adopt recommendation (<agent>)".

To adopt one, press Enter on that row. The dialog shows the tier config before and after.
When you confirm, it saves through the same path as a tier edit:

- A model list puts the arm first and pins its variant.
- A derived tier takes an effort arm as its effort.
- A tier from the old `roles` option keeps its candidates' explicit variants over a tier
  effort. For an effort arm, its list becomes the arm followed by the other candidates.
- On a tier with no list, another model gives a list of the arm followed by the current
  candidates.

The change applies to every agent on the tier. The plugin records each adoption in plugin
storage (the newest 50) for the rollback rule. Before it writes, the server checks that its
own assessment recommends that arm over that control now, and refuses the save otherwise.
An adoption applies only to the control it was assessed against. When the tier resolves to
another model or variant now (after a reset to `auto` or an edit), the row says the tier
changed since the assessment and offers no adopt, and the server refuses one.

### Announcements

While exploration is on, the server re-assesses the explored agents after scored outcomes end,
at most once per 60 seconds. A recommendation or rollback it has not announced yet (or whose
verdict or arm changed) is stored as a finding (the newest 50 are kept); a keep clears it.
The TUI shows one toast per new finding, once per TUI instance, and a `tiers: N new` badge in
the prompt footer's status row while unseen findings remain. A finding whose tier changed since
the assessment is not announced and leaves the badge. Opening a tier's usage view in `/tiers`
marks its findings seen, as does "Dismiss announcement (<agent>)" or adopting. Nothing is sent
through the agent or the desktop. The `findings` and `seen` RPC methods carry this.

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
- `requireExplicit`: `false` by default. When `true`, the guard refuses any
  spawn whose child would inherit the session model, at any price and also
  when the session model is unknown. A spawn passes if it sets `tier` or
  `model`, if the target agent pins its own model, if the target has a tier
  (the `agents` option, header or built-in defaults), if it resumes a child
  with `sessionID`, or if `allowInherit` lists the agent. The refusal lists
  each tier with the model it resolves to. If a session or agent lookup throws,
  or the target is missing from the agent list, the guard refuses the spawn too
  (with the option off it lets it through).
- `lookupTimeoutMs`: how long the guard waits for each lookup that comes before a
  spawn is decided: the agent and session lookups, the caller-vendor lookup and
  the routing lookups (default 5000). The bound applies even when no `guard`
  option is set. A lookup that does not settle in time counts as a failure: it
  refuses the spawn with `requireExplicit` on and lets it proceed otherwise (also
  with no guard at all). Each timeout logs a warning that names the lookup (agent,
  caller-vendor, routing or parent-session cap) and the bound.

  With `requireExplicit` on, an approved spawn also carries
  the verified model (the agent's pin or its tier's model) in its input, and a
  spawn with no concrete model is refused instead of inheriting.
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
lookup fails, the spawn goes ahead. A resume (`sessionID`) is judged on the model its child runs on:
if the guard refuses it now, the child is switched to the first candidate of its tier the guard accepts
(the receipt warns), or the resume is refused when none passes. A `model` on a resume is judged like a spawn's.

## Runtime fallback

OpenCode doesn't fall back to another model on its own: its retries stay on
the same model. The plugin adds the fallback in the host's `retry` hook, which
runs before every retry of a failed model request, in root and child sessions
alike:

1. It checks whether the model or provider caused the error, and how:

   | Kind | Examples | Counts against | Budget |
   | --- | --- | --- | --- |
   | `rate-limit` | 429, throttling | the model | transient |
   | `server` | 5xx, overloaded | the model | transient |
   | `outage` | connection refused, DNS, fetch failed | the provider | transient |
   | `credentials` | credentials did not load locally, such as `AWS default credential chain failed` or a failing `credential_process` helper | the provider | transient |
   | `auth` | 401/403, bad or expired credentials or SSO | the provider | permanent |
   | `quota` | 402, spent quota, billing, weekly or daily usage limit, subscription session or usage limits (`claude_session_limit`, `usage_limit_reached`, `subscription_sharing_usage_limit_exceeded`) | the provider | permanent |
   | `unavailable` | unknown or retired model, Bedrock's `The provided model identifier is invalid` | the model | permanent |
   | `content-filter` | blocked by a content or safety filter | the model | permanent |
   | `context-length` | `prompt is too long` (Anthropic), `maximum context length` / `context_length_exceeded` (OpenAI), `Input is too long for requested model` (Bedrock), 400 or 413 bodies saying so | the request, not the model | see below |

   User interrupts and tool errors don't count, and the host's own decision
   stands.

   A `context-length` failure is about one request, so it never starts a
   cooldown or adds a strike. The host handles an overflow itself, outside the
   `retry` hook. With automatic compaction on, it compacts the session once.
   It fails the step when compaction is off or doesn't shrink the request
   enough. The plugin switches a model only on that failure's
   `session.execution.failed` event, which belongs to the execution that
   failed, and re-runs nothing:
   - A child moves, with `session.switchModel`, to the first healthy
     candidate of its tier with a larger context window. Resuming it
     continues there. Windows come from the catalog's `limit.context`.
     Unknown or equal windows don't count as larger. The receipt records the
     fallback reason `context-length`.
   - A root session keeps its model. Its note names the larger candidate.
   - With no larger candidate, the note says: "context too long for
     `<model>` (`<limit>` tokens); no larger-context candidate in tier
     `<tier>`. Compact the session or use a tier with a larger-context model".
   - A child on a model the user chose, through a spawn's `model` or an agent
     pin, is never switched. Its note says the model was chosen explicitly.

   The parent gets one note for each overflowing execution of a child. The
   parent's failed `subagent` call never switches a model. It posts the note
   only when the child's failure event has not.
2. A transient failure stays on the same model for the first `hostRetries`
   retries. A permanent one switches on the first retry. When the host would
   not retry a transient failure itself (it doesn't retry credentials that
   failed to load), the plugin retries it after 2 s, then 4 s, doubling.
3. The failure is recorded against the model, or its whole provider, in
   plugin storage under `health`. A model's variants share its health. One
   failure doesn't take a model out of use: it sits out new resolutions only
   once it has failed in `flapCount` separate episodes within `flapWindowMs`.
   Failures within 10 s of the first one in an episode count as that episode,
   so parallel requests that hit the same blip count once. A model that keeps
   failing for 20 s or more, or that fails again and again, sits out. The first
   cooldown is `cooldownMs`. Once it ends, the next failure within
   `flapWindowMs` puts the model out again at once, for twice as long, up to
   `maxCooldownMs`. After a quiet `flapWindowMs`, the model starts from zero.
   Two kinds sit out on their first failure. A spent quota sits out until the
   reset time the error reports (an ISO time, a unix `reset` stamp, a
   `resets_in_seconds` or `Retry-After` count, or a span such as `resets in
   3h 20m`), else for `quotaCooldownMs`. A model the provider doesn't serve
   sits out for `maxCooldownMs`. When a model starts or ends a cooldown, the
   tiers are resolved again, so agents on that tier move to the next
   candidate and back.
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
6. A model that is cooling down, that the request already failed on, or that
   failed (or whose provider failed) in the last minute, is never a target,
   so two failing models can't take turns. When no healthy candidate is left,
   or a switch is still landing, a transient failure keeps retrying on its
   model, with the delay doubling up to 30 s, for up to 5 retries (about a
   minute). Otherwise the host's own decision stands.

Without the plugin's switch, the host retries a transient error on the same
model about ten times over roughly 80 seconds (seen with a provider that keeps
answering 503) before `session.execution.failed` fires. With a healthy
candidate left, the switch happens after `hostRetries` retries.

Some failures never reach the `retry` hook, such as a spawn whose model is
unavailable. And sometimes nothing healthy is left. For those, on
`session.execution.failed` or a failed `subagent` call, the plugin records the
failure as above and leaves a note that does not start a turn
(`session.synthetic`, steer):

- A **root session** gets a note when the failure took its model out of use,
  naming the failed model and what its tier resolves to now. The plugin
  doesn't switch or wake it: switching an idle session could change a turn
  the user starts later.
- A **subagent session**, or a failed `subagent` call, leaves the note in the
  parent. The child's failure event and the tool error produce one note
  between them. While the model stays in use, the note says to resume the
  child by `sessionID` or spawn it again. Once the model sits out, the note
  names the next model and says the spawn may be retried. For a child
  spawned with `tier`, the plugin then also switches the child to the tier's
  next model, and the note says to spawn again with the same `tier` or
  resume the child by `sessionID`.

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

The descriptions follow model availability and the tier config, never model
health, and each session keeps the `tier` and `role` parameters it saw on its
first request for its whole life (stored, so a server restart keeps them too).
Tools come first in the provider's prompt-cache prefix, so a running session's
cache is never rebuilt by a new model or a `/tiers` edit: those reach new
sessions only. Unhealthy models are skipped when a spawn resolves its tier,
not in the tool text. The old `role`
parameter is still accepted (free-form, so it also takes the
[old role names](#old-role-names)); `tier` wins when both are set.

Before the tool runs, the plugin resolves the tier the same way as for agents,
skipping unhealthy models, then sets the call's `model` to the result and
removes `tier` and `role`. For a tier with `distinctVendor` it first looks up
the calling session's model and moves candidates from another vendor to the
front; an agent whose own tier has `distinctVendor` is moved the same way on
each spawn. The model is chosen in this order:

1. an explicit `model` in the call
2. the target agent's [model pin](#model-pins-win-over-tiers); a `tier` in the
   call is dropped
3. the `tier` (or `role`) in the call
4. the target agent's tier (from the `agents` option, the header, the built-in
   defaults or its classification)
5. the target agent's fallback model (marked in `x-opencode-model-fallback`)
6. the session's model, which the child inherits

The plugin never overrides an explicit `model`. An unknown
tier refuses the spawn and lists the tiers. `default` passes no tier. A tier with
nothing available falls through to step 4. The plugin records the tier each child was spawned with (in
plugin storage, under `spawn-role:<sessionID>`), so a fallback for that child
stays in the same tier.

### A child keeps its model

When a spawn resolves, the plugin stores the child's `model#variant`, tier and a
hash of the tier config (`configRevision`) under `spawn-model:<sessionID>`. A resume
(`sessionID`) reuses that model and effort, even after a `/tiers` save or a reload.
The receipt shows rule "the child's snapshot" with the `configRevision`. A `model` or
`tier` on the resume is a deliberate reroute: it wins and replaces the snapshot.
If the snapshot's model is no longer listed or enabled, the resume resolves as
before and the receipt warns. When failover moves a child, its snapshot follows to the
new model and gains `failedOver: true`, so an evaluation can leave it out. Snapshots
older than 30 days, and all but the newest 1000, are removed at startup.

## Auto routing

Experimental, and off unless you set `auto`. When a fresh `general` spawn names
no `model` and no `tier`, a small model picks a tier for it through
`ctx.generate.text`. Other agents get a tier [once, from their
description](#agents-that-declare-no-tier) instead. With `auto` on, a tier whose
`effort` is `"auto"` also gets its variant from the decider on each spawn: a
spawn that passes the tier, an agent on that tier, and an auto-routed spawn. When
the decider cannot pick, the tier's default effort applies (see
[Precedence](#precedence)).

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
exist), provider unavailable, unhealthy until a time with its failure class, or a
link to another tier. Health keeps only the failure class (such as `rate-limit`,
`unavailable` or `auth`), never the provider's message, which can hold prompt text
or credentials.
It also shows:

- old role names with lists of their own;
- the model each tiered agent ends up on;
- the values the `subagent` tool's `tier` parameter offers, with their purpose
  and cost class;
- warnings: a custom tier with no purpose, a tier with no candidates, a candidate
  whose own variant wins over the tier effort, a candidate skipped for a variant
  its model lacks, a model with no variant near the effort, and agents that
  re-registering gave up on;
- the derived lineups, and every model the derivation dropped, grouped by reason;
- a "Recent health" section with the last 10 cooldown starts, newest first: time,
  model or provider, failure class, cooldown length, and when it recovered (a
  successful call on the provider, or the cooldown running out) or "still out".
  It lives in memory, so it empties on restart, holds classes and times only, and
  is left out while empty;
- the recent [spawn receipts](#spawn-receipts) and [auto routing](#auto-routing)
  decisions.

The same check is exported for scripts: `checkRoles(options, models, agents,
health?, now?, purposes?, derived?)` returns the report, and `formatCheck(report)`
turns it into text. Build the options as
`{ ...parseOptions(yourOptions), ...buildTiers(parseTierSettings(yourOptions), models, buildReferenceIndex(referenceModels)) }`,
where `models` is the `data` of a `model.list` call.
