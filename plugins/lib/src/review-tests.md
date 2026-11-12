<!-- The test-change rules that code-reviewer and both pr-reviewer copies share. scripts/build.ts inlines
this file where an agent source in agents.src/ has `{{include review-tests}}`. The quality-testing
skill's references/review-tests.md is the long form with the checklist; keep the two in step. The
pr-reviewers cannot read skill references, so these lines must stand alone. Every includer pays for
them on every request: keep the file near 300 tokens. -->
<!-- part: rules -->
MUST Map the test diff to the code diff. Classify each code hunk: new behavior, bug fix, changed requirement, refactor, removal, or no behavior. Expect a test for each new or changed behavior, a regression test for each bug fix that fails without the fix, no assertion changes in a refactor, and tests, fixtures and snapshots deleted with removed behavior.
MUST Treat as blocking: changed behavior or a bug fix with no test that fails without it, in code that has tests; a new test that only checks that removed code, an export or a file is gone; and tampering that hides a behavior change or loses protection with no stated requirement: a loosened assertion, an expected value edited to match new output, a test skipped or deleted with no remaining test that gives its protection, an added retry, or snapshots updated without a reviewed diff.
MUST Treat as non-blocking: tests or fixtures left for removed behavior; tests of private helpers, call order or internal mocks; expected values that repeat the code; near-duplicate tests and copied cases. Pruning that keeps protection and a tracked quarantine that still runs are maintenance, not tampering.
