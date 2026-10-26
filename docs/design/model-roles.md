# opencode-plugins-ngm.1 — Model roles on OpenCode V2 (v2.1.4)

Scratch: `$T/opencode/models/` (`src/` = anomalyco/opencode @ v2.1.4 `68bc26b`, `proj/` = test project with a local plugin and a private `opencode serve --port 47991/47992`). I made no changes to global config or the repo.

## TL;DR
- **No native role or fallback chain exists.** Native tools are a fixed `model` per agent, variants, provider aliases (`providers.<id>.models.<alias>.modelID`), `{env:}` substitution, and `provider.use` policies. Nothing in V2 tries model B after model A fails. The `retry` hook can only retry the *same* model, and `model.request.model` is read-only.
- **Don't declare a role with an unknown frontmatter key.** A file that has no V2-native key is decoded as V1. On that path `role: task` moves into `request.body.role`, and `model: x#variant` is **silently dropped**. A file that does have a native key logs a warning and drops `role` entirely. Unknown keys in JSON `agents.*` are silently stripped.
- **Recommendation:** a `srobroek.model-roles` plugin.
  - Put the per-machine role→ordered-candidates map in the plugin options in **global** config.
  - Agents declare their role in one of two places:
    - (a) plugin options `agents: { <agentId>: <role> }`, which works for builtins too;
    - (b) a *known* field: `request.headers["x-opencode-model-role"]`. This is decoded natively, visible in `Agent.Info`, causes no warning, and is not sent today. The plugin strips it in `model.request` to be safe.
  - The plugin resolves each role to the first *available* candidate in `ctx.agent.transform`.
  - It must **re-register its transform after config agents load**, otherwise config `model:` wins.

## 1. Native options (docs + source + tests)

| Feature | Behaviour | Evidence |
|---|---|---|
| Agent `model` | `provider/model#variant` or the expanded `{providerID, model, variant}` | docs/agents#model; `schema/config/agent.ts` |
| Subagent with no model | Inherits the parent session's model: `override ?? agent.model ?? parent.model` | `core/src/tool/plugin/subagent.ts:184`; **tested**: `h-nomodel` child completed on the parent's free model |
| Primary agent model | Used only when the session has no stored model. Clients (app/TUI) copy `agent.model` into the selection when you switch agents. | `session/runner/model.ts:79-88`; `app/src/composer/selection.ts:84` |
| Root `model` | Default; **drops the variant**. Falls back to the newest available model if this one is unavailable. | docs/models#defaults |
| `small_model` / title | V1 `small_model` migrates to `agents.title.model`. Otherwise title uses the provider's small model or a lower variant. | `config/normalize.ts:137-150`; `session/context.ts:94-121` |
| Aliases | `providers.openai.models.coding-default.modelID = gpt-…` gives a stable alias **inside one provider**. It can't point at another provider, so it can't be a cross-backend "role provider". A custom openai-compatible provider pointing at a gateway (LiteLLM) could do that, but outside OpenCode. | docs/models#aliases, docs/providers#gateways |
| `{env:VAR}` | Text-level substitution over the whole config file, so it works in `model`, agent models and plugin options. An unset variable becomes `""`, and the model is then dropped. Note that the **server** process env counts (`opencode service set env`). | `config/variable.ts:25-35`; **tested**: `j2-env-model` = `{env:ROLE_TEST_MODEL}` resolved |
| `policies provider.use` | Denies a provider everywhere. Broader config wins (global beats project). Good for "never use OpenAI on the work box". | docs/policies |
| Fallback / retry | `retry` hook: `{retry, delay}` only, same model. There is no model-fallback config. | docs/build/plugins#retry-policy |
| Unavailable provider | **Not an error at load**: the agent lists fine (`i-unavailable` showed its model). **At use**:<br>• Primary session with no stored model silently falls back to the default (**tested**: `p-unavail` answered "hi").<br>• Subagent fails hard: `Subagent failed (…): Model unavailable: nope-provider/some-model` (**tested**). | `runner/model.ts:79-98` |

## 2. Where the role can live

**Tested** with `.opencode/agents/*.md` and `opencode.jsonc` (`agents.json` from `GET /api/agent`). The decoder is in `core/src/config/plugin/agent.ts:184-215`.

