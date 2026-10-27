# Adoption plan

Target host: OpenCode 2.1.4. One row per plugin. "Port" means rewrite against
`@opencode/plugin` 2.x; "as-is" means content moves without code changes.

## 1. omp-plugins estate

| omp plugin | Verdict | OpenCode target | Notes |
| --- | --- | --- | --- |
| architecture | Port (content) | `architect` subagent + 3 skills | Rules become skills; `@plan` model role becomes an explicit model. |
| authoring | Drop | — | Teaches the omp extension API. Rewrite for V2 only if needed. |
| aws | Port (config) | `mcp.servers` + instructions | `aws-guidance` to instructions; drop `aws-skill-first`. |
| beads | Port (core) | `plugins/beads` | Shell gates on `execute.before`/`after`, per-call `BEADS_DIR`, actor from session parentID, lease heartbeat on `session.execution.*` events, stop nudge via `session.synthetic`, `bd prime` via `context` hook. |
| build | Port (content) | `external-repo-worker` subagent | Frontmatter only. |
| chezmoi | Port | `plugins/chezmoi` + skill | Managed-file guard on edit and shell writes. |
| debate | As-is | skills | `debate`, `grilling`, `to-questionnaire`. Borrow octto question types. |
| delivery | Port | `plugins/delivery` + 5 subagents | `delivery_land` and `delivery_cleanup` (382 and 156 calls on omp), receipts, forge adapter; fix fetch-before-read; exact-head approval check moves into `delivery_land`. Drop `hygiene_report` and `worktree-reaper`; shrink `shepherd`. Verdict line + JSON parsed into metadata. See `design/delivery.md`. |
| dep-update | Port | `plugins/dep-update` + skill | `dep_apply` confirmation via `ctx.permission.assert`. |
| design | Port | 8 skills, 4 subagents, `plugins/design` | impeccable detector on `execute.after`; drop the launcher-path workaround; MCP to config. |
| eli5 | As-is | skill | |
| find-tools | Rewrite or drop | — | Built on omp discovery. Decide later. |
| go | Replace | built-in formatter + skill | `formatter: true`; lint/test as a documented command. |
| journeys | Port | 6 skills, 2 subagents, `plugins/journeys` | Tools or plain shell calls to `journeys.py`. |
| project | As-is | skill | `license-picker`. |
| python | Replace | built-in formatter + skill | |
| quality | Port (content) | skill + `adversarial-challenger` subagent | Drop watchdog and advisor-resample (omp-only). |
| rust | Port | skills + `plugins/rust` | Advisories on `execute.after`. The migration-edit gate moved to safety. |
| safety | Port | `plugins/safety` (+ optional permission snippet in its README) | Indirection, remote-exec, attribution, worktree-tmp and git-defender gates throw on `execute.before`, as does the git-aware migration-edit gate (moved from rust); directory flags (`git -C`, `make -C`, …) outside the session ask `external_directory`. Worktree destruction (with the branch-delete and detached-worktree proofs), sudo destruction and force push are decided on `permission.hook("evaluate")`. close-keywords is rewritten on `execute.before`, and package-investigate is an `execute.after` advisory. Text rules, spawn-budget, quota-notice-resume and quality-edit-advisory are dropped. |
| session | Port (slim) | `plugins/session`: `session_resume` tool + thin skill | Built-ins reload full history; this gives a short handoff into a fresh session. Ranks sessions by description, walks back from the end or the last compaction summary. Optional read-only omp transcript mode. See `design/resume-session.md`. |
| speckit | Port (core) | `plugins/speckit` + skills + 2 subagents | spec-kit skills layout (`--integration codex`); `tasks.md` guard on `execute.before`; taskstoissues blocked on the skill tool; implement redirected via `skill.transform`. Fix the 4 harness-independent bugs first. |
| supervisor | Drop | refill sentence in instructions | V2 delivers background results to the parent inbox, wakes an idle parent and survives restarts. On omp its wake and settled nudges duplicated native delivery, stall alerts were mostly sleep artifacts, and the stop reminder led to a dispatch in 2 of 20 cases. Build a stall watchdog only if hung children show up. |
| toolchain | Port (content) | instructions + skills + permissions | tfstate guard to permissions. |
| trunk-dev | Port | `plugins/trunk-dev` + skill | Commit gate and MR advisory. |
| typescript | Replace | built-in formatter + skill | |
| whats-new | Port | `plugins/whats-new` + agent | Report-only mode becomes agent permissions. |
| worktrunk | Port | `plugins/worktrunk` | `wt` as a `ctx.worktree.transform` strategy; merge-policy gate; drop the omp isolation check. |

