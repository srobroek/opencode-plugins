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
| `agents` | `["coder", "implementer", "implementer-high", "general"]` | Agents (id or name) whose subagent calls get a worktree. |
| `base` | `"HEAD"` | Ref the worktree starts from, resolved in the caller's checkout. |

| `gates` | `true` | Register the `experimental.idle` gates (see Cleanup layers). The hook is experimental; if the host lacks it the plugin runs without gates. |
| `resumeGraceMinutes` | `10` | A landed lane is kept this long after a `subagent` call last targeted its child. |
| `emptyGraceMinutes` | `30` | An empty lane is removed only after its child and parent stayed idle this long. |
| `sweep` | `"report"` | `"off"`, `"report"` (plan only) or `"prune"` (carry the plan out). |
| `minAgeHours` | `24` | The sweep never prunes a worktree younger than this. |
| `intervalHours` | `6` | The background sweep runs at most once per project in this time. |
| `include` | `[]` | Extra roots, beyond OpenCode's worktree directory, the sweep may look in. |

```jsonc
{ "plugins": [{ "package": "...", "options": { "agents": ["implementer"], "base": "HEAD" } }] }
```

## How it works

### Where a subagent starts

The plugin adds an optional `worktree` argument to the built-in `subagent` tool: the path (or a
path inside it), the branch, or the directory name of an existing worktree of the caller's
repository, as `git worktree list` reports it. Unknown worktrees are refused on new spawns.
Omit the argument for the default behavior. On resumes (`sessionID`), `worktree` is ignored:
the session keeps its directory and the result explains that the argument was ignored.
The argument is removed before the built-in tool runs.

| Caller passes | Read-only or not opted-in agent | Opted-in writer |
| --- | --- | --- |
| `worktree` | a child session moved into that worktree before it starts | a fresh worktree branched from that worktree's `HEAD`, merged back into its branch |
| `worktree: false` | the caller's directory | the caller's directory, without a lane |
| nothing, clean tracked files | the caller's directory | a fresh worktree branched from the caller's checkout |
| nothing, uncommitted tracked changes | the caller's directory | the caller's directory, without a lane; the result explains why |
| `sessionID` with `worktree` | the resumed session's directory; `worktree` is ignored | the resumed session's directory; `worktree` is ignored |

Child sessions start in the parent session's location, so a parent that already runs in a worktree
(for example after `session_move`) passes it on without `worktree`. A child moved into a worktree
gets a prompt line naming it, and its reads and commands there are inside its own directory, so
they do not ask for `external_directory`. With `worktree`, a writer branches from that worktree's
`HEAD` even when `base` names another ref. Naming the worktree the caller is already in changes
nothing. A writer that is not isolated (for example, one a child session spawns) runs in the named
worktree like a read-only agent.

Automatic lanes contain committed files, not the caller's uncommitted edits. When the caller's
checkout has staged or unstaged changes to tracked files, automatic writers run in place.
Untracked files alone do not skip isolation. Passing a worktree path or branch forces a lane
for an otherwise eligible writer, even if the caller's checkout is dirty; those edits are not copied.

### Writers

`execute.before` on the `subagent` tool. It skips the call when it continues a session (`sessionID`
is set), the agent is not opted in, unknown or primary, the agent is read-only (its last permission
rule matching `edit` on `*` denies it), the caller is itself a child session, or the caller's
directory is not a git work tree. It also skips automatic isolation for `worktree: false` or a
single explicit working-directory directive pointing outside the caller's checkout (including
`~/` paths). Incidental file paths and ambiguous multi-repository briefs do not disable isolation;
an explicit worktree path or branch takes precedence. A repository with no commit yet (fresh `git init`) has no HEAD to branch from, so the subagent runs
in place and the result carries a short note; other failures to resolve the base still fail the call.
Otherwise it:

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
commits and a clean tree, the child moves back to the parent's directory before the worktree is
removed. Continuing such a child later without `worktree` gives it a fresh worktree. Background runs are left alone
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

Before invoking `wt merge`, the child moves back to the parent's directory; if this move fails,
the merge does not run. On success `wt` removes the worktree and branch. On a conflict or other
failure the worktree is kept, the child moves back into it, and the `wt` output is returned.

`list` asserts the `subagent_worktree_merge` permission with resource `list` before reading any
lane or session data. It reads every stored lane in the caller's project and reports the branch, worktree path,
commits ahead, uncommitted changes, and whether the child and parent sessions still exist. Each
session lookup has a 2 second limit and reports `unknown` when it runs out. Lanes whose child or
parent session is gone, or whose worktree git cannot read, are flagged as orphans. `list` only
repairs missing worktrees by moving their child sessions back to the parent's directory and
marking the lanes removed, and reports these repairs. It does not delete any worktree.

## Cleanup layers

Agent worktrees pile up when work lands or an agent dies. Five layers keep them in step, each
covering what the others cannot see. A lane is removed only when its work is finished **and**
landed; every removal is a non-force `worktree.remove` followed by a refresh, and no remote branch
is ever deleted.

