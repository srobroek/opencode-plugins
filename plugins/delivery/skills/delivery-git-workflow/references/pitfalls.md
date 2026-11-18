# Delivery pitfalls

## `delivery_cleanup` refuses a receipt

- **Symptom:** `delivery_cleanup` reports that the receipt names no worktree path.
- **Cause:** `delivery_land` found no worktree to record: none was passed, and no linked worktree of the session repository has the PR branch checked out at the PR head.
- **Fix:** Pass `worktree` (the PR-head worktree of the session repository) to `delivery_land`. Re-run it with the same inputs to rewrite the receipt, then run `delivery_cleanup`.

## `delivery_land` rejects `repo` or `worktree`

- **Symptom:** `repo: observed "X", expected "Y" from remote origin` or `worktree: observed "/path" as a checkout of another repository`
- **Cause:** `delivery_land` works only in the session repository. It checks `repo` against that repository's remotes and refuses a `worktree` that is not one of its own, because Git must not run in a checkout of another repository.
- **Fix:** Run `delivery_land` from a session in the PR's repository, and pass that repository's `worktree`. `repo` may name any remote of the session repository.

## Landing a pull request of another repository

- **Symptom:** `worktree: observed "/path" as a checkout of another repository`, because you are landing a PR of a repository other than the session's.
- **Cause:** `delivery_land` reads and fetches with Git in the session repository only and refuses a `repo` or `worktree` that is not its own. This is deliberate. The tool does not defend against an attacker who can already write to your own checkouts as your user, and it does not run Git in checkouts it has not verified.
- **Fix:** Run the landing from a session in that repository: move the session there with `tools.opencode.session_move`, or hand the landing to a subagent whose `workdir` is that repository.

## `delivery_land` returns `queued: true` or reports a removed queue entry

- **Symptom:** `ok: false, queued: true` with "the merge queue holds ... has not merged it", or a refusal saying the merge queue removed the entry.
- **Cause:** The base branch requires a GitHub merge queue, so `delivery_land` enqueues the head and waits up to `queueWaitSeconds` (default 600). Merge queues need a paid plan or a public repository; on a private repository of a plan without them the rules read answers `(HTTP 403)` "Upgrade to GitHub Pro or make this repository public to enable this feature", and the tool lands directly instead (see the receipt notes). Queue entries can take longer. GitHub removes an entry when its checks fail, it conflicts, or the PR head changes; the tool then merges nothing. The GitHub API is trusted: the checks guard against races and mistakes, not a malicious forge.
- **Fix:** For `queued: true`, call `delivery_land` again with the same `pr` and `expectHeadSha`: it waits on the existing entry and does not enqueue twice. For a removal, fix the cause on the PR (a new head needs a new review and a new `expectHeadSha`), then land again. A call that resumes after a removal refuses once without enqueuing again; the next call is a fresh enqueue. After `the enqueue may have been accepted`, call again the same way: it waits on the entry if GitHub queued it, and otherwise refuses once as removed. Never enable auto-merge on the PR.

## `delivery_land` refuses with an unreadable pending-queue record

- **Symptom:** `the pending-queue record <path> is unreadable`
- **Cause:** The `pending-queue-<pr>-<head>.json` record next to the receipts does not parse, or names another repository, PR, head or method. It may be the only trace of an enqueue that GitHub accepted, so the tool refuses rather than guess.
- **Fix:** Check the merge queue: `gh api graphql -f query='query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){pullRequest(number:$n){state headRefOid mergeQueueEntry{state}}}}' -f o=<owner> -f r=<repo> -F n=<n>`, or the PR page on GitHub. Delete the file the refusal names. Call `delivery_land` again with the same `pr` and `expectHeadSha`. Never edit the record by hand.

## `delivery_land` refuses because the enqueue lock is held

- **Symptom:** `the enqueue lock <path> for <repo>#<n> at <sha> is held`
- **Cause:** Another `delivery_land` call is deciding or sending the enqueue for this head, or clearing its record, or a call that was killed left its `pending-queue-<pr>-<head>.lock`. No call removes another call's lock.
- **Fix:** Wait and call again with the same `pr` and `expectHeadSha`. If the refusal says the holder `has ended without releasing it`, or no `delivery_land` call is running, check the merge queue on GitHub, delete the lock the refusal names, and call again.

