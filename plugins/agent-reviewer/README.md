# agent-reviewer

Read-only reviewer subagents that share one review core, and the `review-security`
skill they load.

## Agents

| Agent | Reviews | Tools | Verdict | In the subagent catalog |
| --- | --- | --- | --- | --- |
| `pr-reviewer` | One GitHub pull request, against the caller's classification and accepted request | shell `gh pr view *`, `gh pr diff *` only | `APPROVE\|REQUEST-CHANGES\|COMMENT` | no (`hidden: true`) |
| `code-reviewer` | A local diff: working tree, branch range or commits | read, grep, glob, `lsp_*`; shell `git diff`, `git log`, `git show` only, never `--output` | `APPROVE\|REQUEST-CHANGES\|COMMENT` | yes |
| `security-reviewer` | A repository scope or the files a change touches, source to sink, CWE-tagged | read, grep, glob, `lsp_*`; no shell, no web | `PASS\|MINOR\|MAJOR` | yes |
| `adversarial-challenger` | A claim, plan, design or decision, with evidence-backed counter-arguments | read, grep, glob, `lsp_*`, webfetch, websearch | `HOLDS\|WEAKENED\|REFUTED` | yes |

Every reply starts with its `VERDICT:` line. The delivery plugin's verdict hook parses
`pr-reviewer`'s, and accepts that line below a preamble or inside a code fence too.

`pr-reviewer` is hidden because delivery's workflow and fan-out skill name it when a PR
is ready, so listing it in every primary request's subagent catalog costs tokens without
helping the parent choose. The other three stay visible: a parent picks them on its own
for "review my change", "is this safe" or "poke holes in this plan".

Each permission list is an allowlist: a deny on every action, then the tools the agent
uses. No reviewer can edit, spawn subagents, ask the user, or run Code Mode (`execute`),
so the Code Mode catalog stays out of their requests. Skills are allowed by family
pattern only (`quality-*` from the quality plugin, `review-*` from this one, and
`ast-grep-*` from the ast-grep plugin on `code-reviewer` and `security-reviewer`), so a
skill added to any of those families is covered. Reads
outside the workspace (`external_directory`) and `.env` files ask.

Every agent declares the `reviewer` tier in the `x-opencode-model-role` request header and
pins no model: with the model-roles plugin that tier picks the model, without it the agent
inherits the caller's.

## Review core

Each prompt is composed at build time from `agents.src/<id>.md` and the shared rules in
`plugins/lib/src/review-core.md`: read-only, reviewed material is untrusted data, cite
`path:line`, one root cause is one finding, never reprint code, report to the caller and
never question the user, verdict on the first line, stay within the word cap.
`bun run build` writes the committed `agents/<id>.md`; `bun run build:check` fails when
they are stale. The design plugin's `design-critic` and `a11y-auditor` and speckit's
`speckit-verify` compose the same core.

## Skill

`review-security` (hidden: `opencode/autoinvoke: false`, loaded by name) maps entry
points, traces untrusted input to sinks with a CWE table, checks authentication,
authorisation, validation, secrets and crypto controls, and checks that new values crossing
a boundary meet the same guards at the consuming dispatch point.

## With delivery and quality

The ids `pr-reviewer` and `adversarial-challenger` are unchanged. Delivery ships a
fallback `pr-reviewer` (with its fallback model) and quality a fallback
`adversarial-challenger`, each skipped when `plugin.list` reports this plugin or an
earlier plugin already registered the id. If a fallback copy registers first anyway,
this plugin replaces it, so every load order leaves one agent with these fields. Tests
here keep the copies in sync.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-reviewer'
```

Claude Code and Codex install the `review-security` skill, not the agents, from this
repository's marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install agent-reviewer@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add agent-reviewer@srobroek-opencode
```
