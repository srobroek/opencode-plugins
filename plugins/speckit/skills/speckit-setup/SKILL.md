---
name: speckit-setup
description: Bootstrap SpecKit end-to-end -- scaffold, extensions, formulas, gitignore. Use when setting up SpecKit, when the speckit-* skills are missing, or to initialize/enable SpecKit.
---

# SpecKit Setup

Idempotent one-time bootstrap. Call the `speckit_setup` tool rather than
re-implementing the steps by hand.

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
   unless `.specify/` exists. The integration defaults to `codex`, which writes
   the SpecKit commands as skills under `.agents/skills/`, where OpenCode finds them.
2. Only on explicit opt-in (`installAllowed=true`, after vetting), register the
   community catalog (`catalog.community.json`) as an install source. Never pass
   `--install-allowed` without it.
3. Install + enable the required extensions not yet installed: `agent-context`, `bugfix`, `cleanup`,
   `critique`, `fix-findings`, `iterate`, `qa`, `refine`, `retro`,
   `security-review`, `status-report`, `tinyspec`. Stop and report failure if
   any required CLI step fails.
4. `bd init --skip-hooks` if no workspace; copy every formula from the speckit
   plugin's `formulas/` directory into `.beads/formulas/`.
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

Then call `speckit_start` for the spec and run the `speckit-specify` skill.
Workflow order is the poured molecule; `bd mol current <root>` is the current position.

With beads active, `specs/*/tasks.md` is read-only: `speckit-tasks`, the core
`speckit-converge` (it appends a convergence phase), and the bugfix, cleanup,
iterate, reconcile, and refine extensions all try to write it, and the write is
denied. Create child beads of the implement step instead.

`specify workflow` YAML is not installed. Do not invent extension ids.
Do not add speckit-gate or speckit-dag-hooks.

`build-formula` (authoring a new formula) lives in the beads plugin.
