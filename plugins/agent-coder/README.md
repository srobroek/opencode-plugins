# agent-coder

A lean `coder` subagent for any code development task: implementing, fixing,
refactoring, debugging and investigating failures, writing and running tests,
running builds and linters, profiling, dependency upgrades, and answering questions
about the code. A parent session picks it for development work and keeps `general`
for non-code tasks; `general`'s requests carry every tool and skill.

## Agent

`coder` (mode `subagent`):

- reads the brief, the relevant code and the repository's AGENTS.md, and finds the
  repo's check commands;
- reproduces or measures a failure, slowdown or question before tracing it to a cause
  backed by command output or file lines;
- makes the scoped change in the surrounding code's style, with no unrelated cleanup;
- runs the repo's format, lint, typecheck, test and build commands for the touched
  code, then reviews its own diff;
- follows AGENTS.md (commit, push and scratch rules), and commits or pushes only when
  the brief or AGENTS.md says to;
- returns `BLOCKED` with a question for the caller instead of asking the user;
- replies with `VERDICT: DONE|PARTIAL|BLOCKED`, the answer or root cause when asked,
  the changed paths and each check's result.

## Tools

Its permissions are an allowlist; every other tool, questions included, is denied.

| Tool | Why |
| --- | --- |
| `read`, `grep`, `glob`, `edit` (covers `write` and `patch`), `shell` | Code work, builds, tests, profilers |
| `webfetch`, `websearch` | Library, API and changelog docs without spawning a researcher |
| `execute` (Code Mode) | Plugin and MCP tools are reached through it by default |
| `lsp_*` | Diagnostics and navigation from the lsp MCP server |
| `dep_scan`, `dep_apply` | Dependency upgrades (dep-update plugin); `dep_apply` still prompts per bump |
| `version_gap_scan` | Offline dependency inventory for upgrade research (whats-new plugin) |

It may spawn only `explore` and `mechanic`. `.env` reads and `external_directory`
ask. `find_tools_scan` is denied: adopting new tools is not development work.

## Skills

Skills are allowlisted by id, and the per-language plugins by the prefix `lang-*`, so a
skill added to one is covered. Where a plugin routes a skill family through one
router skill, the router is allowed too, because the family's members are hidden
from the listing and only load by id through it:

| Source plugin | Skills |
| --- | --- |
| `lang-go`, `lang-python`, `lang-typescript`, `lang-rust` | the prefix `lang-*`: each language's router `lang-<language>` and its members, such as `lang-rust-persistence` and `lang-python-profiling` |
| `quality` | `quality-code-design` (debugging, TDD), `quality-code-policy`, `quality-profiling`, `quality-testing` |
| `toolchain` | router `toolchain-guide`; `shell-language`, `terraform-language`, `backend-background-jobs`, `ci-github-actions`, `coexistence-worktree`, `infrastructure-tfstate-guard`, `ops-no-global-cargo-target`, `ops-toolchain-cache-policy`, `toolchain-asset-ownership`, `toolchain-frontend`, `toolchain-infrastructure`, `toolchain-languages`, `toolchain-quality-observability`, `toolchain-stack-defaults` |
| `architecture` | router `architecture-guide`; `architecture-docs-files`, `architecture-ownership`, `architecture-top-level` |
| `dep-update`, `whats-new` | `dep-update`, `whats-new` |
| `trunk-dev`, `worktrunk` | router `trunk-dev-guide`; `trunk-dev-feature-flags`, `worktrunk-worktrees` |

Design, journeys, speckit, delivery, debate, beads and project-management skills are
left out. A skill whose plugin is not installed is simply absent. To allow another
skill, add a rule under `agents.coder.permissions`.

## Model

The agent pins no model. It declares the `standard` tier through the
`x-opencode-model-role` request header, so with the model-roles plugin that tier
picks its model; without it the agent inherits the caller's model. Set
`agent.coder.model` to pin one.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-coder'
```

This plugin ships no skills, so it is not in the Claude Code or Codex marketplace.
