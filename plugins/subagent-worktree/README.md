# subagent-worktree

Runs opted-in subagents in their own git worktree, then merges their branch back with
[Worktrunk](https://github.com/max-sixty/worktrunk) (`wt merge`).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/subagent-worktree'
```

Needs `git`. Merging needs `wt` on `PATH`. Worktrees come from OpenCode's active worktree strategy:
the `wt` strategy when the [worktrunk](../worktrunk) plugin is loaded, OpenCode's Git strategy otherwise.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `agents` | `["implementer", "implementer-high", "general"]` | Agents (id or name) whose subagent calls get a worktree. |
| `base` | `"HEAD"` | Ref the worktree starts from, resolved in the caller's checkout. |

```jsonc
{ "plugins": [{ "package": "...", "options": { "agents": ["implementer"], "base": "HEAD" } }] }
```

## How it works

### Where a subagent starts

The plugin adds an optional `worktree` argument to the built-in `subagent` tool: the path (or a
path inside it), the branch, or the directory name of an existing worktree of the caller's
repository, as `git worktree list` reports it. Anything else is refused, as is `worktree` together
with `sessionID`. The argument is removed before the built-in tool runs.

| Caller passes | Read-only or not opted-in agent | Opted-in writer |
| --- | --- | --- |
| `worktree` | a child session moved into that worktree before it starts | a fresh worktree branched from that worktree's `HEAD`, merged back into its branch |
| nothing | the caller's directory | a fresh worktree branched from the caller's checkout |

Child sessions start in the parent session's location, so a parent that already runs in a worktree
(for example after `session_move`) passes it on without `worktree`. A child moved into a worktree
gets a prompt line naming it, and its reads and commands there are inside its own directory, so
they do not ask for `external_directory`. With `worktree`, a writer branches from that worktree's
`HEAD` even when `base` names another ref. Naming the worktree the caller is already in changes
nothing. A writer that is not isolated (for example, one a child session spawns) runs in the named
worktree like a read-only agent.

### Writers

`execute.before` on the `subagent` tool. It skips the call when it continues a session (`sessionID`
is set), the agent is not opted in, unknown or primary, the agent is read-only (its last permission
rule matching `edit` on `*` denies it), the caller is itself a child session, or the caller's
directory is not a git work tree. Otherwise it:

1. asserts the `subagent` permission for the agent;
2. creates a worktree with `ctx.worktree.create` named `subagent-<description>-<random>`, starting
   at the `base` commit (or the named worktree's `HEAD`). On a detached checkout (Git strategy) it
   creates a branch with that name;
3. creates the child session the way the built-in tool does (parent, title, agent, model), moves it
   into the worktree, and stores the lane in plugin storage;
4. sets `sessionID` on the call and prepends a short worktree notice to the prompt, so the built-in
   tool runs the child there.

`execute.after` on `subagent` appends a `<subagent-worktree>` block to the result with the branch,
base, target, commit count, a diff command and how to merge. When the child finished with no
commits and a clean tree, the worktree is removed and the child moves back to the caller's
checkout. Continuing such a child later gives it a fresh worktree. Background runs are left alone
until merged. A lane with no commits but uncommitted changes gets a warning: its work exists only
in the worktree, so continue the subagent and ask it to commit.

Each lane is stored as `lane/<childSessionID>`, because the child runs in the worktree's own
plugin instance.

## `subagent_worktree_merge`

| Input | Effect |
| --- | --- |
| `sessionID` | The child session from the subagent result. Not needed for `list`. |
| `method: "wt-merge"` | Runs `wt -C <worktree> merge <target> --no-squash --no-ff --yes`. |
| `method: "none"` | Reports the lane status only. |
| `method: "list"` | Reports every active lane in the caller's project. |
| `target` | Branch to merge into. Defaults to the branch the caller was on. |

For `wt-merge` and `none` the tool asserts the `subagent_worktree_merge` permission for the lane
branch. Only the session that spawned the subagent can merge. The merge is refused when:

- the worktree has uncommitted changes. A lane with 0 commits and a dirty tree is called out:
  continue the subagent and ask it to commit;
- the branch has no commits;
- the checkout that has `target` checked out has uncommitted or untracked changes to any file the
  lane changes (`git diff --name-only <target>...HEAD`). The refusal lists the files. A target that
  is not checked out anywhere has no local changes.

On success `wt` removes the worktree and branch, and the child moves back to the caller's checkout.
On a conflict or any other failure the worktree is kept and the `wt` output is returned.

`list` asserts the `subagent_worktree_merge` permission with resource `list` before reading any
lane or session data. It reads every stored lane in the caller's project and reports the branch, worktree path,
commits ahead, uncommitted changes, and whether the child and parent sessions still exist. Each
session lookup has a 2 second limit and reports `unknown` when it runs out. Lanes whose child or
parent session is gone, or whose worktree git cannot read, are flagged as orphans. `list` only
reports. It removes nothing.

## Credits

The overlap check before merging, the uncommitted-only warning, the orphan report with bounded
session lookups and the read-only agent check are adapted from
[hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble) (MIT). See [NOTICE](NOTICE).

## Caveats

- The plugin asserts the `subagent` permission before it creates the worktree, and the built-in
  tool asserts it again. A rule that asks every time prompts twice; "always" approves both.
- A failure after the worktree exists removes the worktree and the child session.
