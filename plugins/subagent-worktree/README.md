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
| `agents` | `["coder", "implementer", "implementer-high", "ui-implementer", "general"]` | Agents (id or name) whose subagent calls get a worktree. |
| `base` | `"HEAD"` | Ref the worktree starts from, resolved in the caller's checkout. |

| `gates` | `true` | Register the `experimental.idle` gates (see Cleanup layers). The hook is experimental; if the host lacks it the plugin runs without gates. |
| `resumeGraceMinutes` | `10` | A landed lane is kept this long after a `subagent` call last targeted its child. |
| `emptyGraceMinutes` | `30` | An empty lane is removed only after its child and parent stayed idle this long. |
| `sweep` | `"report"` | `"off"`, `"report"` (plan only) or `"prune"` (carry the plan out). |
| `minAgeHours` | `24` | The sweep never prunes a worktree younger than this. |
| `intervalHours` | `6` | The background sweep runs at most once per project in this time. |
| `include` | `[]` | Extra roots, beyond OpenCode's worktree directory, the sweep may look in. |
| `freeBuildDirs` | `true` when `sweep` is `"prune"`, else `false` | A pruning sweep frees ignored build directories of kept worktrees whose owner is gone (see Build directories). When `false`, the sweep report only names the worktrees where it could. |
| `lowDiskBytes` | `0` (off) | When free space on a worktree's disk falls below this many bytes, build directories are freed without waiting for the 30-minute grace period. |

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
base, target, commit count, a diff command and how to merge. The plugin keeps the lane of a child
that still exists, so the lane of an idle child stays until the host deletes or archives that
session (see Cleanup layers). Before it removes an empty lane, it moves the child back to the
parent's directory. Continuing such a child later without `worktree` gives it a fresh worktree.
Background runs stay until you merge them. A lane with no commits but uncommitted changes gets a warning: its work
exists only in the worktree, so continue the subagent and ask it to commit.

Each lane is stored as `lane/<childSessionID>`, because the child runs in the worktree's own
plugin instance.

## `subagent_worktree_merge`

| Input | Effect |
| --- | --- |
| `sessionID` | The child session from the subagent result. Not needed for `list`. |
| `method: "wt-merge"` | Runs `wt -C <worktree> merge <target> --no-squash --no-ff --no-remove --yes`, then removes the checkout only if the child session is gone (see below). |
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

`wt merge` keeps the checkout (`--no-remove`), and the child stays in it. After a successful merge the
plugin removes the checkout through the same verified removal as every other path. That removal runs
under the removal lock, refuses if a resume happened since the merge began, and checks the child
session last. It removes the checkout only when the child session is deleted or archived, and it
then retires the lane as `merged`. While the child session exists, the merge still completes and the
merge commit lands on the target. The checkout and the lane stay, the child does not move, and
the result tells the parent to delete or archive the child session so the lane can be removed. On a
conflict or other failure the worktree is kept and the `wt` output is returned.

`list` asserts the `subagent_worktree_merge` permission with resource `list` before reading any
lane or session data. It reads every stored lane in the caller's project and reports the branch, worktree path,
commits ahead, uncommitted changes, and whether the child and parent sessions still exist. Each
session lookup has a 2 second limit and reports `unknown` when it runs out. Lanes whose child or
parent session is gone, or whose worktree git cannot read, are flagged as orphans. `list` only
repairs missing worktrees by moving their child sessions back to the parent's directory and
marking the lanes removed, and reports these repairs. It does not delete any worktree.

## Cleanup layers

Agent worktrees pile up when work lands or an agent dies. Five layers keep them in step, each
covering what the others cannot see. The plugin removes a lane only when the host has
**deleted or archived** its child session and the lane is empty or landed. Every removal is a non-force
`worktree.remove` followed by a refresh, and the plugin never deletes a remote branch.

Every removal is applied under a per-directory lock and re-checked at that moment: no `subagent` call
resumed the child since the facts were read, HEAD is still the commit the landed proof covered, and
the tree is still clean. The local branch is deleted only when the worktree was on it (not
detached) and it still points at that commit, with `git update-ref -d refs/heads/<branch> <oid>`,
so a ref that moved is left alone. Landed proofs are keyed by commit, never by branch name.
The idle gate counts every `background` job (shell, image, subagent) that belongs to the child, a
descendant of it, or a shell that names the lane directory, and reads the child's own status; an
unknown status or an ownership lookup that fails or spans unread pages keeps the worktree.

A lane may be removed when all of these hold:

1. **Landed.** Its tip is an ancestor of `origin/main`, or a merged PR's `headRefOid` equals the tip
   (one batched `gh pr list` per repository, cached for five minutes), or `wt list` reports the
   branch integrated, or `delivery_land` recorded that PR head for it. The local branch is deleted
   (`git branch -D`) only on this proof.
