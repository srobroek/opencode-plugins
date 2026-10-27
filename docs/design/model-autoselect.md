# model-roles: automatic model selection (tiers from the catalog)

Status: implemented in bead `opencode-plugins-4p3.24` (tiers, derivation, reviewer, classify-once) and `4p3.25` (`/tiers` TUI). §10 lists where the build differs from the proposal below; where they disagree, §10 and the plugin README win. Plugin: `srobroek.model-roles`. OpenCode 2.1.4 (`68bc26b`).
Builds on [model-roles.md](model-roles.md), beads `opencode-plugins-4p3.18` and `4p3.21`, and D-061 in the dotfiles.

## TL;DR

- **Swap the hand-written role maps for three tiers the plugin works out itself: `cheap`, `standard` and `strong`, plus a `reviewer` tier.** It builds them from `ctx.model.list()` and the models.dev reference data OpenCode already loads. With no options at all, the derived tiers on both devices match the current hand-written maps for the main roles: smol, task, slow, reviewer.
- **The billing kind is in the catalog.** `cost: []` means a flat or subscription plan: ChatGPT sign-in zeroes it, and opencode-claude never sets it. Every cost entry at 0 means free (`opencode/*`). A cost above 0 means metered (Bedrock, API keys). Nothing else is needed. Auth type is an optional second signal.
- **Quality is ranked by list price.** For metered models that's their own cost. For subscription models it's the matching models.dev first-party entry (`openai`, `anthropic`), which is reachable through `ctx.model.transform` → `editor.provider.list()`. Before ranking, the plugin removes superseded, stale, dominated, premium and speed models.
- **The policy depends on billing kind.** Metered: cost-ordered tiers, and the guard refuses spawns that would inherit a premium model. Subscription: subscriptions come before metered, providers follow `prefer` order, the plugin moves away from a provider as its quota fills (soft), and it cools down until the reset on a hard limit.
- **Surface:** `"plugins": ["…model-roles"]` and done. The optional settings are `tiers` (per tier: `model`, `effort`, `purpose`, `distinctVendor`), `prefer`, `avoid`, `include`, `premium`, and `agents` (now holding tiers). `roles` and `purposes` stay as deprecated aliases. The dotfiles `[opencode.model_roles]` block shrinks from about 230 lines to about 10.
- **Size:** about +350 lines of source, about −250 lines of source and options, and about +300 lines of tests, built from real catalog fixtures. The README gets shorter.

## 1. Telling subscription from metered usage

### What the plugin can see

| Source | Fields | Notes |
|---|---|---|
| `ctx.model.list()` → `Model.Info` | `id, providerID, family?, name, capabilities{tools,input,output,temperature?}, variants[{id,…}], time.released, cost[{tier?, input, output, cache}], status (alpha/beta/deprecated/active), enabled, limit{context,input?,output}` | `@opencode/schema/dist/model.js` (`Info`, `Cost`, `Capabilities`). There is **no** `canonical_model_id`. models.dev has it, but the decode drops it. `canonical` is a *provider* id. |
| `ctx.provider.list()` → `Provider.Info` | `id, canonical?, integrationID?, name, activation (auto/enabled/disabled), package, settings` | Bedrock exposes `settings.region` and `settings.profile`. |
| `ctx.model.transform(editor => editor.provider.list())` | `Provider.Definition{provider, models: Map<id, Model.Info>, sourceConnection?}` for **all** records, inactive ones included, *before* model transforms | `core/src/model.ts:67-71,161-164`; `core/src/provider.ts:291-295`. `plugin/models-dev.ts:60-66` adds every models.dev provider (anthropic, openai, google…) as a record whether or not it's connected. |
| `ctx.integration.connection.active(integrationID)` | `{type:"credential", method:"key"\|"oauth"\|"external"}` or `{type:"env", name}` | `@opencode/plugin/dist/promise/integration.d.ts`; `ConnectionCredentialInfo` in client `types.d.ts:954`. `ctx.credential` exposes only `activate`, so the plugin can't read any secret values. |
| `ctx.session.hook("http.response", …, {providerID})` | the raw `Response` (status, headers) for each model call | `core/src/session/model-request.ts:314-340`. The hook can read quota headers. |

