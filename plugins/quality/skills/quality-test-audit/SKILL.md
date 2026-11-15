---
name: quality-test-audit
description: "Use to audit, clean up, fix or strengthen a test suite on demand: flaky, slow, duplicate, obsolete and missing tests."
---

# Test audit

Audit one test scope and recommend what to drop, merge, rewrite, simplify, add, speed up
and clean up. Then apply the approved changes without losing protection. Steps 1 to 5 change
nothing in the repository. Edit tests or code only after step 6 approves a plan. The rules for good tests, the budget and maintenance are in the
`quality-testing` skill; each language's tools are in the `lang-<language>-testing`
skill's `references/practice.md`.

## Workflow

1. **Scope.** When the user names no scope, ask for one: a directory, package or module,
   the tests that a branch or diff touches, or the whole suite. Split a large suite into
   one package per audit. Then:
   - Work on a branch or a worktree with a clean tree, and record `git rev-parse HEAD`.
   - Find the test command, the runner, and the coverage and mutation tools from the
     project's configuration and the language's `practice.md`.
   - List every runner that executes tests in the scope, including files outside the
     main runner such as `node --test` scripts or a browser suite, so none is skipped
     silently.
   - Keep reports and scratch files in the OpenCode temp directory, not the repository.
2. **Baseline.** Measure the scope before you judge it ([evidence.md](references/evidence.md)):
   - Run the scope once from a clean checkout without the project's build step, to find
     hidden prerequisites. A conditional skip (`skipIf`) that hides a failure is a finding.
   - Repeat the scoped run through the shell with one JUnit report per run in the OpenCode
     temp directory: 3 runs of each kind of random order (file order and test order within
     a file, which catch different dependences) plus 3 in default order. Pass the report
     paths, the exit codes and the `modes` to `quality_test_summarize`, which separates
     order-dependent tests (fail only in shuffled runs) from flaky ones. Use 20 runs for a
     suspected flaky test.
   - Reproduce a suspected timing flake under deliberate CPU load (busy loops or parallel
     workers) as well as idle: some only fail under load. Label each flake load-related
     or order-related.
   - Record the machine load. On a shared or busy machine wall time is noise: report the
     summed test duration and user CPU beside it.
   - Write a coverage report with branches, and per-test coverage where the runner has
     it.
   - Run mutation testing on the files under audit, and keep the report as the
     baseline. When it cannot run on the scope (a runner pool requirement, a bundler step
     that breaks the mutation tool), use hand-made forced faults as the evidence,
     injected only into a disposable copy of the repository in the OpenCode temp
     directory (never the working tree), discarded afterwards. Record that.
   - Read the output as evidence: thousands of identical stderr lines, a huge JUnit file
     or connection-refused lines are findings (the summary flags noisy runs).
   Record the gaps: a runner without JUnit output, no mutation tool, a scope too slow
   to mutate.
3. **Classify.** Check each test against [catalog.md](references/catalog.md). For each
   candidate, record the test, the class, the evidence, the behavior it claims to protect,
   and the test that keeps that protection. Then look for weak spots, the catalog's
   Strengthen group: surviving mutants and uncovered branches of public behavior. Read
   the suite as a whole too: its fixtures, conventions, runner settings and CI lanes.
4. **Plan.** Give each candidate one action: delete, merge into a parametrized test,
   rewrite through the public interface, simplify, move to a lower level, fix the flake at
   its cause, quarantine, speed up, extend an existing test, add a test, or keep. Use the plan
   table in [report.md](references/report.md). A delete or a merge names the test that
   keeps the protection and the mutants that prove it. An added test names the behavior,
   the mutant or branch it covers, and why no existing test can be extended. Write the
   suite-level recommendations in the report's Recommendations section.
5. **Challenge.** Give the plan and its evidence to `refactor-challenger` when it is
   installed, otherwise to `adversarial-challenger`. Ask it to show, for each item, that
   the change loses protection or that the evidence does not support it. Drop or
   downgrade each refuted item.
6. **Approve.** Show the plan table and the recommendations, and ask with the
   `question` tool: apply all, apply a selection, or report only. Without a person to ask,
   report the plan and stop.
7. **Apply in batches.** Before the first batch, compare `git rev-parse HEAD` with the
   commit from step 1. When HEAD moved, recheck each plan item against the merged
   changes and re-measure before applying; drop the items that no longer hold. One kind of change in one area per batch, one commit per batch,
   removals and additions in separate batches. Apply it yourself or through the `coder`
   subagent. After each batch:
   - the scoped suite passes in repeated random-order runs;
   - `quality_test_compare` against the baseline shows no lost protection for coverage
     and for mutants. Each entry it lists is either an equivalent or irrelevant mutant
     that the user approves, or the batch is reverted;
   - each added test failed first against a forced fault, and now kills the mutant or
     covers the branch it was written for.
8. **Report.** Use the report template in [report.md](references/report.md): before and
   after counts, runtime, flaky tests, coverage and mutation score, each batch with its
   commit, each approved loss, the recommendations not applied, the gaps, and the
   follow-ups.

`quality_test_summarize` also counts timeout and assertion failures per test, and gives the
size, stderr lines and summed test time of each report.

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
- MUST re-measure a stale plan: when HEAD moved since the baseline, recheck every item
  against the merged changes before applying it.
- MUST prove a speed-up that changes production code, such as an option that skips an
  expensive check in a tested function: identical output on real data, and a partial
  mode that is visibly distinct, so it cannot pass as the full path.
- MUST commit each batch separately so that each one can be reverted.
- MUST add a test only for a behavior that a surviving mutant, an uncovered public branch
  or a reported bug shows is unprotected. Extend an existing test or a parametrized case
  list before adding a new test, and follow the `quality-testing` rules: one behavior,
  the public interface, expected values from the requirement. Never add a test to raise
  coverage alone.
