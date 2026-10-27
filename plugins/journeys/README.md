# journeys

Author, validate and maintain user journeys: documents that describe what a user
does and observes end to end, validated against the running product.

Ported from the omp-plugins `journeys` plugin.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/journeys'
```

Not exported to Claude Code or Codex: the skills lean on this plugin's tools and
subagents.

## Skills

Only `journeys-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to one of the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `journey-init`: scaffold a `user-journeys` directory. Ships the templates
  (`FORMAT.md`, `README.template.md`, `journey.template.md`, `run.template.md`)
  and `scripts/journeys.py`, which it copies into the journeys directory.
- `journey-write`: author or amend journeys from feature evidence.
- `journey-verify`: validate journeys against the running product. Ships the two
  Beads formulas under `formulas/`.
- `journey-verify-changed`: validate only the journeys a diff affects.
- `journey-campaign`: fleet-scale validation with a fix loop.
- `journey-consolidate`: flush delta logs, prune runs and regenerate the index,
  with human approval.

## Agents

The plugin adds two subagents from `agents/`, converted from the omp agents with
`scripts/convert-agent.ts`:

- `journey-scribe`: writes and amends journey documents; never drives the product.
  Its permissions are a tool allowlist: read, grep, glob, edit, shell, the `journey*`
  skills, Code Mode, the `lsp_*` tools and the journeys tools. Everything else, including web
  access and subagents, is denied and left out of its requests.
- `journey-validator`: drives one journey end to end and records a run. Web fetch,
  web search, skills and subagents are denied. It keeps a denylist rather than an
  allowlist because it drives the product through whatever MCP server the
  journey's profile names, and those tool names are not known in advance.

Both are hidden from the subagent catalog: the `journey-write`, `journey-verify` and
`journey-campaign` skills name them, so the parent spawns them by id.

Fields you configure for an agent with the same id win, and your permissions are
added after the shipped ones, so they take precedence. Both agents declare the
`standard` model tier through the `x-opencode-model-role` request header; with the
model-roles plugin, the `standard` tier picks their model. Without it they
inherit the caller's model. `journey-validator` runs at most 400 steps.

## Tools

- `journeys_index` runs the bundled `journeys.py` with `command` `index`, `lint` or
  `prune` on `journeysDir`, from the session directory. Lint checks structure, not
  semantic readiness. `prune` takes a nonnegative `keep` (default 20), deletes only
  with `yes=true`, and prunes one journey directory when `journey` is set (all of
  them otherwise). A run that times out (10 minutes) or is cancelled reports
  `complete: false` and its reason instead of an exit code.
- `journey_install_formulas` copies the bundled formulas into
  `<repoRoot>/.beads/formulas/`. Both required formulas are checked first; symlinked
  paths and divergent destinations are refused. `force=true` overwrites divergent
  formula files only.

Calls that write ask permission through `permission.assert` first: `journeys_index`
for `index` and `prune` with `yes=true`, and every `journey_install_formulas` call.
Lint and a dry-run prune do not. The action is the tool name; the resource is
`index <dir>`, `prune <dir> <journey>` (`*all*` for a directory-wide prune) or the
repository root. OpenCode's default policy allows unknown actions, so add a rule to
be prompted:

```jsonc
{
  "permissions": [
    { "action": "journeys_index", "resource": "prune *", "effect": "ask" },
    { "action": "journey_install_formulas", "resource": "*", "effect": "ask" }
  ]
}
```

Each validator records its journey's run and findings. The coordinator alone
updates the shared `INDEX.md` and `TRACKER.md` and commits journeys-directory
changes per wave. The filesystem safety checks are preflight checks, not locks
against concurrent writers.
