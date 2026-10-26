---
name: coexistence-worktree
description: Use when other agents or humans edit the same repository or switch the branch underneath you. Worktrunk coexistence and interference handling.
---

# Multi-Agent Coexistence

When `AGENTS.md` is available, follow its general worktree lifecycle guidance. This skill adds the coexistence policy that remains useful without that file:

- Treat concurrent edits by agents or humans as normal. Do not report foreign changes unless they actively block progress.
- Do not clean up, commit, push, stash, or revert another actor's changes. Leave them alone.
- An actor interferes only when it repeatedly overwrites edits, deletes in-progress files, or otherwise prevents progress.

- On interference, move to a linked git worktree instead of fighting over a shared checkout.
- Before `wt prune`, run `wt prune-preview`, record each candidate tip with `git rev-parse`, then run the real prune.
