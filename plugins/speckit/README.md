# speckit

SpecKit on beads: spec-driven setup, a workflow tracked as beads molecules, and
protection for `specs/*/tasks.md`, whose task state lives in beads.

Ported from the omp-plugins `speckit` plugin. Install it alongside the `beads`
plugin: the formulas assume a beads workspace, and `build-formula` ships there.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/speckit'
```

Not exported to Claude Code or Codex: the skills lean on this plugin's tools,
formulas and subagents.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `integration` | `codex` | spec-kit integration `speckit_setup` passes to `specify init`. `codex` writes the commands as skills under `.agents/skills/`, which OpenCode loads. |
| `tasksGuard` | `true` | Refuse writes of `specs/*/tasks.md` where beads is active. |
| `implementRedirect` | `true` | Where beads is active, replace the `speckit-implement` skill with the beads route and point `speckit-analyze` at the task beads. |
| `blockTasksToIssues` | `true` | Refuse the taskstoissues skills where beads is active. |
| `workflow` | `true` | Add the workflow instructions to sessions in a SpecKit repository. |
| `agents` | `true` | Register the `speckit-sync` and `speckit-verify` subagents. |
| `specAgent` | `"auto"` | Register the primary `spec` agent. `"auto"`: only where the location, or the project root it lies inside, holds `.specify/`; `true`: everywhere; `false`: never. |

## Tools

The tools run in the session's SpecKit workspace: the session's directory when it holds
`.specify/`, else the project root when the directory lies inside it and the root holds
`.specify/`. Agent registration and the workflow instructions use the same workspace.

`speckit_setup` bootstraps the session's repository. Every phase reports `done`,
`skipped` (already present or an extension could not install) or `failed`.
Extension failures are non-fatal and report the extension and CLI reason;
other failed phases stop with `ok: false`. A rerun skips completed work and retries
missing extensions. `ok: true` means bootstrap completed, not that every optional
extension is available. Each phase has its own timeout.

1. `specify init --here --force --integration <integration> --script sh --ignore-agent-tools`, unless `.specify/` exists.
2. The community catalog, only with `installAllowed=true` (skipped when `SPECKIT_CATALOG_URL` is set: specify then reads only that catalog).
3. Attempt optional extensions not yet installed: `agent-context`, `bugfix`, `cleanup`, `critique`, `fix-findings`, `iterate`, `qa`, `refine`, `retro`, `security-review`, `status-report`, `tinyspec`.
4. `bd init --skip-hooks` without a workspace, then the bundled formulas into `.beads/formulas/`. Formula installation rejects symlinks and never overwrites a divergent file.
5. `specs/**/spec-status.md` in `.gitignore`.

`agent-context` is bundled in the core catalog. All other ids above remain in the
community catalog with download URLs and version requirements compatible with
specify 1.2.x (checked against 1.2.3). `bugfix` is neither removed nor renamed:
default installs fail because the community catalog is discovery-only, not an
install source. Setup does not change that trust policy without explicit opt-in.
Before a workflow, report skipped capabilities. Select `speckit-basic` for core
commands only, or use the formulas' direct-work fallbacks with the same
deliverables and checks. Never skip a review or verification because its
extension is missing.

| Input | Effect |
| --- | --- |
| `workspace` | Repository root, resolved against the session's directory; defaults to it. |
| `integration` | Overrides the `integration` option for this call. |
| `installAllowed=true` | Registers the public community catalog as an install source. Opt in only after vetting the extensions. |
| `force=true` | Re-scaffolds `.specify/` only. |
| `skipSpecify=true` | Installs formulas and gitignore entries only. |
| `skipBeads=true` | Omits beads and formulas, leaving molecule workflows unavailable. |

`speckit_start` starts or resumes the workflow for one `NNN-slug` spec. It asks for
an explicit routine-approval choice before pouring, records it on the run root, reads
it back, and reuses it on resume.

| Human approvals | Formula selection | Routine sign-offs |
| --- | --- | --- |
| Required | `autonomous=no` | Retained |
| Declined | `autonomous=yes` | Omitted |

- `CHOICE_REQUIRED` and `MIGRATION_REQUIRED` return a question. Ask the user, then call again: after `CHOICE_REQUIRED` with `approvals` and `decision`; after `MIGRATION_REQUIRED`, on consent, with the pending `approvals=no`, `migrate=true`, the returned `root` and `decision`. `migrate` with any other `approvals` is refused, so a yes to migrating cannot become `approvals=yes`.
- `READY` names the run root and both selections.
- `INCOMPLETE` means the store-lock wait ran out, a bounded `bd` command passed its 120 s bound, or the call was cancelled. It names the step reached and whether a pour was issued; inspect the run before retrying. `mol pour` and `gate resolve` are never cut off.

The whole start holds the beads store's embedded-write lock, so concurrent starts for
a spec cannot pour duplicate runs. The lock is the beads plugin's implementation,
bundled into this package; both copies take turns on the same lock file. Pass `root`
when the spec has several runs, or alone to resume a run: the tool reads the spec id
from the root. Clarification, analysis, reviews, verification, tests
and consequential safety confirmations stay required whatever the choice.

`speckit_commit` commits SpecKit artifacts. It takes only paths under `specs/` and
`.specify/` (by default both) and refuses when a requested path lies outside them or the
index already holds other files. It builds the commit in a private index (HEAD plus the
working-tree state of those paths), checks the tree changes nothing else, commits that
tree on top of HEAD and syncs the real index for those paths. It stores each file's bytes
exactly as they are on disk, never through `git add`: no clean or process filter from
`.gitattributes` runs and `core.autocrlf` converts nothing. Ignored files stay out, the
exec bit sets the file mode, and a symlink is stored as its link text. A symlink that is
absolute or climbs out of `specs/` and `.specify/`, a path through a symlinked directory,
a submodule and a nested repository are refused. After reading each file it checks the
ancestors, the file's real path and its inode again, and refuses the commit if anything
moved. That closes the practical race window, not a perfectly timed double swap: the
tool guards against an agent's mistakes and casual misuse, not a hostile local process
racing it. It never amends, and a
concurrent move of HEAD makes it fail rather than overwrite the other commit. Every git
call runs pinned to the workspace (`git -C`) without inherited repository selectors
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, object-store and `GIT_CONFIG*` variables),
and it refuses before writing unless git resolves the workspace to itself.

No git hook of any kind runs (pre-commit, commit-msg, reference-transaction,
post-index-change): the tool commits with plumbing, and every git call points
`core.hooksPath` at an empty directory. That is the price of committing exactly the
checked snapshot, so run the project's checks separately. The `spec` agent commits
through it, since a shell `git add` or `git commit` pattern cannot keep its operands or
options in bounds.

## Guards and routes

All of them apply only where `bd where` finds a beads workspace, and fail open when
it cannot run.

| Surface | Behavior |
| --- | --- |
| `edit`, `write`, `patch` of `specs/*/tasks.md` | Refused, including patch move destinations. The target's own repository is probed. |
| `shell` writes of `specs/*/tasks.md` | Refused: redirects, `tee`, `cp`/`mv` destinations, `sed -i`, `touch` and similar, resolved against the call's `workdir`. Reads run. |
| `speckit-implement` skill | Its content becomes the beads route: work the task beads under the molecule's `implement` step. |
| `speckit-analyze` skill | A beads preamble goes ahead of the upstream command: run the prerequisite script without `--require-tasks --include-tasks`, and read the implement step's task beads where it reads tasks.md. The spec and plan analysis stays as upstream wrote it. |
| taskstoissues skills | `speckit-taskstoissues` and the spec-kit 1.2 `speckit-github-taskstoissues`: the `skill` tool refuses to load them, and their content becomes the refusal. |

Upstream writers the guard denies: `speckit-tasks`, `speckit-converge` (it appends a
`## Phase N: Convergence` section), and the bugfix, cleanup, iterate, reconcile and
refine extensions.