| Declaration | Result |
|---|---|
| `role: task` plus a native key (`permissions`/`request`/`system`/`disabled`) | Loads. WARN `ignored unsupported agent fields ["role"]`. Role is gone; model kept. |
| `role: task`, **no** native key, `model: …#high` | Read as V1. `request.body = {role:"task"}`, and **model dropped** because the V1 `modelSelection` rejects `#`. No warning. |
| `role: task`, no native key, `model` without a variant | V1 path. Model kept, `request.body.role = "task"` (same result as spike 33m.1). |
| `role:` as an object | V1 path. The whole object goes into `request.body.role`. |
| `model: 123` (invalid) | **Whole agent silently dropped** (missing from the list, no log line). |
| JSON `agents.x.role` | Silently stripped (`onExcessProperty: "ignore"`, `normalize.ts:44`). |
| `request.headers["x-opencode-model-role"]` | Native. Shows in `Agent.Info.request.headers`, no warning. Visible to `ctx.agent.transform`. |

About `request.body`/`request.headers`: today the V2 runner doesn't send agent `request` at all. The docs warn about this, I found no use of `agent.request` in `core/src/session`, and spike 33m.1 saw the field dropped on Bedrock. Once that's wired up, a body `role` would reach providers and Anthropic/OpenAI would reject it. A header is harmless, and the plugin should still delete it in a `model.request` hook.

Other places to put the role:
- A naming convention such as `task/…` (nested dirs become IDs) changes agent IDs and permission resources.
- A tag in `description` leaks into the subagent catalog prompt.

Both are worse. **Plugin-options mapping by agent ID** needs nothing in the agent file, works for builtins (`general`, `explore`, `title`, `compaction`), and degrades gracefully.

## 3. Plugin mechanics (tested)

- **Options:** `plugins: [{ package, options }]` becomes `ctx.options` (**tested**: logged at setup).
  - There is **no merge across files**. Operations are applied in config order, and a later `add` for the *same target* replaces the earlier one along with its options (`plugin/supervisor.ts:39-95`).
  - Different target strings for the same plugin ID (for example a global `./x` and a project `./x` that resolve to different paths) give `Duplicate plugin ID`; the first copy is kept.
  - In practice: keep the roles map in **one** place (global, per machine). If projects need overrides, read them from something other than a second plugin entry, or accept full replacement.
- **Order (key finding):** activation runs internal `pre` → user plugins → internal `post`. `ConfigAgentPlugin` is in `post` (`plugin/internal.ts:220-262`), and transforms replay in registration order (`state.ts`).
  - When a user plugin's setup-time `ctx.agent.transform` runs, it sees **only the builtins**. **Tested**: `missing-at-transform` for every config/markdown agent.
  - So `editor.update` at setup **works for builtins**. **Tested**: `general` got the plugin model.
  - For config agents, `editor.update` *creates* a stub that config then overwrites, and config `model:` wins. **Tested**: `j4` kept `anthropic/claude-sonnet-4-5`.
- **Workaround (tested, works):** subscribe to `ctx.event`. On `agent.updated` or `model.updated`, if any role-bearing agent's model differs from the resolved one, register a fresh transform (which puts it last) and dispose the old one. Result after convergence, with one re-registration:
  - `j3`, `j4`, `g-header-role`, `general` and `explore` got their role models, overriding config `model:`;
  - `j5` (unknown role) and `j6` (only candidate on uncredentialed Bedrock) kept their explicit models.
  - Pitfall I hit: the stale check compared with `JSON.stringify`, and key order differs (`{id, providerID}` vs `{providerID, id}`). That caused an endless re-register loop. Compare fields one by one.
  - There is a short startup window where agents show config models. Also, a `GET /api/agent` before activation returned `[]`.
- **Reload:** config edits call `ctx.agent.reload()`, which replays transforms in the same order. A plugin revision change re-runs setup for that plugin and everything after it. Use `model.updated` to re-resolve availability when credentials or discovery change (Ollama inventory, `/connect`).
- **Per-location:** each location (including a worktree a session moves into) runs its own plugin instance with that location's merged config. Global options apply everywhere. Worktree config comes from its own checkout.
- **Per-session dynamic routing:** `ctx.session.switchModel` works, for example on `session.created`/`session.agent.selected`, or as a reactive fallback on `session.execution.failed`. It's racy for the first request and changes the stored session model. `model.request` can only change `headers`/`baseURL`, not the model.

