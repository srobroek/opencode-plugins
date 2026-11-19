---
name: speckit-setup
description: Use to set up or enable SpecKit (scaffold, extensions, formulas, gitignore) or when the speckit-* skills are missing.
---

# SpecKit Setup

Idempotent one-time bootstrap. In OpenCode, call the `speckit_setup` tool rather than
re-implementing the steps by hand. Claude Code has no `speckit_setup` or
`speckit_start` tool; walk the steps below instead.

Requires `specify-cli` (`uv tool install specify-cli`) and `bd`.

## When to use

- A repo needs SpecKit but `.specify/` doesn't exist yet.
- The `speckit-*` skills are missing or extensions are not installed.
- The user asks to "set up / initialize / enable SpecKit".

## What it does

Call `speckit_setup` from the caller's worktree; `workspace` defaults to the
session's working directory. If the tool is unavailable, walk the same steps in
that worktree and skip each one already done:

1. `specify init --here --force --integration <integration> --script sh --ignore-agent-tools`,
   unless `.specify/` exists. Pick the integration for the harness:
   - OpenCode: `codex` (the default), which writes the SpecKit commands as skills
     under `.agents/skills/`, where OpenCode finds them.
   - Claude Code: `claude`, which writes them as skills under `.claude/skills/`.
2. Only on explicit opt-in (`installAllowed=true`, after vetting), register the
   community catalog (`catalog.community.json`) as an install source. Never pass
   `--install-allowed` without it.
3. Attempt the optional extensions not yet installed: `agent-context`, `bugfix`, `cleanup`,
   `critique`, `fix-findings`, `iterate`, `qa`, `refine`, `retro`,
   `security-review`, `status-report`, `tinyspec`. Report each failed install as
   skipped with its reason and continue to beads and formulas. A rerun retries
   missing extensions, not installed ones. Other CLI failures stop setup.
   `agent-context` is bundled; the others are community/discovery-only by default.
   Do not bypass catalog trust or infer opt-in from an installation failure.
4. `bd init --skip-hooks` if no workspace; copy every formula from the speckit
   plugin's `formulas/` directory into `.beads/formulas/`. In Claude Code that
   directory is `${CLAUDE_PLUGIN_ROOT}/formulas/`.
   Formulas: `speckit-feature`, `speckit-lean`, `speckit-basic`,
   `mol-speckit-iterate`, `mol-speckit-fix-findings`, `mol-speckit-bugfix`,
   `mol-speckit-refine`. Keep the `mol-` prefix.
5. Append `specs/**/spec-status.md` to `.gitignore`.

`force=true` authorizes only re-scaffolding `.specify/`; it does not authorize
overwriting divergent formulas. `skipSpecify=true` installs formulas and
gitignore only. `skipBeads=true` explicitly omits beads and formulas; report
that molecule workflows are unavailable rather than claiming full setup.
Missing formula sources, symlink paths, or divergent destinations stop
installation before formula copies. Resolve conflicts explicitly, then retry.

Report unavailable extensions before starting a workflow. Use `speckit-basic`
for a core-only workflow, or perform an unavailable extension step's described
work directly and record the fallback on its bead. Keep its deliverables and
review/verification checks; never treat a missing command as completed work.

Then call `speckit_start` for the spec and run the `speckit-specify` skill.
Workflow order is the poured molecule; `bd mol current <root>` is the current position.

## Start a spec without `speckit_start`

Where the tool is absent, do what it does, with `--json` on every `bd` call:

1. Find the run root: `bd query 'spec_id="<NNN-slug>"' --limit 0`, keeping the
   epics and molecules titled `speckit-basic`, `speckit-lean` or `speckit-feature`.
   With several, ask the user which one.
2. Reuse a `human_approvals` value of exactly `yes` or `no` recorded in the root's
   metadata. Otherwise ask the user "Require routine human approval checkpoints for
   this spec/run? Yes or no." (the `question` tool in OpenCode, `AskUserQuestion` in
   Claude Code), and wait for an explicit answer.
3. Set `autonomous` to the opposite of `human_approvals`.
4. With no root, pour one:
   `bd mol pour <profile> --var feature=<NNN-slug> --var autonomous=<yes|no>`.
   The profile defaults to `speckit-feature`; the root is `new_epic_id`.
5. Record the choice:
   `bd update <root> --spec-id <NNN-slug> --set-metadata spec_dir=specs/<NNN-slug> --set-metadata human_approvals=<answer> --set-metadata autonomous=<yes|no> --append-notes "Routine approvals: <answer>. Explicit user decision: <decision>"`.
6. Read it back with `bd show <root>`. Stop when the metadata differs.

Never add approval gates to an existing ungated run; start a new run instead. Changing
a gated run to ungated needs `speckit_start` with the user's separate consent; without
the tool, stop and report it.

With beads active, `specs/*/tasks.md` is read-only: `speckit-tasks`, the core
`speckit-converge` (it appends a convergence phase), and the bugfix, cleanup,
iterate, reconcile, and refine extensions all try to write it, and the write is
denied. Create child beads of the implement step instead.

`specify workflow` YAML is not installed. Do not invent extension ids.
Do not add speckit-gate or speckit-dag-hooks.

`build-formula` (authoring a new formula) lives in the beads plugin.
