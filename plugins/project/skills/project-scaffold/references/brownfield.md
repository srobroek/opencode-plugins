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
   user asks to standardise (`toolchain-stack-defaults`). A project with no formatter config
   gets one that matches its code, committed with a one-time format pass in its own commit
   (`formatters.md`).
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

## Adopting REUSE in an existing repository

Setup and the CI job are in `license-picker`'s `references/reuse.md`; install and hook are in
`toolchain-quality-observability`'s `references/reuse.md`. Order of work, in its own commit and
PR:

1. Run `reuse lint` first and keep the report as the baseline.
2. Settle the project licence and the holder with the user. Read existing headers and git
   authors before you write any.
3. Annotate the tree: `reuse annotate -r --skip-unrecognised --skip-existing --license
   <SPDX-id> --copyright "<holder>" <dirs>`. Review the diff by hand
   ([reuse-annotate](https://reuse.readthedocs.io/en/stable/man/reuse-annotate.html)). Leave
   generated and vendored directories out.
4. Cover files without headers as in `license-picker`'s `references/reuse.md`, step 3. Use
   `--fallback-dot-license` for single files, and convert an old `.reuse/dep5` with `reuse
   convert-dep5`.
5. Fetch licence texts with `reuse download --all`; do not hand-copy them. Use `--source <dir>`
   offline ([reuse-download](https://reuse.readthedocs.io/en/stable/man/reuse-download.html)).
6. Keep third-party files under their own licence with provenance in `NOTICE`
   (`license-picker`'s `references/reuse.md`, step 5). Never relabel them with the project
   licence.
7. Re-run `reuse lint` until it passes, then add the CI job and hook.
