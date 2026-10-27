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
| `implementRedirect` | `true` | Replace the `speckit-implement` skill with the beads route where beads is active. |
| `blockTasksToIssues` | `true` | Refuse the taskstoissues skills where beads is active. |
| `workflow` | `true` | Add the workflow instructions to sessions in a SpecKit repository. |
| `agents` | `true` | Register the `speckit-sync` and `speckit-verify` subagents. |

## Tools

`speckit_setup` bootstraps the session's repository. Every phase reports `done`,
`skipped` (already present) or `failed`; a failed phase stops with `ok: false`, and a
rerun resumes by skipping completed phases. Each phase has its own timeout.

1. `specify init --here --force --integration <integration> --script sh --ignore-agent-tools`, unless `.specify/` exists.
2. The community catalog, only with `installAllowed=true` (skipped when `SPECKIT_CATALOG_URL` is set: specify then reads only that catalog).
3. The required extensions not yet installed: `agent-context`, `bugfix`, `cleanup`, `critique`, `fix-findings`, `iterate`, `qa`, `refine`, `retro`, `security-review`, `status-report`, `tinyspec`.
4. `bd init --skip-hooks` without a workspace, then the bundled formulas into `.beads/formulas/`. Formula installation rejects symlinks and never overwrites a divergent file.
5. `specs/**/spec-status.md` in `.gitignore`.

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

- `CHOICE_REQUIRED` and `MIGRATION_REQUIRED` return a question. Ask the user, then call again with `approvals`, `decision` and, for an existing gated run, `migrate`.
- `READY` names the run root and both selections.
- `INCOMPLETE` means the store-lock wait ran out, a bounded `bd` command passed its 120 s bound, or the call was cancelled. It names the step reached and whether a pour was issued; inspect the run before retrying. `mol pour` and `gate resolve` are never cut off.

The whole start holds the beads store's embedded-write lock, so concurrent starts for
a spec cannot pour duplicate runs. The lock is the beads plugin's implementation,
bundled into this package; both copies take turns on the same lock file. Pass `root`
when the spec has several runs. Clarification, analysis, reviews, verification, tests
and consequential safety confirmations stay required whatever the choice.

## Guards and routes

All of them apply only where `bd where` finds a beads workspace, and fail open when
it cannot run.

| Surface | Behavior |
| --- | --- |
| `edit`, `write`, `patch` of `specs/*/tasks.md` | Refused, including patch move destinations. The target's own repository is probed. |
| `shell` writes of `specs/*/tasks.md` | Refused: redirects, `tee`, `cp`/`mv` destinations, `sed -i`, `touch` and similar, resolved against the call's `workdir`. Reads run. |
| `speckit-implement` skill | Its content becomes the beads route: work the task beads under the molecule's `implement` step. |
| taskstoissues skills | `speckit-taskstoissues` and the spec-kit 1.2 `speckit-github-taskstoissues`: the `skill` tool refuses to load them, and their content becomes the refusal. |

Upstream writers the guard denies: `speckit-tasks`, `speckit-converge` (it appends a
`## Phase N: Convergence` section), and the bugfix, cleanup, iterate, reconcile and
refine extensions.

Project skills load after plugins, so the skill transform registers again whenever a
`skill.updated` event shows upstream content.

## Workflow instructions

`instructions/speckit-workflow.md` holds the beads workflow contract and command
routing. A session gets it once its directory holds `.specify/`, and keeps it for the
rest of the session, so the system prompt changes at most once. The two speckit
subagents do not get it.

## Agents

| Agent | Spawn with |
| --- | --- |
| `speckit-sync` | `scope: drift` / `conflicts` / `both` |
| `speckit-verify` | `mode: requirements` / `tasks` / `review` |

Both are read-only (edits denied) and carry the `reviewer` model tier in
`request.headers.x-opencode-model-role`; with the model-roles plugin they run on that
tier's model, otherwise on the parent's. They pin no model.

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
