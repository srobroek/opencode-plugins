---
name: trunk-dev-guide
description: "Use when branching, landing on main, opening or merging a PR/MR, adding or removing a feature flag, or semantic-release."
---

# Trunk-based development guide

## Essentials

- One short-lived branch per change, cut from the default branch and merged within hours to about two days.
- Keep PRs small.
- The PR title is a Conventional Commit header; it becomes the squash subject.
- CI must pass before merge.
- Squash into the default branch unless the repo says otherwise.
- Delete the branch after merge.

Load a row below only for its situation, by id with the skill tool, in this same turn.

| Situation | Load skill |
| --- | --- |
| Branching, opening, merging or landing an MR/PR in a repo with CI or automated releases | `trunk-dev-workflow` |
| A `feat` change, a PR `Flag:` line (a flag or `Flag: none` with a reason), or rolling out or removing a default-off feature flag | `trunk-dev-feature-flags` |
| Setting up semantic-release on GitHub or GitLab with Conventional Commits and synced manifests | `trunk-dev-release-setup` |
