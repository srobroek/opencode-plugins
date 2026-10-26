# beads

[Beads](https://github.com/steveyegge/beads) (`bd`) issue tracking for OpenCode V2.
Ported from the Oh My Pi `beads` plugin in
[omp-plugins](https://github.com/srobroek/omp-plugins).

## What it does

On every `shell` call (`tool.hook("execute.before")`), in this order, with one
25-second budget for the whole call:

1. Binary Git hooks: `bd hooks install` is refused and `bd init` gains
   `--skip-hooks` when an existing hook is a binary executable.
2. Gate admission: a mutating `bd` command waits for its store's automatic gates
   to be verified (`bd gate list`, plus `bd gate check` when one could resolve).
3. An unparseable command is refused.
4. `bd edit` is refused: it opens `$EDITOR` and hangs the session.
5. `bd update --status closed|done` is refused in favour of `bd close --reason`.
6. `bd close` on a gate bead is refused (looked up with `bd show`).
7. `bd unclaim` without `--if-assignee` is refused.
8. Claims and creates without an actor are refused; other unattributed writes get
   an advisory in the tool result.
9. `gh pr create` without a `Bead:`, `Closes-Bead:` or `Bead-Id:` trailer is
   refused in a repository with a live ledger that you can write to.
10. Each `bd` write to an embedded store is rewritten to run under
    `bd-embedded-write-runner`, which holds the store's write lock for exactly the
    life of the `bd` process. The lock files are shared with the omp plugin.
11. In a subagent session, `export BEADS_ACTOR='opencode/<root>/<agent>/<session>'`
    is prefixed, unless the command chooses its own actor.

A refusal is thrown, so the model sees it as the tool error.

`shell.hook("create.before")` sets `BEADS_DIR` (the checkout's `.beads`, or the
primary checkout's from a linked worktree) and clears `BEADS_DOLT_SHARED_SERVER`
in the child environment. An explicitly set `BEADS_DIR` is left alone.

`tool.hook("execute.after")` records successful claims per session in plugin
storage, and appends the contention-retry and stale-import advisories.

`session.hook("context")` adds `bd prime` to the system prompt. The text is read
once and frozen per session, so the prompt stays cacheable.

The `subagent` tool also waits for gate admission.

## Options

Every gate is on by default. Switch one off in the plugin options:

```json
{ "gates": { "pr-bead-link-gate": { "enabled": false } } }
```

Gates: `beads-gate-admission`, `binary-git-hooks`, `bd-update-close-gate`,
`bd-close-gate`, `bd-unclaim-gate`, `bd-actor-gate`, `pr-bead-link-gate`,
`bd-embedded-write-lock`, `bd-editor-gate`, `beads-dir-pin`, `beads-prime`,
`beads-claim-tracking`.

## Permissions

OpenCode evaluates shell permissions on the rewritten command. A write that runs
under the lock runner starts with `BEADS_DOLT_SHARED_SERVER= BEADS_DIR=... '<bun>'
'<plugin>/dist/bd-embedded-write-runner.js' ... -- bd ...`, so a rule that allows
`bd *` does not cover it. Add a rule for the runner if your shell permission is
not `allow`.

## Requirements

`bd` and `bun` on `PATH` (or `BUN_INSTALL`, or mise). The runner is a Bun script.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/beads'
```