A lane may be removed when all of these hold:

1. **Landed.** Its tip is an ancestor of `origin/main`, or a merged PR's `headRefOid` equals the tip
   (one batched `gh pr list` per repository, cached for five minutes), or `wt list` reports the
   branch integrated, or `delivery_land` recorded that PR head for it. The local branch is deleted
   (`git branch -D`) only on this proof.
2. **Clean.** No uncommitted or untracked change (ignored files are fine), no merge, rebase,
   cherry-pick, revert or bisect in progress, no stash on its branch. `delivery_cleanup` applies
   the same check.
3. **Child finished.** Not running; when its status cannot be read it counts as not finished.
4. **Parent done with it.** The parent is idle, and no `subagent` call targeted the child within
   `resumeGraceMinutes`.

An empty lane (no commits, clean) is removed only after its child and parent stay idle for
`emptyGraceMinutes`; child events never remove it sooner.

| Layer | Covers | Does not cover |
| --- | --- | --- |
| 1. `delivery` `autoCleanup` | `delivery_land` runs `delivery_cleanup` itself. For a lane whose child is still active this plugin adds a `cleanupHold` to the `delivery_land` input; the result then reports `cleanup.deferred` and layers 3-4 remove it later. | A lane landed by hand, or any other tool. |
| 2. Lane sync on a landing | An `execute.after` hook on `delivery_land` and `delivery_cleanup`: when the result shows the worktree removed (or its path gone), the lane is retired as `landed` and the worktree list is refreshed. `list` stops showing it. Results are read defensively (object, JSON or prose), and nothing happens when `delivery` is not installed. | Lanes whose worktree is still there. |
| 3. Execution events | `session.execution.failed`, `.interrupted`, `.succeeded` and `session.idle` for a lane child or the parent of lanes. One debounced pass (about 2 s) per session; `succeeded` and `idle` for one execution are one pass. It records how a child ended, tells the parent once when a failed or interrupted child left work, and removes a landed, clean, finished lane. | A hard crash or a restart: the server emits nothing. |
| 4. Idle gates | `experimental.idle`. A child idle with uncommitted changes gets one nudge per dirty state. A lead with finished lanes gets one message: landed and clean lanes are removed, an unresolved lane (commits, not landed, no open PR) is named once, a landed-but-dirty lane is reported once. Nothing is sent while one of its children runs, and at most one message per session every 15 s, because a message admitted in the hook fires the hook again. `subagent_worktree_merge` method `keep` (with `reason`) silences a lane until its state changes. | An interrupt or a failure: the hook does not fire for them. |
| 5. Sweep | Worktrees that no event or gate reaches: a crash, a restart, a PR merged on the forge after the lead went idle, worktrees from before lanes existed. Runs after 30 s at startup and on `session.created`, throttled by `intervalHours`. Only paths under OpenCode's worktree directory (plus `include` roots and lane records). Prunes only landed, clean worktrees that no live session owns and that are older than `minAgeHours`; dirty or unpushed ones are **quarantined**, reported and kept. An unknown owner keeps the worktree. `git worktree prune` runs only for entries whose directory is already gone. | Anything it cannot prove: it keeps it. |

`sweep` defaults to `report`: the plan is stored under `sweep/last` and nothing is removed until
you set `"sweep": "prune"` or call the tool with `mode: "prune"`.

### `subagent_worktree_sweep`

`{ mode?: "report" | "prune" }` runs the same sweep on demand and returns the plan, one line per
worktree: `keep`, `prune`, `prune-registry` or `quarantine`, with the reason. `report` (the default)
changes nothing.

### Messages to sessions

Notices are `session.synthetic` messages sent without `resume: false`. The plugin API documents that
`resume: false` notices wait for the next wake, so these are expected to wake an idle session (not
exercised against a live host here). The parent notice reads
`Subagent <child> (<description>) failed|was interrupted: <reason>. Its lane <branch> at <dir> has
<n> commits ahead, uncommitted changes: yes|no. Resume it with subagent sessionID <child>, merge it
with subagent_worktree_merge, or discard it.` Each notice has a key stored on the lane, so a
repeated event or idle sends nothing twice.

### Optional daily schedule

To have the sweep reported without anyone asking, create a schedule with
`POST /api/experimental/schedule`. Give it a Code Mode `if` check that calls
`subagent_worktree_sweep({ mode: "report" })` and wakes the session only when the plan contains
quarantined worktrees. No plugin code is involved.

## Credits

The overlap check before merging, the uncommitted-only warning, the orphan report with bounded
session lookups and the read-only agent check are adapted from
[hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble) (MIT). See [NOTICE](NOTICE).

## Caveats

- The plugin asserts the `subagent` permission before it creates the worktree, and the built-in
  tool asserts it again. A rule that asks every time prompts twice; "always" approves both.
- A failure after the worktree exists removes the worktree and the child session.
