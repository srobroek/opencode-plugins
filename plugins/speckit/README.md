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
| `specAgent` | `"auto"` | Register the primary `spec` agent. `"auto"`: only where the location or its project root holds `.specify/`; `true`: everywhere; `false`: never. |

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
routing. A session gets it in its system prompt when its directory holds `.specify/` at
the session's first request, and that decision holds for the whole session (also across
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
critique and security review where the profile has them). At the implement step it
stops and hands the task beads to `build` (or delivery's implementers).

It asks through the `question` tool, which parley takes over when its TUI is attached,
and through `tools.parley_ask` for rounds of several questions.

| Boundary | Allowed |
| --- | --- |
| Edits | `specs/*` and `.specify/*` only |
| Shell | `bd` (including the beads write-lock runner), `specify`, `.specify/` scripts, and `git` status, diff, log, show, branch, rev-parse, ls-files, merge-base, switch, `add specs/` / `add .specify/`, commit |
| Tools | read, grep, glob, LSP, `question`, `execute` (for `parley_ask`, `speckit_setup`, `speckit_start`), `speckit_*` |
| Skills | `speckit-*` (this plugin's and spec-kit's), `quality-*` |
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
| `speckit-sync` | `scope: drift` / `conflicts` / `both` |
| `speckit-verify` | `mode: requirements` / `tasks` / `review` |

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
