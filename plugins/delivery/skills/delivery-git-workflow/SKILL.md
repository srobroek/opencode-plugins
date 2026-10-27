---
name: delivery-git-workflow
description: Use when creating or reviewing PRs, choosing a merge method, landing with delivery_land or cleaning up after a merge.
---

# Git workflow

## Shipping

- A PR is the default for reviewed or outward-facing work. Agent-authored PRs start as drafts (`gh pr create --draft`); promote with `gh pr ready` only after implementation, local validation, required review and CI are complete with no known blocker.
- The body states what changed, why, and the test plan. Use one close keyword per issue line.
- GW-7: under squash merge the PR title becomes the commit subject, because `delivery_land` passes the title as the squash subject. Give the title a conventional type and, in a monorepo, the package scope (`fix(beads): catalog refresh fails when offline`). Release automation reads subjects, not body bullets. Write the title for end users, never spec ids, task references or phase names.
- GW-8: when the target repository is external, upstream, or not controlled by the user, leave internal linkage out of every externally visible title, body, comment, review and template field. Never mention Beads, bead ids, internal ids, agents, gates, orchestration or workflow rationale there. Controlled repositories keep the Beads linkage below.

## Automated review loop

GW-4: the agent that creates a PR owns its automated-review loop until landing or explicit human escalation. It may hand landing to a `shepherd`, but never to a watcher that polls while holding a session open. Workers a lead dispatched never request or act on review rounds for the lead's PR.

1. Keep the draft until local review, CI and configured automated reviewers (CodeRabbit, Codex, Copilot review, Greptile, repository-configured ones) have run against the exact head.
2. Park pending waits and continue unrelated work; read the review state later.
3. Collect the complete actionable set for the head, assign one fix owner, push the new head and rerun every configured reviewer.
4. Identify findings by review-thread node id, or by review URL plus a stable bot/path/location/finding fingerprint. Count attempts per material issue; a new issue starts at one.
5. Reply when evidence is needed, call `resolveReviewThread`, and read back `isResolved=true`. A reply or an outdated diff does not resolve a conversation.
6. After three unsuccessful fixes of one material issue, hold only that PR for human review, recording issue identities, attempts, heads, fixes and unresolved URLs.

## Approval

The approval is an artifact on the PR for the exact head: an `APPROVED` review whose commit is the head, or, when reviewer and author share one account (GitHub refuses self-approval), a comment by that account whose first line is `VERDICT: APPROVE` and whose body names the head SHA. A `pr-reviewer` reply is advice; post it as the review or comment. `delivery_land` with `requireApproval: true` and `requireGreenChecks: true` checks both before it merges.

## Landing method

GW-10: choose `merge_method` from the target project's documented landing policy before landing:

- `merge` when the policy requires a real merge commit or says never to squash;
- `rebase` when it requires a linear or rebased landing;
- `squash` only when the policy permits squash and requires neither other shape.

An ambiguous or contradictory policy is a hold, not permission to guess. Pass the method explicitly when it is not squash. `delivery_land` refuses an explicit `merge` when the forge reports `allow_merge_commit: false` and refuses a landed commit whose shape does not match the method. Close-out and cleanup use the receipt's proven merge SHA, never assumptions about the forge's merge UI.

## Land and clean up

1. `delivery_land` with `pr`, `expectHeadSha` (the reviewed head; required whenever it would merge), `worktree` (the PR-head worktree, recorded for cleanup), and `merge_method`. A refusal with `mergeIssued: true` means the PR merged: re-run with the same inputs to write the receipt without merging again.
2. When the receipt's `beads.ledgerActive` is true, run the `bd update` and `bd close` commands from the result's `next`, children before parents (a merge-queue bead first).
3. `delivery_cleanup` removes the receipt's worktree and local branch. Never remove a worktree or delete a branch by hand.

- WH-1: cleanup of a landed branch belongs to the agent that merged it; with no merging agent live, the main agent owns it.
- A receipt for a branch whose worktree still exists means `delivery_cleanup` has not run yet.
- WH-7: a `<worktree>.bak.<timestamp>` directory is never a cleanup target. No sweep, `git worktree remove` or `delivery_cleanup` call removes one; removal needs per-path proof (no live process, no unique commits or content) and the user's approval for that exact path.

## Beads linkage

- Agent-created PRs in a live `.beads/` workspace link an existing governing bead in the body as `Bead: <id>`, `Closes-Bead: <id>` or `Bead-Id: <id>`, and stamp `pr` metadata on every implementing bead. Before acting on a bead carrying `pr`, read that PR. Absence of these trailers on an incoming human or bot PR is not a finding.
- For PRs entering the merge queue, create one open, unassigned task bead labeled `pr:merge` and `agent:shepherd` with `branch`, `repo` and `origin_actor` metadata before the PR, add each closing work bead's dependency on it, and stamp PR/base/head anchors on it right after the PR exists. Draft PRs and automated release PRs are not ordinary merge-queue entries.