Project skills load after plugins, so the skill transform registers again whenever a
`skill.updated` event shows upstream content.

## Workflow instructions

`instructions/speckit-workflow.md` holds the beads workflow contract and command
routing. A session gets it in its system prompt when it has a SpecKit workspace (see
Tools) at the session's first request, and that decision holds for the whole session (also across
a server restart), so the system prompt never changes mid-session and the provider's
prompt cache holds. A session that started without it and runs `speckit_setup` gets the
text in the tool result instead. The two speckit subagents do not get it.

## Agents

### spec (primary)

`spec` drives one feature through SpecKit up to implementation. It checks for
`.specify/`, the `speckit-*` skills and a beads workspace and offers `speckit_setup`;
calls `speckit_start` and asks the routine-approval question; then follows the poured
molecule with the upstream skills (`speckit-specify`, `speckit-clarify`, `speckit-plan`,
`speckit-tasks` as child beads of the implement step, `speckit-analyze`, plus checklist,
critique and security review where the profile has them). It stops at the first step
outside its boundary (the implement step, later docs, checks and the final commit) and
hands those steps to `build` by id (or the task beads to delivery's implementers). It
has three entry paths: a new spec, a resume of an existing spec id or run root (no new
number), and a verify-return that routes verification to `speckit-verify`.

It asks through the `question` tool, which parley takes over when its TUI is attached,
and through `tools.parley_ask` for rounds of several questions.

| Boundary | Allowed |
| --- | --- |
| Steps | 100 |
| Edits | `specs/*` and `.specify/*` only |
| Shell | `bd` (including the beads write-lock runner), `specify`, `.specify/` scripts, and `git` status, diff, log, show, branch, rev-parse, ls-files, merge-base, switch. Branch deletion, renames and forced moves, and discarding or forced switches are denied. |
| Tools | read, grep, glob, LSP, `question`, `execute` (for `parley_ask`, `speckit_setup`, `speckit_start`), `speckit_*` (commits go through `speckit_commit`) |
| Skills | `speckit-*` (this plugin's and spec-kit's), `quality-*`, `beads-ledger` (and its router `beads-guide`) |
| Subagents | `explore`, `researcher`, `architect`, `speckit-verify`, `speckit-sync` |

Everything else is denied, including `git push`, web access and edits of product code.
The `.specify/` scripts it may run can still write outside `specs/`, as spec-kit's own
do (for example the agent-context extension updating `AGENTS.md`).

It carries the `strong` model tier: the spec, plan and task breakdown decide what every
implementer builds, and the agent writes no code, so its token volume stays small next
to the implementation it directs.

Each location runs its own plugin instance, so with `specAgent: "auto"` the agent is
listed (and in the primary-agent cycle) only in SpecKit repositories. A `speckit_setup`
that creates `.specify/` at the location registers it without a restart.

### Subagents

| Agent | Spawn with |
| --- | --- |
| `speckit-sync` (steps 60) | `scope: drift` / `conflicts` / `both` |
| `speckit-verify` (steps 60) | `mode: requirements` / `tasks` / `review` |

The two subagents are read-only (edits denied) and carry the `reviewer` model tier in
`request.headers.x-opencode-model-role`; with the model-roles plugin they run on that
tier's model, otherwise on the parent's. They pin no model. Both are hidden from the
subagent catalog, since the formulas and the workflow instructions spawn them by id, and
neither gets Code Mode; `speckit-verify` may load the `quality-*` skills, `speckit-sync`
no skill.

`speckit-verify` is composed by `bun run build` from `agents.src/speckit-verify.md` and
the evidence and report parts of the shared review core (`plugins/lib/src/review-core.md`);
edit the source, not `agents/`. Its reply starts with `VERDICT: PASS|GAPS`.

Formula steps that spawn them set `execution_agent_type` to the agent id, with
`execution_agent_mode` or `execution_agent_scope` beside it. That is the beads
routing gate's convention: a spawn naming such a step's bead must go to that agent.

The review steps (`review`, and `code-review` in `speckit-feature`) spawn
`speckit-verify` with `mode: review` rather than spec-kit's `review` extension, which
`speckit_setup` does not install. They route to this plugin's own agent, not
delivery's `pr-reviewer`, so they work without the delivery plugin.

## Skills

| Skill | Use when |
| --- | --- |
| `speckit-setup` | Bootstrap `.specify/`, extensions and formulas. |
| `speckit-bugfix` | Fix a defect. For a tracked trail, bond `mol-speckit-bugfix`. |

`speckit-bugfix` loads the `quality-code-design` skill from the `quality` plugin;
without it the skill reports the missing guidance.

## Formulas

- Depth: `speckit-basic`, `speckit-lean`, `speckit-feature`
- Bonds: `mol-speckit-iterate`, `mol-speckit-fix-findings`, `mol-speckit-bugfix`, `mol-speckit-refine`

## Not ported

- The omp `tools/spec-start.ts` CLI. Use `speckit_start`.
- The `beadsPlugin` option. The lock implementation is bundled, so no installed beads package has to be found at runtime.

## License

Apache-2.0
