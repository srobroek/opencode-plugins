# architecture

Architecture guidance as skills, plus a read-only `architect` subagent.

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
`VERDICT: DESIGNED|PARTIAL|BLOCKED`. Its permissions deny `edit` and `shell`, and
`subagent` except `explore`. Rules are added after any you configure for an agent
with the same id, so the read-only boundary holds.

The agent was converted from omp with `scripts/convert-agent.ts`. The omp
`ast_grep`, `lsp` and `find` tools became `grep`, `glob`, an LSP tool when one is
available, and `explore` in place of `scout`. Spawning `explore` from `architect`
running as a subagent needs `experimental.subagent_depth` of 2 or more.

The agent pins no model. On omp it used the `plan` role at high thinking; map it
with the model-roles plugin:

```jsonc
{ "agents": { "architect": "plan" } }
```

or set `agent.architect.model` in your config.

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
