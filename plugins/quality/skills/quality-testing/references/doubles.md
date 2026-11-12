# Test doubles

Read when a test needs a stand-in for a collaborator.

| Double | What it is | Use it for |
| --- | --- | --- |
| Real | The production implementation | The default, when it is fast and deterministic |
| Fake | A working, simplified implementation, such as an in-memory repository | A slow or external dependency behind an interface you own |
| Stub | Returns canned answers | Forcing a hard-to-reach condition: a timeout, a 500, a full disk |
| Spy | Records calls for later checks | A side effect that is the behavior, checked after the act |
| Mock | Set up with expected calls; fails on a mismatch | Only a call that is the behavior itself: "sends exactly one email", "a cache hit skips the fetch" |

## Rules

- Prefer the real implementation, then a fake, then a stub. Check interactions last.
- Never double the code under test, or the module's own internal collaborators.
- Double at boundaries you own. Wrap a third-party client in a thin adapter, test the
  adapter against the real service or a protocol-level stand-in such as a local HTTP
  mock server, and double the adapter everywhere else.
- Run one contract test suite against the fake and against the real implementation, so
  the fake cannot drift. Do not build a fake that you will not keep honest.
- Give each external operation its own function, so that a stub returns one shape with
  no branching (the `quality-code-design` skill's `test-first.md`).
- Do not add an interface, trait or protocol only so that a test can mock it. Inject the
  dependency at a real boundary.
- Assert the state or output that callers see. Interaction checks couple the test to the
  call graph; keep them for calls that are the behavior, and check only the arguments
  that callers rely on.
- Restore every patched module, spy and fake timer after the test.

Sources: [Mocks Aren't Stubs](https://martinfowler.com/articles/mocksArentStubs.html),
[Software Engineering at Google, ch. 13](https://abseil.io/resources/swe-book/html/ch13.html),
[Increase test fidelity by avoiding mocks](https://testing.googleblog.com/2024/02/increase-test-fidelity-by-avoiding-mocks.html).
