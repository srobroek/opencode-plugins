---
name: trunk-dev-workflow
description: Use when branching, opening, merging or landing an MR/PR in a repo with CI or automated releases (trunk-based).
metadata:
  opencode/autoinvoke: false
---

# Trunk-based delivery

Use this procedure for changes that will land in a repository with CI or automated releases:

1. **Keep the batch small.** Split work into independently testable changes that can be integrated promptly. Keep the default branch releasable; do not accumulate unrelated work before opening a merge request (MR) or pull request (PR).
2. **Use a short-lived topic branch.** Create one for review or isolation, keep it current, and aim to merge within hours or at most about two days. Delete it after merge. Do not use a long-lived `next` or `rc` branch to accumulate development.
3. **Tie claims to branch lifetime.** Claim the work bead before cutting the branch; its native `started_at` claim timestamp is the branch-age clock. Use one branch per work bead. Parallel or stacked work belongs in child beads of an epic. A re-cut branch gets a fresh bead and claim. Delivery's per-PR merge-queue bead remains the merge record; trunk-dev adds no merge bead.
4. **Open an MR/PR early.** Make its title a truthful Conventional Commit header (GW-7). Include the feature-flag decision line when applicable. Follow the delivery-git-workflow skill for PR mechanics and review. Agent-authored PRs start as drafts there. Follow GW-10 for the repository's landing method.
5. **Require CI before merge.** Run the relevant tests, build, and package checks in the MR/PR pipeline. Require a passing pipeline and review before merging. Test the merged result too when the forge supports it. Do not merge a failing change; restore a green default branch promptly if a merge breaks it.
6. **Make the MR/PR one release unit.** Where GW-10 permits, squash into the default branch. The Conventional Commit title (GW-7) supplies the release subject. Use `feat` for a delivered capability, `fix` for a correction, `perf` for a performance improvement, and `revert` for a reversal; mark breaking changes as required by the release tool. This squash guidance applies to the MR/PR into the default branch. Worker-to-epic integration merges preserve history with `wt merge <target> --no-squash --no-ff` from the source worktree.
7. **Release each qualifying merge.** Run release automation on the default branch for every qualifying `feat`, `fix`, `perf`, `revert`, or breaking change. Do not hold such changes for a periodic batch on `next` or `rc`.
8. **Test unreleased work from its exact change.** Use an MR/PR branch install, a pinned commit SHA, or a CI artifact tied to that SHA. These identify precisely what is under test without a parallel development line. A long-lived `next`/`rc` branch is not the testing path: it accumulates unrelated commits, obscures the tested revision, and delays integration. An opt-in prerelease channel is acceptable as an exception for real external testers who need a published, installable version; keep it explicitly unstable and do not use it as a second trunk.

## Enforce it on the forge

The trunk-dev plugin's commit gate and advisories are best-effort, early local guardrails for the shell command forms they parse, not a guarantee that every non-conventional commit or direct push is blocked. Enforce the invariants at the server boundary:

- Protect the default branch. Developers and maintainers cannot push directly; changes merge only through an MR/PR with a required passing pipeline (`Pipelines must succeed` on GitLab or required status checks on GitHub). Require squash merge, or at minimum strongly encourage it and validate the squash title. The semantic-release token's bot identity must be the only identity permitted to push the release commit and tags; otherwise branch or tag protection will block the automated release.
- Fail the MR/PR pipeline when its title (the future squash subject) is not a Conventional Commit. For example, run commitlint against `$CI_MERGE_REQUEST_TITLE` on GitLab or the pull-request title on GitHub.
- Fail the pipeline when a `feat` MR/PR description lacks a named `Flag:` line (the `default off` or the `enable` form) or uses `Flag: none`.
- In a repository with a Beads ledger, add the daily stale-branch job on GitHub (scheduled workflow) or GitLab (job plus pipeline schedule) using step 7 of the trunk-dev-release-setup skill.

These server-side checks make the policy enforceable; local guidance and the plugin's checks complement them.

## Keep skip-CI markers out of commit, MR and PR text

GitLab and GitHub skip the pipeline for any commit whose message contains `[skip ci]`, `[ci skip]`, `[no ci]` or `[skip actions]`, even when the author quotes the marker as prose. Do not put one in a commit message, MR/PR title or description unless the change must not run CI; the only routine use is the release bot's own release commit (step 5 of the trunk-dev-release-setup skill). The trunk-dev plugin appends a reminder after a commit, MR or PR shell command whose text contains one; it does not stop the command.