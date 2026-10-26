---
name: worktrunk-worktrees
description: Work in a git linked worktree created with Worktrunk (`wt`), never in the canonical checkout; covers creation, base commits, absolute paths, provisioning and merges. Use before editing a repository that uses Worktrunk.
---

# Worktrunk worktrees

MUST work inside a git linked worktree of the project, never in its canonical checkout.

## Creating a worktree

Create one with this exact non-interactive invocation:

```sh
wt switch -y --create --no-cd --base <base-commit> --format json <branch>
```

Read the created path from the `path` field of that JSON. When this plugin's worktree strategy is enabled,
OpenCode's own worktree creation runs the same command, so a worktree created from the OpenCode UI or API is a
Worktrunk worktree too.

`--base` takes a commit and defaults to the default branch's current tip. Concurrent workers MUST pass the run's
recorded base commit, so every branch is cut from the same point instead of from whatever has landed since.

## Paths

For every file tool (`read`, `edit`, `write`, `patch`, `grep`, `glob`), pass an absolute path under your own
worktree. NEVER pass a relative file path: relative paths resolve against the session's directory, which may be the
canonical checkout. For shell commands, set the shell tool's `workdir` to the worktree or use `-C <worktree>`.

## Provisioning

Provisioning runs in the post-start hook in the background (reflinked copy of ignored directories; `uv sync` for
Python). If an immediate test, typecheck, or dev server fails with missing-module or missing-type errors, inspect
`wt config state logs --format=json`, wait for the hook to finish, and retry before diagnosing source code. The
`worktrunk-preflight` skill verifies the hooks.

## Merging

`wt merge <target>` merges the current branch, so run it from the source worktree. A worker-to-epic merge MUST pass
`--no-squash --no-ff` to keep per-commit history; an epic-to-default merge may be plain or squashing. This plugin
blocks shell calls that break either rule.

## Ledger and the canonical checkout

When the project has a ledger, claim the bead before creating a branch or worktree; if the atomic claim is refused,
treat the bead as taken and do not release another actor's claim. Branch names are not policed.

From the canonical checkout, only this narrow bootstrap allowlist is permitted:

- worktree creation, provisioning and listing: `wt switch`, `wt step copy-ignored`, `git worktree add`,
  `wt config show`, `wt step prune --dry-run`, and creating the worktree's parent directory;
- read-only `git`: `rev-parse`, `status`, `worktree list`, `fetch`, `log`, and `branch --list`;
- Beads reads, `bd create <title> <args>`, exactly `bd dolt pull`, and `bd update <id> --claim`.