2. **Clean.** No uncommitted or untracked change (ignored files are fine), no merge, rebase,
   cherry-pick, revert or bisect in progress, no stash on its branch. `delivery_cleanup` applies
   the same check.
3. **Child gone.** The host reports the child session as deleted or archived. The plugin reads
   this directly under the removal lock, as the last step before the removal. A child that exists
   (running, or idle and so resumable) keeps its lane. A lookup that fails, or that cannot tell the
   session from a missing location or service, also keeps it. A success, an `error` result or an
   idle signal does not release a lane. The sweep removes the lane once the host deletes or
   archives the child.
4. **Parent done with it.** The parent is idle, and no `subagent` call targeted the child within
   `resumeGraceMinutes`.

The plugin removes an empty lane (no commits, clean) after the host deletes or archives its child
and the parent stays idle for `emptyGraceMinutes`. A child event does not shorten that wait.

| Layer | Covers | Does not cover |
| --- | --- | --- |
| 1. `delivery` `autoCleanup` | `delivery_land` runs `delivery_cleanup` itself, and retries it when a turn ends, for worktrees nothing owns. A lane's worktree is never removed by delivery: this plugin owns it (see Claims below), delivery reports `cleanup.deferred` and records the landing. | A lane landed by hand, or any other tool. |
| 2. Lane sync on a landing | An `execute.after` hook on `delivery_land` and `delivery_cleanup`: when the result shows the worktree removed (or its path gone), the lane is retired as `landed` and the worktree list is refreshed. `list` stops showing it. Results are read defensively (object, JSON or prose), and nothing happens when `delivery` is not installed. | Lanes whose worktree is still there. |
| 3. Execution events | `session.execution.failed`, `.interrupted`, `.succeeded` and `session.idle` for a lane child or the parent of lanes. One debounced pass (about 2 s) per session; `succeeded` and `idle` for one execution are one pass. It records how a child ended, tells the parent once when a failed or interrupted child left work, and removes a landed, clean, finished lane. | A hard crash or a restart: the server emits nothing. |
| 4. Idle gates | `experimental.idle`. A child idle with uncommitted changes gets one nudge per dirty state. A lead with finished lanes gets one message: landed and clean lanes are removed, an unresolved lane (commits, not landed, no open PR) is named once, a landed-but-dirty lane is reported once. Nothing is sent while one of its children runs, and at most one message per session every 15 s, because a message admitted in the hook fires the hook again. `subagent_worktree_merge` method `keep` (with `reason`) silences a lane until its state changes. | An interrupt or a failure: the hook does not fire for them. |
| 5. Sweep | Worktrees that no event or gate reaches: a crash, a restart, a PR merged on the forge after the lead went idle, worktrees from before lanes existed. Runs after 30 s at startup and on `session.created`, throttled by `intervalHours`. Only paths under OpenCode's worktree directory (plus `include` roots and lane records). Prunes only landed, clean worktrees that no live session owns and that are older than `minAgeHours`; dirty or unpushed ones are **quarantined**, reported and kept. An unknown owner keeps the worktree. `git worktree prune` runs only for entries whose directory is already gone. | Anything it cannot prove: it keeps it. |

`sweep` defaults to `report`: the plan is stored under `sweep/last` and nothing is removed until
you set `"sweep": "prune"` or call the tool with `mode: "prune"`.

A worktree whose pull request was **closed without merging** (the tip commit heads a closed pull
request, and no pull request from the branch is open) is pruned like a landed one when it is clean,
unowned and older than `minAgeHours`, but its **branch is kept**: the ref is never deleted. It goes
through the same verified removal, session move and locks as every other removal. "No open pull
request" must be proven: the batched open list must succeed and be shorter than its 200-entry limit,
and under the lock a fresh `gh pr list --head <branch>` must succeed and find none. Any failure keeps
the worktree.

### Build directories

A worktree the sweep keeps can still hold gigabytes of build output. When its owner is gone, its
tree is clean or dirty only in ignored files, and no hold or git operation blocks it, a pruning
sweep with `freeBuildDirs` on deletes these directories inside it: `target`, `node_modules/.cache`,
`.turbo`, `.next/cache`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `dist`, `build`. "Gone"
means no session ran in the worktree for 30 minutes, or none runs now when free space is under
`lowDiskBytes`. Each directory must be a real directory (not a link), ignored per
`git check-ignore`, with no tracked file in it. Tracked files and untracked files that git does not
ignore are never touched. Under the worktree's lease lock, after the same fresh checks as a
removal, each directory is moved into the worktree's own git directory
(`.git/worktrees/<name>/opencode-trash/`) and compared by inode, without following a link on its
path; nothing moves when any check or the lock fails. git status and `git add -A` cannot see it
there. A main checkout (its git directory is shared by every worktree), a git directory that does
not point back at the worktree, and one on another device are skipped. The slow recursive delete
runs after the lock is released, so a resume or a hold write never waits for it, and it checks the
inode again first. What a failed or interrupted delete leaves is deleted by the next pass, and
`git worktree remove` or `prune` deletes it with the rest of that directory. The default
follows `sweep`: on only for `"prune"`. In report mode the plan names the worktrees where build
directories could be freed.