## `delivery_cleanup` refuses another repository or a changed worktree

- **Symptom:** `worktree.owner: observed "a receipt or worktree of a repository other than this session's"` or `worktree.marker: observed`
- **Cause:** The receipt or worktree belongs to a different repository, or the registered worktree's `.git` is now a symlink, FIFO or a file naming another repository. No Git ran in it.
- **Fix:** Run `delivery_cleanup` from a session in the receipt's repository. For `worktree.marker`, inspect the worktree's `.git` by hand and do not run Git in it until it names this repository's `worktrees/` directory.

## `gh pr checks --watch` finds no checks right after a push

- **Symptom:** `no checks reported`
- **Cause:** GitHub has not created the check runs yet, so `--watch` has nothing to watch and exits.
- **Fix:** Poll `gh pr view <pr> --json statusCheckRollup` until it lists checks, then run `gh pr checks <pr> --watch` as a background shell call.

## A retired ledger and the PR gate

- **Symptom:** `This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer.`
- **Cause:** The PR gate reads the ledger of the shell call's working directory. In a repo with a regular-file `.beads/RETIRED` it skips the check, so the message means the working directory is a different, live repo. `No-Bead:` is not accepted.
- **Fix:** Run `gh pr create` with the PR's repo as `workdir`. Add no trailer for a retired repo, create no bead, and do not use `No-Bead:`. If the gate still asks for a trailer, your `workdir` is the wrong repo.

## A draft PR reports no checks

- **Symptom:** `no checks reported` on a draft PR
- **Cause:** Expected in repositories whose workflows skip drafts and run on `ready_for_review`. Elsewhere a draft still runs CI, and marking it ready may not start a new run.
- **Fix:** Finish the work and pass local checks, then run `gh pr ready <n>`. For a fix round, run `gh pr ready <n> --undo`, push, and mark it ready again.

## Landing into a branch that requires a merge queue

- **Symptom:** A direct merge fails with `Repository rule violations found`, often followed by a line like "Changes must be made through the merge queue" (approximate text, not an exact diagnostic)
- **Cause:** The base branch requires a GitHub merge queue. `delivery_land` enqueues on such a branch itself (see the `queued: true` entry); an installed delivery plugin older than merge-queue support merges directly and fails. `gh pr merge` on a queue branch is not safe: with checks still pending it silently enables auto-merge without `--auto`, and that stays armed across pushes.
- **Fix:** Land with `delivery_land`; update the delivery plugin if it does not enqueue. Only when the tool cannot be used, wait until the required checks are green on the reviewed head and enqueue with GraphQL, which refuses a different head: `gh api graphql -f query='mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{state}}}' -f id="$(gh pr view <n> --json id -q .id)" -f oid=<reviewed-sha>`, watch `gh pr view <n> --json state,mergeCommit,headRefOid` until MERGED with `headRefOid` equal to the reviewed SHA, and close the bead by hand with the PR number and merge SHA. Never pass `--auto`.

## A restart did not pick up a merged plugin fix

- **Symptom:** `opencode plugin check` lists a plugin as `(update available)` after OpenCode restarted
- **Cause:** Server startup only checks unpinned npm and git plugins for updates; it does not change the installed package.
- **Fix:** Run `opencode plugin update`, and run it again with the project directory as `workdir` for plugins a project's `.opencode/opencode.json` loads. If the update times out, update one plugin at a time with `opencode plugin update <id>`. Then confirm `opencode plugin check` shows `(current)`. A running server keeps the plugin code it loaded until a reload.

## Two sessions editing one worktree after a restart

- **Symptom:** `already has a live writer session ses_` from subagent-worktree, or two writers committing to the same branch and worktree after OpenCode restarted
- **Cause:** After a restart OpenCode resumes interrupted subagents on its own, and they show as running. Re-spawning a writer for the same branch then adds a second live session to that worktree.
- **Fix:** After a restart, list your background work first. Re-spawn only sessions that are gone, never two writers per worktree. Send a follow-up (pass its `sessionID`) to the surviving session, or stop it before you spawn a new one. The plugin only coordinates spawns within one OpenCode server instance; concurrent spawns from separate server instances are not coordinated, so keep one orchestrator per worktree.
