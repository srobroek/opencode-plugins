# Test budget

Read when a behavior collects many tests, when an agent or a generator wrote the tests,
or when the suite grows faster than the code.

## A budget per behavior

- Each behavior gets one canonical test, plus one test per boundary or error class that
  can fail in a different way. There is no numeric cap: each extra test names the risk
  that it protects and the other tests do not.
- Before you add a test, search the existing tests for the behavior. Extend a
  parametrized case list, update the test that is there, or add nothing.
- Parametrize cases that share setup, action and assertion shape. Keep tests separate
  when the setup or the assertion differs. A case list with mode flags and conditional
  assertions is several tests in one.
- Delete a test when another test already gives its protection. Two tests that run the
  same code are not always redundant: a library's contract test and a consumer's test
  can cover the same lines for different reasons.

## Signs of sprawl

- Many tests make the same claim, copied with different literals.
- Tests break on refactors that keep behavior.
- Large snapshots of incidental output.
- Mock setup longer than the test, or mocks of the module's own collaborators.
- The same scenario at the unit, integration and end-to-end level.
- Tests that run code but would not fail if it returned a wrong value. A mutation run
  finds them ([signals.md](signals.md)).
- Hooks, flags or exports in production code that only tests use.

## Tests from agents and generators

What studies of generated tests found:

- Meta's TestGen-LLM (FSE 2024) kept a generated test only when it built, passed five
  repeated runs and raised line coverage. In its Instagram evaluation, 75% of test
  classes got a candidate that built, 57% one that passed reliably and 25% one that
  raised coverage. Engineers still rejected tests without assertions, tests of trivial
  getters and tests of unimportant files.
- 47.4% of 194 Copilot-generated Python tests had at least one test smell (SBES 2024).
  Duplicated assertions, empty tests, magic numbers, assertion roulette and calls to
  APIs that do not exist recur in other studies.
- Coverage-driven generators can discard a failing test that reveals a real bug, and
  keep a passing test that pins the bug (Waterloo preprint, 2024).

Rules for every test author, human or agent:

1. Write the behavior list first. Each test maps to one item.
2. Watch every new test fail for the expected reason. For a test of code that already
   works, introduce a controlled fault and confirm that the test fails. Then restore the
   code and check the restore with a diff (the `quality-code-design` skill's
   `test-first.md`).
3. Keep a test only when it protects a named behavior, passes on repeated runs and
   fails for a plausible wrong implementation. The best evidence is a mutant that the
   test kills and no other test kills. Added coverage supports a test; it is not the
   reason to keep it.
4. A failing generated test is a question about the requirement. Check it against the
   requirement before you discard it or weaken it.
5. Remove duplicates before hand-off. Report what each test protects, not how many tests
   you added.

## Test generators

TestGen-LLM and Cover-Agent add tests until coverage rises; they do not prune the
existing suite. Do not make a coverage-driven generator the default source of tests.

- Meta described TestGen-LLM in a paper. No public distribution of the tool was found
  on 2026-11-12.
- Qodo's Cover-Agent (`qodo-cover`) README has said that the project is no longer
  maintained since 2025-06-15. Its latest release is `0.3.10` (2025-05-21), and its
  licence is AGPL-3.0.
- Apply the rules above to every generated test, whatever tool or agent wrote it.

Sources: [TestGen-LLM, arXiv 2402.09171](https://arxiv.org/abs/2402.09171),
[Copilot test smells, SBES 2024](https://sol.sbc.org.br/index.php/sbes/article/view/30398),
[Siddiq et al., EASE 2024](https://s2e-lab.github.io/preprints/ease24-preprint.pdf),
[Ouedraogo et al., arXiv 2407.00225](https://arxiv.org/html/2407.00225v4),
[Coverage-guided generators and bugs, arXiv 2412.14137](https://arxiv.org/html/2412.14137),
[qodo-cover README](https://github.com/qodo-ai/qodo-cover/blob/main/README.md#news),
[Canon TDD](https://newsletter.kentbeck.com/p/canon-tdd),
[The Practical Test Pyramid: avoid test duplication](https://martinfowler.com/articles/practical-test-pyramid.html#AvoidTestDuplication).