### Coordination on disk

Plugins load once per location: the parent's checkout and each lane's worktree run their own
instance, so in-memory locks, generations and holds would coordinate nothing between them. All of it
lives under `<git-common-dir>/opencode/`, shared by every instance of the repository:

- `locks/<sha1 of the directory>.lock`: one lock per worktree, using the protocol the Beads embedded
  write lock ships (`plugins/beads/src/bd-embedded-write-lock.ts`), reproduced in
  `plugins/lib/src/lease-lock.ts` because it is entangled with Beads' store resolution and writer
  registry there. A hold is an `O_EXCL`-created file with a token and a lease renewed on a heartbeat;
  a holder on this host whose pid is gone, or whose lease nobody renewed, is taken over under a steal
  lock that is held only synchronously. Release is by token under the steal lock, so a stalled owner
  cannot remove its successor's hold. Every removal, every resume and every write to coordination
  state (holds, claims, landing records, denials) takes it, so readers and writers are serialised;
  it is re-entrant inside a removal's own critical section. `delivery` takes this same lock.
- the lane's claim carries the resume `generation` and `resumedAt`. A resume takes the lock, bumps
  the generation and stamps the time; a removal captures the generation before collecting facts and,
  under the lock right before removing, re-reads both from disk and aborts if the generation changed
  or the child was resumed inside the resume window.
- `holds/<sha1 of the directory>/<sha1 of the session>.json`: the background jobs a session has
  running for the lane (its own, a descendant's, or a shell naming the lane directory). Every idle
  gate, child or parent, writes its own entry and clears it when it sees none; every remover reads
  all entries under the lock and a live entry blocks the removal. Entries older than 24 hours (a
  crashed host) are ignored; an entry that cannot be read blocks, and so does a coordination store
  that cannot be written (running work could not have been recorded). A coordination error in a
  hook means a deferred outcome, logged; nothing is removed and nothing is thrown.

### Sessions are moved out before a worktree goes

OpenCode resolves a session's location for every request that touches the session, so a session
left pointing at a removed directory fails with `Location not found` (in the TUI, on a wake or
drain, on `session.get`). Every removal therefore, under the lock and right before the host
removal, lists the project's sessions (every page; an incomplete listing refuses) and:

- refuses if a session in the worktree, or below it, is running;
- moves each idle one to the repository's canonical checkout, and refuses if a move fails.

This covers lane removals, the foreground empty-lane removal and the sweep. `delivery` does the same
in its removal section. The background pass (startup and every `intervalHours`, whenever `sweep` is
not `off`, including the default `report`) also repairs sessions stranded by earlier removals,
including ones made by other tools: a session of this project whose directory no longer exists is
moved, and each move is logged. Archived sessions count (unarchiving one in a removed worktree would
otherwise fail), as idle. The destination is the first of these that exists: the checkout the lane came
from, the repository's canonical checkout, the project root; with none, the session is left alone and
reported. A running session is never moved, and a stat error other than "not found" (permissions, I/O)
means unknown, so that session is left alone. A session whose directory is gone cannot run, so the
move is safe.

### Claims: one remover per worktree

Every active lane has a claim file under the repository's git common directory,
`<common>/opencode/lane-claims/<sha1 of the canonical directory>.json` with
`{ directory, branch, sessionID, parentID, createdAt }`. It is written when the lane is created
(a lane whose claim cannot be written is not created), restored by any later pass that finds it
missing, and deleted when the lane is retired. The common directory is shared by every worktree of
the repository and readable without importing this plugin, which is why `delivery` (a separate
bundle with its own copy of the shared library) can tell a lane from an ordinary worktree: while a
claim exists, or cannot be read, delivery never removes the worktree.

`delivery` writes `<common>/opencode/landings/<receiptId>.json` for a landing it did not finish:
the landed head, the landing session, and a denial if the inline cleanup (or an explicit
`delivery_cleanup`) was refused. Before it acts on a lane, and again under the lane's lock right
before removing, this plugin reads those records. A denial blocks removal until an explicit,
authorized `delivery_cleanup` clears it; a recorded head counts as the landed proof only while it
is still the tip; records that cannot be read block removal. At removal time it also re-reads the
child's and the parent's status, and honours any hold the idle gate set for a job still running.

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
