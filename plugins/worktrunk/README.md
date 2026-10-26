# worktrunk

[Worktrunk](https://github.com/max-sixty/worktrunk) (`wt`) support for OpenCode V2. Ported from the
omp-plugins `worktrunk` package. The omp isolation precheck is not ported: OpenCode has no native
checkout-cloning isolation to refuse.

It does three things:

- Registers `wt` as OpenCode's worktree strategy.
- Gates `wt merge` shell calls so worker-to-epic merges keep their history.
- Ships two skills: `worktrunk-preflight` and `worktrunk-worktrees`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/worktrunk'
```

Needs `wt` and `git` on `PATH`. The preflight skill also needs `python3` (3.11 or later).

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `strategy` | `true` | `false` keeps OpenCode's bundled Git strategy. The merge gate and the skills stay on. |

```jsonc
{ "plugins": [{ "package": "...", "options": { "strategy": false } }] }
```

## Worktree strategy

Strategy id `worktrunk`. Adding it makes it OpenCode's default strategy; disposing the plugin
restores the previous one. Worktrees created before the plugin loaded keep their recorded owner.

| Operation | Command |
| --- | --- |
| create | `wt -C <source> switch -y --create --no-cd --base <ref> --format json <name>` |
| remove | `wt -C <directory> remove -y [--force] --foreground` |
| list | `wt -C <source> list --format json` |

- `<name>` is the last component of the directory OpenCode suggests, and becomes the new branch.
  `wt` picks the directory from its `worktree-path` template, and the strategy returns that path,
  so the worktree may not sit where OpenCode suggested. OpenCode's `worktree.directory` setting has
  no effect on this strategy.
- `<ref>` is the requested starting ref. Without one it is the source checkout's `HEAD` commit.
- Worktrunk hooks run as usual: `pre-start` hooks block creation, `post-start` hooks run in the
  background.
- `remove` deletes the branch only when `wt` considers it merged, and never deletes unmerged
  commits. A dirty worktree is refused with `forceRequired`, so OpenCode asks before forcing.
  Removing a directory that no longer exists does nothing.
- `list` reports the main worktree as `root` and every linked worktree as `worktree`.

## Merge policy gate

`execute.before` on the `shell` tool. It refuses:

- `wt merge <target>` to a target other than the default branch without both `--no-squash` and
  `--no-ff`;
- such a merge run from the target worktree, or from a detached `HEAD`, because `wt merge`
  merges the current branch;
- a merge it cannot check: the default branch cannot be resolved, a probe times out, or the
  command is unterminated or runs a merge stored in a variable (`cmd="wt merge x"; eval "$cmd"`).

`wt merge` with no target and merges to the default branch pass. The gate reads the default branch
from `wt config state default-branch`, then `origin/HEAD`, in the call's directory: the shell
`workdir` (resolved against the session directory), a leading `cd DIR &&`, or `wt -C DIR`. It
finds merges behind wrappers (`env`, `sudo`, `timeout`, ...), in `$(...)`, backticks, process
substitutions, `eval` and `sh -c`. `git merge` and `gh pr merge` are not gated.

## Skills

Registered with `ctx.skill.transform` from `skills/<name>/SKILL.md` in this package, so no copy step
is needed. `skills/` ships with the package (`files`), and both `src/` and the bundled `dist/`
resolve it as `../skills`. A skill with the same id that the host already has wins.

- `worktrunk-preflight`: `preflight.py` checks `wt`, hook approvals, ignored project-config keys,
  the default branch, merge evidence, provisioning hooks and `node_modules`. Read-only unless
  `--apply`. Python tests: `skills/worktrunk-preflight/test_preflight.py`, run by `bun test`.
- `worktrunk-worktrees`: the worktree discipline from the omp rule `worktrunk-worktree-required`:
  create with `wt switch`, cut from the recorded base commit, use absolute paths, wait for
  provisioning, merge from the source worktree.

## Smoke test

```sh
bun plugins/worktrunk/scripts/smoke.ts
```

Creates a scratch repository, then creates, lists, refuses to remove while dirty, force-removes and
lists again through the strategy with real `wt`. It runs your Worktrunk config and hooks.
