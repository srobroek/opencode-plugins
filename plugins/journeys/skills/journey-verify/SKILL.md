---
name: journey-verify
description: "Use when validating user journeys against the running product: drive each step, triage mismatches, record results."
metadata:
  opencode/autoinvoke: false
---

# journey-verify

Coordinate validation of one or more journeys. `FORMAT.md` in the journeys
directory is normative; read it plus `README.md` (config) and the target
`journey.md` files first.

Formula templates live in this skill's directory:
`formulas/*.formula.toml`.

## Beads formula provisioning

When the repository contains `.beads/`, run the `journey_install_formulas` tool
with `repoRoot` before validation. Without the tool, as in Claude Code, copy the
files from `formulas/` into `.beads/formulas/` yourself, never overwriting a file
that differs; in Claude Code they are in `${CLAUDE_SKILL_DIR}/formulas/`. The tool copies the package-owned formulas into
`.beads/formulas/` and leaves identical copies unchanged. If a destination
differs, stop and ask before rerunning with `force`.

Use `journey-step-agentic-verification` when the result needs no human gate.
Use `journey-step-human-verification` when a human must approve the triaged
result before evidence is recorded. Pour one molecule per selected journey
step; both formulas fan out runtime, definition, and acceptance checks before
triage.

## Who validates

Launch one `journey-validator` subagent (`journeys:journey-validator` in Claude
Code) per journey -- the complete validation
procedure (driving, evidence, triage, intent-gated amendment, run file,
findings) is owned by that agent's definition, not restated here. Respect
profile `exclusive: true`: serialize journeys sharing an exclusive profile;
the rest run in parallel.

- If the `journey-validator` agent is unavailable, validate inline one
  journey at a time: read the agent definition
  (`agents/journey-validator.md` in the journeys plugin package) and follow
  it verbatim.
- Never validate a journey your own context authored or amended in this
  conversation -- that is self-review. Hand it to a validator agent or
  report that first validation needs a fresh context.

## Coordinator duties

1. **Resolve scope and inputs.** Which journeys; for each, the profile from
   its `interfaces:` and README.md. Pass each validator: journey path,
   journeys dir, run mode (`full` or `changed-only(S…)`), profile name, and
   the repo's commit convention. Validators own only their journey and run
   files; the coordinator owns shared INDEX.md/TRACKER.md and commits.
2. **Aggregate.** Collect the validators' structured results. Local finding
   id assignment is single-writer: append returned finding payloads to
   TRACKER.md yourself in one pass. Explicitly assigned github-issues
   reporters may file directly.
3. **Promotion.** A `draft` journey may become `active` only when every
   step passed AND its Known gaps are all user-confirmed; note the
   promotion in the run file. Otherwise leave `status` untouched.
4. **Reindex once** per wave: `journeys_index` command `index` in OpenCode (or
   `python3 <journeys-dir>/journeys.py index <journeys-dir>` when using the copied helper), then lint.
5. **Commit** journeys-dir changes as
   `journey(J<id>): validate v<version> -- <result>` -- unless the caller or
   repo workflow forbids committing; then leave uncommitted and say so.

## Journeys and E2E specs

When a journey has a deterministic spec (its id is in the spec title or annotation; see
`journey-write`), the journey remains the source of truth.

- List journeys without a spec in the report, so the owner can decide which to automate.
- When a spec fails, re-validate its journey first. A journey that still passes means the spec
  has a stale selector or timing fault, so fix the spec. A journey that fails is a product
  regression.
- Never commit a healer rewrite of a spec without review.

## Close the loop

Report per-journey results, amendments (with evidence), findings filed.
Then offer next actions -- never auto-run them when invoked directly:
`journey-consolidate` when green with Δ entries or when `runs/` exceeds
README `runs_keep` (retention is enforced only at consolidation -- say so);
the fix loop per README `fix_loop` for regressions (`journey-campaign`
owns the autonomous loop).