## 4. Failure matrix

| Case | Plugin installed | Plugin absent |
|---|---|---|
| model + role (header/options) | Role's first available candidate wins (tested `j4`) | Explicit model is used (graceful) |
| role only | Resolved model (tested `j3`) | Subagent inherits the parent model; primary uses session/default. Loads fine. |
| role as frontmatter `role:` | ⚠ role lost, or `body.role` plus a dropped `#variant` | same hazard. **Don't use.** |
| unknown role | Keep explicit model, else inherit; log once (tested `j5`) | n/a |
| role → provider without credentials | Skip the candidate. If none are left, keep explicit/inherit (tested `j6`). Never set an unavailable model: subagents would hard-fail. | Explicit unavailable model: subagent hard-fails, primary silently uses the default |
| subagent inheriting | Plugin sets `agent.model`, which beats `parent.model` | `parent.model` |
| work Bedrock vs personal Anthropic | Same agent files; the global `~/.config/opencode/opencode.json` on each machine holds a different `roles` map (or one shared map with ordered candidates where availability decides). Add a `provider.use` deny on the work box if required. | n/a |

## 5. Recommended shape

```jsonc
// ~/.config/opencode/opencode.jsonc (per machine)
{
  "plugins": [{
    "package": "@srobroek/opencode-model-roles",
    "options": {
      "roles": {
        "task":     ["amazon-bedrock/anthropic.claude-sonnet-4-5#high", "anthropic/claude-sonnet-5-5#high", "opencode/…"],
        "smol":     ["anthropic/claude-haiku-4-5", "ollama/qwen3:8b"],
        "slow":     ["anthropic/claude-opus-5-5#max", "@task"],          // "@role" = chain to another role
        "reviewer": ["openai/gpt-6.1-sol#high", "@slow"],
        "commit":   ["@smol"]
      },
      "agents": { "general": "task", "explore": "smol", "title": "smol", "compaction": "task", "reviewer": "reviewer" },
      "fallback": "keep"   // when no candidate is available: keep the agent's own model / inherit; never set an unavailable one
    }
  }]
}
```

```md
---                      # .opencode/agents/reviewer.md (portable, no plugin required)
description: Reviews changes
mode: subagent
model: anthropic/claude-sonnet-5-5#high      # used when the plugin is absent
request:
  headers:
    x-opencode-model-role: reviewer           # known field; ignored without the plugin
---
```

Precedence: `options.agents[id]` > `x-opencode-model-role` header > nothing. Resolution:
1. Expand `@role` with cycle detection.
2. Pick the first candidate whose provider/model is in `ctx.model.list()` (which already applies `provider.use` policies) and whose variant exists.
3. Otherwise apply `fallback`.

Implementation notes (pure functions, tested directly):
- `resolveRole(roles, available, role)` and `desiredModels(agents, options, available)`.
- `setup` registers the transform, re-registers it last on `agent.updated`/`model.updated` when stale (field-wise compare), and registers a `model.request` hook that deletes the role header.
- Optionally expose a `model-roles_list` tool showing the live mapping, so it doesn't go in the system prompt.

## Side finding

The server log reports that `~/.config/opencode/opencode.json` was rejected: `configuration normalization diagnostic … rejected malformed JSON or JSONC document`. Global settings from that file are probably not being applied on this machine. I left it untouched.

## Commands used (summary)
- `opencode api --server http://127.0.0.1:4799x agent.list --param directory=$PROJ` (with `OPENCODE_PASSWORD`, private `opencode serve`)
- `opencode run --standalone --format json --agent p-unavail "Reply with just the word hi."` → "hi" (silent default fallback)
- `opencode run --standalone -m opencode/flint-40b-free "Call the subagent tool … i-unavailable … h-nomodel"` → `Model unavailable: nope-provider/some-model` / `ok`
- Plugin log: `proj/roles.log`; fixtures: `proj/.opencode/agents/*.md`, `proj/opencode.jsonc`, `proj/plugins/roles/index.ts`