## 2. New plugins (ours)

| Plugin | Purpose | Effort |
| --- | --- | --- |
| `permissions` | Shared permission and policy config replacing the simple shell guards | S |
| `rules` | Small advisory-only plugin: about 6 `never` rules re-triggered on tool output via `execute.after`, kept as markdown data. Build after the gates. TTSR session data: 13 of 24 rules never fired, no text-scoped rule produced a useful injection, and tool-scoped rules are better as `execute.before` gates or permissions. | S |
| `subagent-worktree` | `execute.before` on `subagent`: create worktree (worktrunk strategy), create child, `session.move`, continue via `sessionID`; explicit `subagent_merge` (`wt merge --no-squash --no-ff`) | M |
| `lsp-hashline` | LSP diagnostics after edits plus an `lsp` tool; hashline `read`/`edit` for an allowlist of models | L |
| `octto` | Browser questionnaire UI, ported from upstream (backlog `opencode-plugins-3go`) | M |

## 3. External plugins and code

| Project | Verdict | What we take |
| --- | --- | --- |
| [vtemian/octto](https://github.com/vtemian/octto) | Port | Whole plugin, V1 to V2. See backlog. |
| [TheIronWolfModding/opencode-v2-lsp-support](https://github.com/TheIronWolfModding/opencode-v2-lsp-support) | Vendor into `lsp-hashline` | LSP manager, 38-server catalog, diagnostics pipeline. Downloads off. |
| LSP via MCP (Serena, mcpls, lsp-tools-mcp, ...) | Under evaluation | Navigation tools; diagnostics after edit still need a hook. |
| [@hy-sde-org/dsh-hashline](https://www.npmjs.com/package/@hy-sde-org/dsh-hashline) | Vendor into `lsp-hashline` | Node port of the omp hashline engine. Pin and run omp parity fixtures. |
| [@glaicer/supercode-hashline-editing](https://www.npmjs.com/package/@glaicer/supercode-hashline-editing) | Reference | V2 read/edit override plumbing. |
| [oh-my-opencode-slim](https://github.com/alvinunreal/oh-my-opencode-slim) | Borrow code | ast-grep tools, loop guard, search-path and patch rescue, cache-safe injection, subagent executor wrapper. |
| [joshuadavidthomas/opencode-beads](https://github.com/joshuadavidthomas/opencode-beads) | Borrow | `bd prime` context-hook injection (MIT, with credit). |
| [github/spec-kit](https://github.com/github/spec-kit) | Adopt | Skills layout; optional `/speckit.*` commands. |
| [nigel-dev/opencode-mission-control](https://github.com/nigel-dev/opencode-mission-control) | Borrow code | Test-gated merge with rollback, early conflict check, touchSet check, checkpoints. Driven from delivery and beads gates. |
| [hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble) | Pilot, conditional | Only after confirming teammates really run in their worktree on V2 (child `location` is dropped when `parentID` is set). Borrow branch preservation and stall detection regardless. |
| omp ratchet (MIT) | Optional port | Gate statistics and protocol as a `ratchet` tool plus skill. |
| [harbor-framework/harbor](https://github.com/harbor-framework/harbor) | Adopt (tooling) | A/B benchmark runs: OpenCode vs omp vs pi on our models and tasks. |

## 4. Not adopting

- OpenAgentsControl.
- APM as the distribution channel.
- oh-my-opencode (inert on V2, SUL license), except `code-yeongyu/lsp-tools-mcp` if the MCP evaluation picks it.
- Mission Control and Ensemble as runtimes replacing beads, delivery or the supervisor.
- A revived orchestrator plugin.
- Rift: no base ref, no branch or merge lifecycle, refuses linked worktrees, and forks `.beads` by default. worktrunk's `wt step copy-ignored` with `.worktreeinclude` already gives copy-on-write artifact copies.
