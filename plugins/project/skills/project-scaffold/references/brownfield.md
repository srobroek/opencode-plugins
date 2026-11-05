# Existing repository (brownfield)

Detect first: `git rev-parse --is-inside-work-tree` and `git ls-files | wc -l`. Zero tracked
files is greenfield. Otherwise read before asking: manifests, lockfiles, CI config, hooks,
formatter configs, `AGENTS.md`/`CLAUDE.md`, `.gitignore`, `mise.toml`, `justfile`/`Makefile`.

1. Inventory. List what exists and what you would add or change.
2. Before approval, propose one decision per file or setting: KEEP, CHANGE or REMOVE, with
   the lines or behaviour lost for any CHANGE or REMOVE. Never overwrite a hand-written file
   silently; merge into it (a `CLAUDE.md` content folds into `AGENTS.md`; keep the user's
   hooks and justfile tasks; keep unmanaged text outside anything you add).
3. Keep the project's existing choices (package manager, test runner, formatter) unless the
   user asks to standardise (`toolchain-stack-defaults`).
4. Report, do not hide: CI workflows that would go inactive or are called by nothing after
   your change; checks you could not run (missing tool, no network) as "not run"; steps a
   missing toolchain skipped.
5. Re-running is safe: after adding or removing a capability, re-check that nothing stale
   remains (files a dropped capability left behind are reported and removed only with
   confirmation).

## Adding a monorepo member

- Never create a nested git repository (`--vcs none`, `--no-git`, or delete the member's
  `.git`).
- The root must already cover the member's language in CI and `just check`; if not, add
  that language's tooling at the root first (pinned in mise), then the member.
- Register the member in root CI (a job per member path), the root `justfile` aggregates,
  commit scopes if restricted, and `CODEOWNERS` if paths differ.
- Re-run the root checks (`just check`) and the member's own gate before reporting. Tell the
  user the member's code must live under its own path; the root must not hold a stray
  starter manifest.
