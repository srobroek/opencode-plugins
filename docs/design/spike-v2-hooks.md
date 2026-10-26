# Spike opencode-plugins-33m.1 — OpenCode 2.1.4 plugin hook behaviour

Setup: scratch repo `spike/`, plugin `.opencode/plugins/spike/index.ts` (`@opencode/plugin` 2.1.4, symlinked),
worktree `spike-wt` (branch `wt`). Private `opencode serve --port 47123` (stopped afterwards), driven with
`opencode run --server … --format json`, model `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0`.
Hook events in `hooks.log` (env redacted); per-test transcripts in `run*.json`. Source cross-checked in `../oc` (v2.1.4).

| # | Item | Result |
|---|------|--------|
| 1 | shell `create.before` fires for agent `shell` tool and can set env | PASS |
| 2 | Shell result shape in `execute.after` | PASS (documented below) |
| 3 | Throw in `execute.before` → model sees tool error, loop continues | PASS |
| 4 | Permission evaluates rewritten command | PASS (rewritten wins, both directions) |
| 5 | 40 s `execute.before` not cut off | PASS (no hook timeout) |
| 6 | Tool hooks fire for tools called inside Code Mode `execute` | PASS |
| 7 | `agent.transform` + `update("spike-agent")` creates new agent | PASS (via `/api/agent`) |
| 8 | Subagent worktree trick | PASS |
| 9 | Bun APIs in plugin runtime | PASS |
| 10 | `permission.hook("evaluate")` compound command / deny message | PASS |
| 11 | Unknown agent frontmatter key `role: task` | PARTIAL: loads silently, but the key is moved into `request.body` |

See REPORT in the session reply for evidence.
