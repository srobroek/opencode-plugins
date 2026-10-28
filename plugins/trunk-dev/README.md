# trunk-dev

Trunk-based delivery for OpenCode: a local gate for Conventional Commit subjects and
direct pushes to `main`/`master`, skip-CI and MR/PR advisories, a feature-flag cleanup
bead after each flagged merge, and skills for the workflow, feature flags and
semantic-release setup.

Ported from the omp-plugins `trunk-dev` plugin. The omp rules
`trunk-dev-workflow` and `trunk-dev-feature-flags` are skills here; the
`trunk-dev-skip-ci-text` rule is code (below). Session-start reminders are delivered
once on the first completed `shell`/`bash` result, never in the system prompt.

Every check reads the command with the shared shell parser (`scanShell` from
`@srobroek/opencode-lib`), never a regex over the tool input. Only top-level simple
commands are read, with `cd DIR`, `env -C DIR` and `git -C DIR` moving the directory;
quoted text (`echo 'git commit -m bad'`) is data. A command that does not scan cleanly,
or whose deciding word expands (`"$MSG"`, `$(…)`), is allowed.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/trunk-dev'
```

Needs `git`. The flag-cleanup bead also needs `gh` or `glab`, `bd`, `bun`, and the
`srobroek.beads` plugin installed beside this one.

Claude Code and Codex install the skills from this repository's marketplace:

```sh
claude plugin install trunk-dev@srobroek-opencode
codex plugin add trunk-dev@srobroek-opencode
```

There the skills have no gate or advisories behind them.

## Commit gate

`tool.hook("execute.before")` on `shell` throws, so the command does not run, only in a
repository that releases from commits (a `.releaserc*`, `release.config.*`,
release-please config or manifest, commitlint config, or a `release` key in
`package.json` at the root):

- `git commit`/`dgit commit` whose first `-m`/`--message`, `-F`/`--file` file or `-F -`
  here-document subject is not a Conventional Commit header. Editor commits, `fixup!`,
  `squash!`, `Merge …` and `Revert …` subjects pass. Override with
  `TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1`.
- `git push`/`dgit push` to `main`/`master`: an explicit destination, a bare
  `HEAD`/`@` or no refspec from the main branch, or `--all`/`--mirror`. Dry runs,
  deletions, tags, other branches and unknown options pass. Override with
  `TRUNK_DEV_ALLOW_MAIN_PUSH=1`.

Overrides count as a `NAME=1` prefix on the command (or through `env`) or in the
process environment. This is an early local guardrail, not enforcement: protected
branches, required pipelines and forge title checks enforce the policy.

## Advisories

`tool.hook("execute.after")` appends notes to a completed `shell` call that did not
exit non-zero. They never block.

| Advisory | Fires on |
| --- | --- |
| Skip-CI | `git commit`, `glab mr …` or `gh pr …` whose words or here-document contain `[skip ci]`, `[ci skip]`, `[no ci]` or `[skip actions]`, case-insensitive. Forges skip the pipeline even for a marker quoted as prose. |
| Title | `glab mr create`/`gh pr create` with a literal title that is not a Conventional Commit. |
| Flag line | A `feat` or breaking create without a named `Flag:` line, or a `feat` with `Flag: none`. A body from a file, stdin or an expansion gets a reminder to review it. |
| Squash | `glab mr merge`/`gh pr merge` without `--squash`/`-s` in a release repository. |
| Branch age | A branch push whose merge base with the default branch is more than two days old. |

## Session reminders

In a commit-released repository with a Beads ledger, the first completed shell
result (including a failed command) receives any stale-branch or missing CI-job
reminder. Only local branches linked by bead `metadata.branch` count: claims older
than `TRUNK_DEV_STALE_HOURS` (default 48), or closed/merged beads with live branches.
At most five branches are listed. Known GitHub/GitLab remotes are checked for the
`stale-bead-branches` job; the release-setup skill ships its templates.

Reads use supervised git (2 s) and readonly bd (5 s), without starting a Dolt
server. Each session is probed once, including concurrent calls; failures and clean
repositories are silent. Disable with `"session-reminders"` in `disable`.

## Flag-cleanup bead

When a flagged `feat` request merges, trunk-dev creates one chore,
`chore: remove feature flag <name>`, due on the recorded removal date, with
`metadata.trunk_dev_flag`, the PR URL, and a `discovered-from` link to the landed bead.
The `Flag:` line must be `Flag: <name> (default off; owner <alias>; remove by YYYY-MM-DD)`.

A merge is observed in `execute.after` as a completed `delivery_land` whose output is
`ok: true` (from the `srobroek.delivery` plugin), or a `gh pr merge <n>`/`glab mr merge <n>`
shell call that exited 0. The request is then read back with `gh pr view`/`glab mr view`,
and only one the forge reports as merged counts, so an `--auto` merge creates nothing. An
open cleanup bead for the flag (by metadata or a `remove … flag` title) suppresses a
duplicate.

The write follows the beads plugin's conventions: `bd --actor <actor> create …` runs
under that plugin's `bd-embedded-write-runner`, which holds the embedded store's
single-writer lock for the life of `bd`, with `BEADS_DIR` pinned and
`BEADS_DOLT_SHARED_SERVER` cleared. The actor is `BEADS_ACTOR`, else
`opencode/trunk-dev`. The hook waits 30 s and never kills the writer. When the runner
cannot be found or refuses, the result carries the exact `bd create` command to run
through the shell tool, where the beads gates apply. Every other failure is silent.

## Skills

Only `trunk-dev-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.

Registered through `ctx.skill.transform` (a user skill of the same name wins):

| Name | When |
| --- | --- |
| `trunk-dev-workflow` | Branching, opening, merging or landing an MR/PR: small batches, short-lived branches, required CI, squash release units, exact-SHA previews, forge enforcement, skip-CI markers. |
| `trunk-dev-feature-flags` | Adding a `feat`, writing the `Flag:` line, rolling out or removing a flag. |
| `trunk-dev-release-setup` | Setting up semantic-release on GitLab or GitHub, and the daily stale-branch CI job for Beads repositories (templates in `templates/`). |

## Options

```json
{ "disable": ["commit-gate", "skip-ci", "mr-advisory", "flag-cleanup", "session-reminders"] }
```
