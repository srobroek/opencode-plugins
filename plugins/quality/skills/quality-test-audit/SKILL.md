---
name: quality-test-audit
description: "Use to audit, prune or speed up a test suite on demand: flaky, slow, duplicate, obsolete and never-failing tests."
---

# Test audit

Audit one test scope, then prune, purge, fix and speed it up without losing protection.
Steps 1 to 5 change nothing in the repository. Edit tests or code only after step 6
approves a plan. The rules for good tests, the budget and maintenance are in the
`quality-testing` skill; each language's tools are in the `lang-<language>-testing`
skill's `references/practice.md`.

## Workflow

1. **Scope.** When the user names no scope, ask for one: a directory, package or module,
   the tests that a branch or diff touches, or the whole suite. Split a large suite into
   one package per audit. Then:
   - Work on a branch or a worktree with a clean tree, and record `git rev-parse HEAD`.
   - Find the test command, the runner, and the coverage and mutation tools from the
     project's configuration and the language's `practice.md`.
   - Keep reports and scratch files in the OpenCode temp directory, not the repository.
2. **Baseline.** Measure the scope before you judge it ([evidence.md](references/evidence.md)):
   - Repeat the scoped run 5 times in random order through the shell, with one JUnit
     report per run in the OpenCode temp directory, then pass the report paths and the
     exit codes to `quality_test_summarize`. Use 20 runs for a suspected flaky test.
   - Write a coverage report with branches, and per-test coverage where the runner has
     it.
   - Run mutation testing on the files under audit, and keep the report as the
     baseline.
   Record the gaps: a runner without JUnit output, no mutation tool, a scope too slow
   to mutate.
3. **Classify.** Check each test against [catalog.md](references/catalog.md). For each
   candidate, record the test, the class, the evidence, the behavior it claims to protect,
   and the test that keeps that protection.
4. **Plan.** Give each candidate one action: delete, merge into a parametrized test,
   rewrite through the public interface, move to a lower level, fix the flake at its
   cause, quarantine, speed up, or keep. Use the plan table in
   [report.md](references/report.md). A delete or a merge names the test that keeps the
   protection and the mutants that prove it.
5. **Challenge.** Give the plan and its evidence to `refactor-challenger` when it is
   installed, otherwise to `adversarial-challenger`. Ask it to show, for each item, that
   the change loses protection or that the evidence does not support it. Drop or
   downgrade each refuted item.
6. **Approve.** Show the plan table and ask with the `question` tool: apply all, apply a
   selection, or apply none. Without a person to ask, report the plan and stop.
7. **Apply in batches.** One kind of change in one area per batch, one commit per batch.
   Apply it yourself or through the `coder` subagent. After each batch:
   - the scoped suite passes in repeated random-order runs;
   - `quality_test_compare` against the baseline shows no lost protection for coverage
     and for mutants. Each entry it lists is either an equivalent or irrelevant mutant
     that the user approves, or the batch is reverted.
8. **Report.** Use the report template in [report.md](references/report.md): before and
   after counts, runtime, flaky tests, coverage and mutation score, each batch with its
   commit, each approved loss, the gaps, and the follow-ups.

Without the `quality_test_summarize` and `quality_test_compare` tools, run the commands
in [evidence.md](references/evidence.md) through the shell, and read the reports by hand.
Say in the report that the comparison was manual.

## Rules

- MUST keep steps 1 to 5 read-only. Running tests and writing reports to the temp
  directory is allowed.
- MUST NOT weaken an assertion, edit an expected value, or update a snapshot to make a
  test pass.
- MUST prove each delete or merge with the test that keeps the protection and a mutation
  comparison with no unexplained lost protection. Without a mutation tool, record the gap
  and get explicit approval for each deletion.
- MUST treat "never fails" as a hypothesis until a mutation run or a forced red shows that
  the test detects nothing.
- MUST NOT delete a characterization test without a behavior test that replaces it, or a
  test of a requirement such as an audit, security or compatibility contract.
- MUST count a test that passes only on a retry as flaky, not as a pass. Quarantine only
  with a tracked issue, an owner and an expiry date.
- MUST commit each batch separately so that each one can be reverted.
