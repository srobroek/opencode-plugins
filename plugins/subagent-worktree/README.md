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

`execute.before` on the `subagent` tool. It skips the call when it continues a session (`sessionID`
is set), the agent is not opted in, unknown or primary, the caller is itself a child session, or
the caller's directory is not a git work tree. Otherwise it:

1. asserts the `subagent` permission for the agent;
2. creates a worktree with `ctx.worktree.create` named `subagent-<description>-<random>`, starting
   at the `base` commit. On a detached checkout (Git strategy) it creates a branch with that name;
3. creates the child session the way the built-in tool does (parent, title, agent, model), moves it
   into the worktree, and stores the lane in plugin storage;
4. sets `sessionID` on the call and prepends a short worktree notice to the prompt, so the built-in
   tool runs the child there.

`execute.after` on `subagent` appends a `<subagent-worktree>` block to the result with the branch,
base, target, commit count, a diff command and how to merge. When the child finished with no
commits and a clean tree, the worktree is removed and the child moves back to the caller's
checkout. Continuing such a child later gives it a fresh worktree. Background runs are left alone
until merged.

Each lane is stored as `lane/<childSessionID>`, because the child runs in the worktree's own
plugin instance.

## `subagent_worktree_merge`

| Input | Effect |
| --- | --- |
| `sessionID` | The child session from the subagent result. |
| `method: "wt-merge"` | Runs `wt -C <worktree> merge <target> --no-squash --no-ff --yes`. |
| `method: "none"` | Reports the lane status only. |
| `target` | Branch to merge into. Defaults to the branch the caller was on. |

The tool asserts the `subagent_worktree_merge` permission for the lane branch. Only the session that
spawned the subagent can merge, and the worktree must be committed and clean. On success `wt`
removes the worktree and branch, and the child moves back to the caller's checkout. On a conflict
or any other failure the worktree is kept and the `wt` output is returned.

## Caveats

- The plugin asserts the `subagent` permission before it creates the worktree, and the built-in
  tool asserts it again. A rule that asks every time prompts twice; "always" approves both.
- A failure after the worktree exists removes the worktree and the child session.
