# architecture

Architecture guidance as skills, plus a read-only `architect` subagent.

Only `architecture-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.

| Skill | When |
| --- | --- |
| `architecture-top-level` | Choosing or changing top-level directories: `apps/`, `services/`, `functions/`, `workers/`, `libs/`, `packages/`, `schemas/`, `data/`, `infrastructure/`, `tools/`, ... |
| `architecture-ownership` | Placing libs by architectural role, owner-local assets and data, schemas, generated clients, UI primitives and product agents |
| `architecture-docs-files` | Inferring architecture or stack, or creating durable project knowledge under `docs/` |

On omp these were rules the host attached by description. Here they are skills the
model loads when the description matches; the text is unchanged apart from
references, which now name the skill (`architecture-docs-files` points at the
`quality-code-design` skill from the quality plugin).

## Agent

`architect` (mode `subagent`) designs systems, modules and APIs and turns a hard
change into an ordered implementation plan. It starts its reply with
`VERDICT: DESIGNED|PARTIAL|BLOCKED`. Its permissions are an allowlist: every tool
is denied except read, grep, glob, the `lsp_*` tools, webfetch, websearch, `subagent`
for `explore`, and the `architecture-*`, `lang-*` and `quality-*` skill families, so
`edit`, `shell`, Code Mode and other skills are not in its requests. Rules are added after any you configure for an agent
with the same id, so the read-only boundary holds.

The agent was converted from omp with `scripts/convert-agent.ts`. The omp
`ast_grep`, `lsp` and `find` tools became `grep`, `glob`, an LSP tool when one is
available, and `explore` in place of `scout`. Spawning `explore` from `architect`
running as a subagent needs `experimental.subagent_depth` of 2 or more.

The agent pins no model. It declares the `strong` model tier through the
`x-opencode-model-role` request header, so with the model-roles plugin the
`strong` tier picks its model. Without it the agent inherits the caller's model;
set `agent.architect.model` in your config to pin one.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/architecture'
```

Claude Code and Codex install the skills, not the agent, from this repository's
marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install architecture@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add architecture@srobroek-opencode
```