### Signals per provider (checked against the sources)

| Provider | `cost` at runtime | family / released | Auth | Source |
|---|---|---|---|---|
| `amazon-bedrock` (work) | list prices, for example Opus 5.5 `$4/$20`. Some models have a second context tier (`cost.length == 2`). | set (`claude-opus`, `gpt-sol`…) | env/profile (`settings.profile = omp-bedrock`) | live `GET /api/model` on this Mac, 149 Bedrock entries |
| `openai` through ChatGPT sign-in | **`[]`**. The model transform sets `draft.cost = []` when the ChatGPT OAuth credential is active. | from models.dev (`gpt-sol`, released dates) | oauth, `sourceConnection` set | `core/src/plugin/provider/chatgpt.ts:310-327`. Model list fixed to `fallbackModels` at `:31-48,306` (no `-fast` ids appear, because models.dev has none) |
| `claude-code` (opencode-claude 1.6.0) | **`[]`** | **none**: `family` unset, `time.released: 0` | `activation: "enabled"`. Availability follows the local `claude` login, and the integration is only a sign-in button. | `dist/index.js:20-46,56`; ids from `dist/models.js:32-40` (`claude-opus-5-5[1m]`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-1[1m]`…); efforts `low..max`, `constants.js` |
| `opencode` free models | every entry `{input:0, output:0}` | set (`flint`, `nemotron`…) | public key | live catalog (9 models) |

**Rule** (pure function, `billingOf(model)`):
1. `cost.length === 0` gives `subscription`. OpenCode then has no price for the model, either because it's a flat plan or because it's unknown.
2. Every cost entry at zero gives `free`.
3. Otherwise `metered`, priced from the base-tier entry, which is the one without `tier`.

An optional `billing: { "<providerID>": "metered" | "subscription" | "free" }` overrides the result for odd custom providers. The auth method from `integration.connection.active` only serves as a hint in `model_roles_check`, because `claude-code` has no OpenCode credential at all.

### Quota and rate-limit information

| Provider | Before a limit is hit | On the limit |
|---|---|---|
| ChatGPT | The Codex backend sends `x-codex-primary-used-percent`, `-window-minutes`, `-reset-at` and `x-codex-secondary-*` (5 h and weekly windows; openai/codex `rate_limits.rs`). These are readable in `http.response`. **Unverified** that the V2 token-sharing endpoint (`chatgpt.ts` `resource`) sends them, so this needs a spike. | 429 `usage_limit_reached` with `resets_at` / `resets_in_seconds`. Token-sharing errors have their own codes, `subscription_sharing_usage_limit_exceeded` among them (`chatgpt.ts:49-57`), which the host refuses to retry. |
| claude-code | The proxy tracks SDK `rate_limit_event`s and serves `GET {baseURL}/v1/health` → `rateLimit{limited, resetsAt, resetInSeconds, utilization}` (loopback only, no Origin; `proxy.js:280-315`). `baseURL` is in the provider settings. | 429 with `Retry-After`, `x-claude-rate-limit-reset`, body `code: "claude_session_limit"` and `resets_at` (`proxy.js:889-925`). |
| Bedrock | none (no quota headers) | `ThrottlingException` / 429 (transient), daily token quotas ("Too many tokens per day") |

**Gap in today's `health.ts`.** The `QUOTA` regex misses `claude_session_limit`, "session limit", `usage_limit_reached` (it has underscores) and `subscription_sharing_usage_limit_exceeded`. These fall through to `rate-limit`, so the plugin cools the *model* for 10 minutes when it should cool the *provider* until the reset. This needs a fix whatever happens to the rest of this proposal.

## 2. Tiers worked out from the catalog with no config

### Rules

The plugin applies these in order. Each step is a pure function, and every model a step drops is reported with its reason in `model_roles_check`.

1. **Eligible:**
   - `enabled`, `status === "active"` (no alpha, beta or deprecated), `capabilities.tools`, and text output.
   - Not `free` unless `allowFree`.
   - Family matches the default include `^(claude|gpt|gemini)(-|$)`.
   - Not excluded by `gpt-oss*` or by an id containing `realtime|image|audio|tts|transcribe|embed|research|preview|search|computer-use`.
   - Not in `avoid`.
2. **Canonical key** (`canonical(id)`):
   - Strip the Bedrock region (`global|us|eu|apac|au|ca|jp|in|us-gov.`) and the vendor prefix (`anthropic.`, `openai.`…).
   - Strip `-vN[:M]`, `-YYYYMMDD` and `[1m]`.
   - Detect a speed suffix (`-fast`, `-ultrafast`, `:fast`) and **drop** that model. It's the same model at about 6× the price, and `prefer` can bring it back.
   - Vendor comes from the prefix, or from the key itself (`claude*` → anthropic, `gpt*`/`o\d` → openai).
3. **Enrich** missing facts from the reference index. The index is models.dev first-party records keyed by canonical id, taken from `editor.provider.list()`. It supplies `family`, `released` and **reference price**. A metered model uses its own base-tier input price. A subscription model uses the reference price. A model with no price and no reference is dropped ("unranked"), and an explicit `tiers.<name>.model` list can still name it.
4. **One model per provider:** among Bedrock region profiles of the same canonical model, keep `global.`, then the unprefixed one, then a regional one.
5. **Supersession:** keep the newest `released` per (provider, vendor, family). Opus 5.5 replaces Opus 4.x and 5; 6.1-sol replaces 6-sol and 5.6-sol.
6. **Stale:** drop a model released more than 120 days before the newest model of its (provider, vendor). This drops `gpt-5.5` (Apr) and `gpt-oss-*` (2025).
7. **Dominated:** drop a model when the same (provider, vendor) has a *newer* model within 10% of its price. This drops `gpt-5.6-terra` ($2, Jul), which 6.1-sol ($2, Sep) dominates.
8. **Premium:** drop anything priced at or above `premium` (default **$8/M input**): Fable 5.x ($10), Astra ($10), `*-ultrafast`. An explicit `tiers.<name>.model` list can still name them.
9. **Lineup** per (provider, vendor), sorted by price ascending. List price stands in for quality, which holds *within* one vendor's current lineup once steps 5–7 have run.
   - `cheap` = the cheapest model.
   - `strong` = the dearest.
   - `standard` = the models between them. With only two, it's the dearest one at the standard effort.
10. **Effort:** `cheap` → `low`, `standard` → `medium`, `strong` → `high`. `effort` changes these per tier.
    - Nearest-variant mapping: walk the scale `none < minimal < low < medium < high < xhigh < max` and pick the closest variant the model has, with ties going to the lower one.
    - A model with no effort variants gets none. Opus 5.5 has no `none`, so a request for `none` maps to `low`.
11. **Order across lineups within a tier** (deterministic):
    1. billing kind: subscription before metered
    2. `prefer` index (provider id, vendor, or a model glob)
    3. price: ascending for cheap and standard, **descending** for strong ("best first")
    4. newer first
    5. id

`reviewer` = `strong`, reordered so that candidates whose vendor differs from the **calling session's model** vendor come first. Today's `reviewer` and `challenger` roles hand-code this "second opinion from another family".

### Results against the real catalogs

I tested this with a prototype of the rules above, run against:
- the live `GET /api/model` from this Mac (work: Bedrock plus free `opencode/*`)
- models.dev `api.json` (2026-10-27)
- the ChatGPT model list from `chatgpt.ts:31-48`
- the opencode-claude 1.6.0 fallback catalog

**Work (Bedrock only, no options; the free `opencode/*` models are dropped as `free`):**

| Tier | Candidates in order | Current hand-written equivalent |
|---|---|---|
| cheap | `global.anthropic.claude-haiku-5-5#low` ($0.1), `global.openai.gpt-6-luna#low` ($0.1) | smol: luna, haiku (same pair, other order. Use `prefer` or accept it) |
| standard | `global.openai.gpt-6.1-sol#medium` ($2), `global.anthropic.claude-sonnet-5-5#medium` ($2) | task: `gpt-6-luna#xhigh`, `sonnet-5-5#high`, `gpt-6-sol#high` |
| strong | `global.anthropic.claude-opus-5-5#high` ($4), `global.openai.gpt-6.1-sol#high` ($2) | slow, architect, reviewer: **identical** |
| reviewer | strong, with the other vendor first (Opus when the caller runs on GPT, and the reverse) | reviewer/challenger: Opus, Sol |

Lineups after pruning:
- anthropic: haiku-5-5 < sonnet-5-5 < opus-5-5
- openai: gpt-6-luna < gpt-6.1-sol

Dropped, with reasons:
- premium: Fable 5 and 5.1, Astra
- speed: `*-ultrafast`
- dominated: `gpt-5.6-terra`
- stale: `gpt-5.5`, `gpt-oss-*`
- superseded: Opus 4.5–5, Sonnet 4.6/5, Haiku 4.5, `gpt-6-sol`, `gpt-5.6-*`
- not in the default include: kimi, grok, glm, nova, gemma, mistral…

With every vendor allowed, you get `nova-micro`, `gemma-4-e2b` and the rest as "cheap". That's why the default include matters.

**Personal (ChatGPT plus claude-code, both `subscription`, ranked by reference price):**

| Tier | No options | With `prefer: ["openai"]` (D-057: ChatGPT first) | Current hand-written equivalent |
|---|---|---|---|
| cheap | `claude-code/claude-haiku-5-5#low`, `openai/gpt-6-luna#low` | luna, haiku | smol: luna, haiku ✓ |
| standard | `openai/gpt-6.1-sol#medium`, `claude-code/claude-sonnet-5-5#medium` | same | task: `gpt-6.1-sol`, `sonnet-5-5#medium`, `gpt-6-sol` ✓ |
| strong | `claude-code/claude-opus-5-5[1m]#high`, `openai/gpt-6.1-sol#high` | sol, opus | slow, plan: sol#high, opus#high ✓ |
| reviewer | the other vendor from the caller first | same | reviewer: opus first (it matches when the caller runs on GPT) |

Dropped: `gpt-6-astra` and `claude-fable-5-1[1m]` (premium), `gpt-5.6-terra` (dominated), `gpt-5.5` (stale), plus the superseded models. The guard's personal `expensive` list (Astra, Opus, Fable) is replaced by the premium rule: Astra and Fable are premium and guarded; Opus is `strong` but, by user decision (2026-10-27), not guarded.

**Robustness check (metered API keys, models.dev):**
- openai: cheap `gpt-6-luna`, standard `gpt-6.1-terra` (released 2026-10-26, picked up with no config change), strong `gpt-6.1-sol`.
- anthropic: haiku, sonnet, opus.
- google: `gemini-3.5-flash-lite`, `gemini-3.8-flash`, `gemini-4-argon`.

Before I added the exclude patterns, `gpt-realtime-2.1` came out as OpenAI "strong" and Google's `deep-research-preview` got into every tier. The name excludes are load-bearing, and tests must cover them.

## 3. Selection policy

| | Metered (Bedrock) | Subscription (ChatGPT, Claude) |
|---|---|---|
| Within-tier order | cheap and standard cheapest first, strong best first | `prefer` order, else the same as metered |
| Mixed device | subscription candidates come before metered ones in every tier (they're already paid for) | |
| Guard | refuse, or auto-pick a tier, when an untiered spawn would inherit a **premium** model (priced at or above `premium`, by list price on subscriptions). Strong models such as Opus are not guarded. This replaces the `$4` threshold; an explicit `guard.expensive` list still overrides. | same. It saves quota rather than money. |
| Runtime fallback | today's retry hook and cooldowns, within the tier. No cross-tier step-down, because a cheaper tier is a quality change. | same, but **after the tier's subscription candidates run out**, `strong` falls through to `standard`. Running slightly weaker beats stalling until the weekly reset. |
| Hard quota | (Bedrock daily token quota) cool down the provider for `quotaCooldownMs` | cool down the provider **until the reported reset**: `resets_at`, `Retry-After`, `x-claude-rate-limit-reset`, `x-codex-*-reset-at`. Fix the `QUOTA` regex. |
| Soft quota (phase 3, optional) | n/a | Record utilization from `http.response` (`x-codex-*-used-percent`) and the claude-code `/v1/health` (polled at most every 60 s, only once claude-code has been used).<br>• At ≥ 80% of the short window, demote that provider in `cheap` and `standard`.<br>• At ≥ 95%, or ≥ 90% of the weekly window, demote it in `strong` as well. |

**Determinism.** The tier lists depend only on the catalog, the options and health. Health changes only on failure, reset or utilization events, never at random. There's no round-robin "spreading". On subscriptions, quota is spread through the soft demotion above, and it's deterministic given the same utilization. A session keeps its model unless the plugin falls back, which keeps prompt caching intact.

**How the parent's choice and the decider fit.**
- The `subagent` tool gets a `tier` enum: `cheap | standard | strong | reviewer`, plus custom tiers. The free-form `role` parameter stays as an alias.
- The old role names are still accepted as aliases (table below).
- Precedence is unchanged: explicit model > tier argument > agent tier (from `agents`, the header, built-in defaults or the one-time classification) > agent model > inherit.
- The opt-in `auto` decider picks a *tier* for `general` spawns only, from `cheap` and `standard` (by default), and runs on `cheap` at effort `none` (`@tiny`). `capAtParent` compares lineup ranks instead of prices. Every other untiered subagent is classified once from its description (§10).
- Root sessions are never routed.

## 4. User-facing surface

### Options (after)

```jsonc
// zero config
"plugins": ["github:srobroek/opencode-plugins#main::path:plugins/model-roles"]

// everything optional
{ "package": "…model-roles", "options": {
  "tiers": {                                     // per tier, every field optional; a missing tier is "auto"
    "strong":   { "model": ["amazon-bedrock/global.anthropic.claude-opus-5-5#xhigh", "amazon-bedrock/global.openai.gpt-6.1-sol"], "effort": "high" },
    "standard": { "effort": "auto" },            // model "auto" (derived); effort picked per spawn when auto is on
    "reviewer": { "distinctVendor": true },      // the default for reviewer
    "docs":     { "model": "auto", "effort": "medium", "purpose": "writing docs" } // custom tier, borrows standard
  },
  "prefer": ["openai", "claude-code"],           // provider id, vendor, or "provider/model*" glob; ordering only
  "avoid":  ["*fable*", "amazon-bedrock/*grok*"], // never derived (an explicit list still wins)
  "include": ["claude", "gpt", "gemini"],        // family prefixes (default shown)
  "premium": 8,                                  // USD/M input at or above which a model is premium (and guarded)
  "agents": { "compaction": "standard" },        // agent id -> tier (built-in defaults below)
  "guard": true, "auto": true,
  "roles": { … }, "purposes": { … }              // DEPRECATED aliases: seed tiers and their purposes
}}
```

Built-in `agents` defaults (an id with no installed agent is ignored):

| Agent | Tier |
|---|---|
| `general` | `standard` (none when `auto` is on: the per-spawn picker chooses) |
| `explore` | `cheap` |
| `title`, `summary` | `cheap`, effort `none` |
| `compaction` | `cheap` |

Shipped agents declare their tier in the same header, `x-opencode-model-role: strong`. Renaming the header would churn every agent file and the lib contract for no gain.

**Legacy role aliases.** These are built in, so headers and `subagent` calls that use today's names keep working. The shipped agent headers moved to tier names in the same change.

| Old role | Tier | Effort |
|---|---|---|
| smol, commit | cheap | tier default |
| tiny | cheap | `none` |
| task | standard | tier default |
| slow, plan, architect, designer | strong | tier default |
| challenger, judge | reviewer | tier default |
| default | none (inherit) | |

### Dotfiles before and after

Before (`dotfiles/.chezmoidata/opencode.toml`): about 230 lines.
- 17 work roles and 13 personal roles, each a list of 2–3 candidates
- per-device guards and purposes
- a 22-entry agents map
- comments explaining which ids are "UNVERIFIED"

After:

```toml
[opencode.model_roles]
package = "github:srobroek/opencode-plugins#main::path:plugins/model-roles"

[opencode.model_roles.options.work]
guard = true
prefer = ["anthropic"]      # optional: Opus/Sonnet ahead of GPT at equal price

[opencode.model_roles.options.personal]
guard = true
prefer = ["openai", "claude-code"]   # D-057: ChatGPT subscription first
```

The `agents` map goes away. Builtins get built-in defaults, and shipped agents carry the header. The `purposes` go too, since the tiers have built-in texts. The `MODEL_ROLES` live test in dotfiles becomes "`model_roles_check` reports no empty tier".

One real difference: work `task` today leads with `gpt-6-luna#xhigh`, a cheap model at high effort. Derived `standard` leads with `gpt-6.1-sol#medium`. To keep the old behaviour, set `tiers.standard.model = ["amazon-bedrock/global.openai.gpt-6-luna#xhigh", …]`, or accept the change.

### What to delete or simplify in the code

- `guard.threshold` and `AUTO_THRESHOLD` → "expensive" means premium. `guard.expensive` (a list) and `allowModels` stay as overrides.
- `purposes` → `tiers.<name>.purpose`, with built-in texts; `purposes` stays as a deprecated alias. The enum building in `spawn-role.ts` lists tiers only.
- `auto.roles`, `auto.decider` (`@smol`) → defaults `["cheap","standard"]` and `cheap#none`. `capAtParent` compares tier ranks.
- In the check tool, per-candidate "unknown variant" chatter for derived tiers goes, since nearest mapping never fails. The tool reports derived tables and drop reasons instead.
- Keep: `roles` with `@links`, health and cooldowns, the retry-hook fallback, the agent transform re-registration, `spawn-role` storage, the header strip.

## 5. Algorithm (implementation shape)

```
catalog.ts (new, pure):
  canonical(id) -> {key, vendor, speed}
  billingOf(model) -> metered|subscription|free
  enrich(model, refIndex) -> {family, released, price}
  deriveTiers(models, refIndex, options, now) -> {cheap[], standard[], strong[], dropped[{ref, reason}]}
  nearestVariant(model, effort)
  reviewOrder(list, callerVendor)
  aliasOf(name) -> {tier, effort?}
index.ts (adapter):
  ctx.model.transform(editor => { refIndex = buildRefIndex(editor.provider.list()) })  // read-only, no edits
  on model.updated / provider.updated / health change: tiers = deriveTiers(...)
  resolveRole(name): options.roles[name] ?? tiers[aliasOf(name).tier] (+ effort)  // existing resolver unchanged downstream
```

The derived tiers turn into ordinary candidate lists (`provider/model#variant`). Everything downstream stays as it is: health filtering, the agent transform, `spawn-role`, the retry-hook fallback, the guard, auto.

## 6. Migration plan

1. **Phase 1 (one PR, non-breaking):**
   - Add `catalog.ts`, the reference-index snapshot, derived tiers and the alias table.
   - When `roles` is absent, resolve names through tiers. When `roles` is present, its names win and the other names fall back to tiers.
   - Fix the `QUOTA` regex.
   - `model_roles_check` prints the derived tables.
   - Add catalog fixtures, trimmed from this Mac's `/api/model`, models.dev openai/anthropic, and the opencode-claude 1.6.0 list. The tables in §2 become snapshot tests.
2. **Phase 2:**
   - Switch the guard to tier-based "expensive", keeping the old `expensive` list accepted for one release.
   - Make the `subagent` param a `tier` enum (old names still accepted).
   - Change auto defaults to tiers.
   - Move shipped agent headers to tiers and shrink `lib/src/model-roles.ts` `MODEL_ROLES` to tiers plus aliases. `scripts/check-agent-roles.ts` follows.
   - Shrink the dotfiles (D-061 amendment).
3. **Phase 3 (optional):**
   - Soft quota demotion from `http.response` (ChatGPT) and claude-code `/v1/health`.
   - `strong` → `standard` spill on subscriptions.

## 7. Estimated code delta

| File | Change |
|---|---|
| `catalog.ts` (new) | about +220 |
| `catalog.test.ts` + fixtures | about +250, plus fixture JSON |
| `resolve.ts` | about +40: tier lookup, alias, effort |
| `index.ts` | about +50: reference snapshot transform, re-derive on events |
| `guard.ts` | about −90: threshold, expensive list, cost labels |
| `auto.ts` | about −30 |
| `spawn-role.ts` | about −30: purposes, cost text |
| `check.ts` | about +40: tables, drop reasons |
| `health.ts` | about +5: regex |
| phase 3 quota | about +120 |
| README | rewritten around tiers, about −80 net |
| dotfiles `opencode.toml` | −220; its live test simplified |

## 8. Risks

- **Wrong ranking.**
  - Price stands in for quality only within one vendor's current lineup. It fails across generations (Opus 4.x at $5 > Opus 5.5 at $4; gpt-5.5 at $5.5 > 6.1-sol at $2), and that's why supersession, stale and dominated pruning exist.
  - A new family name (say `claude-sonata`) is ranked automatically by price.
  - A new **vendor-wide price cut** can reorder tiers.
  - Mitigation: `model_roles_check` shows the tables and drop reasons, `pin` and `avoid` fix things locally, and the fixture tests pin the rules.
- **Name heuristics.** The exclude patterns (realtime, image, preview, oss…) and the default include `claude|gpt|gemini` are a judgment call. The prototype showed `gpt-realtime-2.1` and `deep-research-preview` leaking in without them. New special-purpose models will need pattern updates, and a test fails loudly if a fixture's tier changes.
- **Reference index missing.** If models.dev is stale or offline, the bundled snapshot is used (`plugin/models-dev.ts`). A claude-code id with no models.dev match (a new CLI model before models.dev lists it) is "unranked" and dropped until it appears. That's safe but surprising, so `check` reports it.
- **Preview and deprecated models** are dropped by `status`. Bedrock marks nothing as preview today, so the name patterns cover that.
- **Per-device surprise.** The same config gives different models on different devices. That's the point, but `check` must show it. Changes also happen without config edits: a new model appears, or the models.dev refresh updates prices. Mitigation: log a one-line notice when a tier's head changes on `model.updated`.
- **Determinism.** The order is total (the last key is the id). Health and quota are the only things that change it at runtime.
- **Unverified (spike before phase 1 or phase 3):**
  1. ~~that `editor.provider.list()` inside a user plugin's `ctx.model.transform` returns the inactive `anthropic` and `openai` models.dev records with their costs~~ **confirmed** (§10);
  2. that the ChatGPT token-sharing responses carry `x-codex-*` headers;
  3. ~~that a read-only model transform causes no reload loop with the agent-transform re-registration~~ **confirmed** live: the transform ran once per model-state build;
  4. the live claude-code catalog from the CLI (the ids may differ from the fallback list, but `canonical()` strips `[1m]` and `:fast`).
- **Tests:** keep decisions pure and table-driven over fixture catalogs (the four device and API scenarios in §2), plus a property test that every tier is non-empty whenever the lineup is non-empty.

## 9. Open questions

1. Should work `standard` lead with `gpt-6-luna#xhigh` (today's choice: cheap model, high effort) or with `gpt-6.1-sol#medium` (derived)? This decides whether "standard" means a mid-priced model, or the cheapest model at a higher effort. The second would be a different rule, which I don't recommend.
2. Is `review` a fourth tier, or a `distinct: true` flag on spawns and agents? A tier is simpler for the spawner.
3. Should `subagent` also get an `effort` parameter, or is per-tier effort plus aliases enough?
4. Metered budget: should the plugin read `session.usage.updated` costs and step down tiers past a daily USD budget on Bedrock?
5. Should the default include be widened (for example `grok`, `glm`) on devices that opt in, or is `include` enough?
6. Should `prefer` beat the "subscription before metered" rule on a mixed device? The proposal says no.

## 10. As built (4p3.24, 2026-10-27)

**Spike.** On a private `opencode serve` (all `XDG_*` and `HOME` isolated, Bedrock profile `omp-bedrock`), a user plugin's `ctx.model.transform` saw 230 provider definitions from `editor.provider.list()`, including the unconnected `anthropic` (20 models), `openai` (82) and `google` (32) records with their models.dev `cost`, `family` and `time.released`. No bundled reference price table was needed. The trimmed dumps are the test fixtures (`src/fixtures/work-models.json`, `src/fixtures/reference.json`).

**Shape.** `options.tiers.<name>` = `{ model?: "auto" | string | string[], effort?: level | "auto", purpose?, distinctVendor? }`. Built-ins `cheap`, `standard`, `strong`, `reviewer`; any other key is a custom tier, offered in the `tier` enum with its purpose and cost class. A list entry's `#effort` beats the tier effort; tier effort maps to the nearest variant. `reviewer` without a model borrows `strong`'s candidates, a custom tier without one borrows `standard`'s. `effort: "auto"` drops the variant, and with `auto` on the decider picks one per spawn from the model's variants.

**Differences from the proposal.**
- The fourth tier is named `reviewer` (not `review`), and the vendor flip is a per-tier `distinctVendor` flag (default on for `reviewer` only). It applies to spawns that pass the tier and to agents whose own tier has it.
- No `pin` or top-level `effort` option: `tiers.<name>.model` and `.effort` cover both.
- Guard: premium only (user decision 2026-10-27). Strong models such as Opus are not guarded.
- Alias table trimmed to the user's list (no `classifier`, `memory`, `advisor`, `web`, `vision`; `challenger` and `judge` map to plain `reviewer`).
- The deprecated `roles` seed a tier verbatim (no tier effort) when the tier sets no `model`: from a role of the tier's own name, else `smol`/`commit` → cheap, `task` → standard, `slow`/`plan`/`architect`/`designer` → strong, `challenger`/`judge` → reviewer. An explicit `model: "auto"` ignores the seed. Every legacy role keeps resolving under its own name; other names become custom tiers.
- One-time classification: a `mode: subagent` agent with no model and no tier is classified from its description by the decider (`@tiny`, at least 30 s timeout since it runs in the background), cached in plugin storage as `classify:<id>` = `{ hash, tier }` (FNV-1a of the description), and applied through the agent transform. A failure gives `standard` for the run and is retried on the next start. `general` is never classified; the per-spawn auto picker is limited to it.
- `capAtParent` compares lineup ranks (cheap 0, standard 1, strong 2; premium counts as 2). A lineup of one model ranks 1.
- Extra name excludes beyond §2: `latest` (alias ids such as `gemini-pro-latest`) and `live`. Service-tier variants (`-pro`, `-flex`) lose supersession ties to the plain id (same family and date, shorter key wins).

**Live check** (isolated server, Bedrock): with no options the agents resolved to `general` → `gpt-6.1-sol#medium`, `explore`/`compaction` → `haiku-5-5#low`, `title`/`summary` → `haiku-5-5#none`. A spawn with `tier: "reviewer"` from a Haiku session ran on `global.openai.gpt-6.1-sol#high`, and from a GPT-6 Luna session on `global.anthropic.claude-opus-5-5#high`. A project markdown subagent with no tier was classified `cheap` once; after a restart it kept `haiku-5-5#low` with no decider call.

## 11. `/tiers` TUI (4p3.25)

`src/tui.tsx` (the `./tui` export) registers `/tiers` (slash and palette). It calls the server RPC `model-roles`: `state` returns the tier table (source, effort, purpose, candidates, what resolves now, the configured entry), the location's enabled models and the config file it would write; `set` writes one `options.tiers.<name>` (or removes it with `null`). `/api/experimental/config` PATCH only takes `shell`, so the server edits the file with `jsonc-parser` `modify`/`applyEdits` (comments kept, bare string entry converted to the object form), in the highest-precedence global file that holds the model-roles entry (`opencode.jsonc` over `opencode.json`, under `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, as OpenCode resolves it). Live: setting `cheap` to `gpt-6-luna#xhigh` over RPC moved `explore` to it within seconds and with no restart; setting `cheap` effort `xhigh` through the real TUI (driven in a pseudo-terminal) did the same.
