# Python testing practice

Checked 2026-11-12.

Python idioms and tool choices for small, behavior-focused suites using `pytest` `9`.
Use `quality-testing` for what to test, the behavior budget, same-change maintenance,
and review rules; the parent skill keeps runner commands and configuration.

## Layout and naming

Do follow the existing layout; otherwise use `tests/` grouped by package responsibility,
with `test_*.py` files and names such as `test_expired_token_is_rejected`.
Keep integration tests separate when their resource lifecycle differs.
Do not name tests after private methods or introduce a second layout convention.
Register custom marks and use strict marker checking. Existing `unittest.TestCase`
suites can stay; their methods do not support ordinary fixture-argument injection
or `pytest` parametrization. Prefer functions for new fixture-rich tests.

## One behavior per test

Do show setup, one principal action, and one logical outcome with plain `assert`.
Several assertions can describe that outcome; assertion rewriting gives useful diffs.
Do not combine unrelated scenarios or replace visible expectations with generic helpers.

```python
def test_transfer_preserves_funds():
    source, target = Account(balance=20), Account(balance=5)
    transfer(source, target, amount=7)
    assert (source.balance, target.balance) == (13, 12)
```

Use `pytest.raises(ValueError, match=r"empty duration")` for a promised error.
Do not catch every exception and treat it as success.

## Parametrize instead of copying

Do combine cases with the same setup, action, and assertion shape; use behavioral IDs.
Do not build a table with mode flags and conditional assertions. Keep distinct
resource setups and error contracts in separate tests.

```python
@pytest.mark.parametrize(
    ("raw", "expected"),
    [pytest.param("5m", 300, id="minutes"),
     pytest.param("0s", 0, id="zero")],
)
def test_duration_in_seconds(raw, expected):
    assert parse_seconds(raw) == expected
```

## Fixtures and builders

Do start fixtures in the test module, then move fixtures used by several modules to the nearest
`conftest.py`; fixtures are available to that directory and subtree without imports.
Use function scope for mutable state. Wider class, module, package, or session scope
is for resources whose reuse is safe; isolate each test's mutations even on expensive services.
Pair each state-changing resource acquisition with cleanup, often using a yield fixture.
Do not make a root `conftest.py` a setup hub, hide behavior in autouse fixtures,
or share mutable session data.

Do use `tmp_path` for a per-test `Path`, `monkeypatch` for automatically restored
environment/attribute changes, `capsys` for stdout/stderr, and `caplog` for log records.
Assert logs only when they are contractual; prefer record fields to incidental formatting.

```python
def an_order(*, total=10, status="pending"):
    return Order(total=total, status=status)

def test_free_order_is_accepted():
    assert accept(an_order(total=0)).status == "accepted"
```

Do return a fresh object with deterministic valid defaults. Use `polyfactory` for
model-heavy typed data or `factory_boy` for rich object/ORM relationships only when
plain functions become awkward. Override every behavior-bearing field explicitly.
Do not let generated dates or random important fields decide the expected result.

## Doubles

Do use real deterministic collaborators first, then small faithful fakes. Mock owned
boundaries when the external side effect or hard-to-reach failure is the behavior.
Use `unittest.mock` with `autospec=True` or `create_autospec(..., spec_set=True)`;
use `AsyncMock` for awaitable boundaries. Patch where a name is looked up.
Do not use unrestricted `MagicMock` trees or assert private call choreography.

```python
with patch("billing.checkout.send_receipt", autospec=True) as send:
    checkout(Order(id="order-1", total=10, status="pending"))
    send.assert_called_once_with(order_id="order-1")
```

Here receipt delivery is the contract, not an internal implementation detail.
`pytest-mock` is optional cleanup/spy convenience, not a reason to mock more code.
For HTTPX, choose `respx` routing or `pytest-httpx` response fixtures, not both by default.
Exercise actual request construction and response/error translation; fail unexpected requests.
Do not mock the adapter's own methods or mistake a mocked response for TLS/proxy evidence.

## Async, time and concurrency

Do choose `pytest-asyncio` for asyncio-specific code, or the AnyIO pytest plugin for
backend-portable/task-group code. Set supported backends explicitly; do not enable
both plugins' competing auto modes. Await operations and observe cancellation/cleanup.
Inject clocks and synchronize with events or barriers instead of sleeps.
Do not assert tight wall-clock durations. Use `pytest-timeout` only as a hang guard;
its termination can bypass graceful cleanup.

Add `pytest-xdist` only after isolation is established; files, ports, and external
resources must be independent across workers. Do not use parallel success as proof
of production race safety; test meaningful interleavings explicitly.

## Property tests

Do use `hypothesis` for an independent invariant, round trip, idempotence, or model
that replaces repetitive examples. Keep contractual edge cases and important shrunk
failures as `@example` values or named regression tests.

```python
@given(st.binary())
@example(b"\x00")
def test_wire_bytes_round_trip(value):
    assert decode(encode(value)) == value
```

Do generate valid domain values directly, use local/CI profiles, and retain the example
database as a cache. Create mutable state per generated example: a function-scoped
fixture is not reset for each Hypothesis example. Do not reproduce the implementation
as the oracle or suppress health checks instead of correcting shared setup.

## Snapshots

Do use `syrupy` for external snapshots or `inline-snapshot` for small inline values
when a stable public projection is easier to review than individual assertions.
Normalize incidental IDs/times/order without hiding contractual differences.
Do not snapshot entire object graphs, duplicate full equality with a snapshot,
or automatically update in CI. Review every update as a changed expectation.

## Fuzzing, mutation testing and coverage

Do target `mutmut` `3` at critical changed pure logic; use its incremental results and
test selection for feedback, then periodically rerun without stale results. It needs
`fork`; check platform support. Investigate meaningful surviving mutants, not a universal score.
Use `Atheris` for hostile byte parsers/native-extension crash risks: bound CI campaigns,
run longer scheduled campaigns, and preserve minimized failures as regression inputs.
Do not start with whole-project mutation or fuzzing when ordinary properties suffice.

Do measure branch coverage with `pytest-cov`/`coverage.py`, and use `diff-cover` on
coverage XML for changed-line gaps. Affected-test selection is not changed-line coverage.

```sh
python -m pytest --cov=billing --cov-branch --cov-report=xml
diff-cover coverage.xml --compare-branch=origin/main
```

Use the project's actual comparison base. `pytest-testmon` can accelerate local
affected-test runs but must not be the sole correctness gate. Do not infer assertion
strength from execution coverage or add vacuous tests to reach a percentage.

## Flaky tests

Do diagnose repeated runs and shuffled order with `pytest-randomly`; save its failing
seed. Check leaked globals, clocks, random data, port collisions, and task cleanup.
Use repetition tooling only after checking compatibility with the pinned runner;
`pytest-flakefinder` compatibility with `pytest` `9` is not established here.
Do not install blanket retries. Keep retries off by default and record first failures.
Quarantine needs an issue, owner, expiry, and a separate reporting/failing lane;
do not silently delete the scenario or permanently skip it.

## Bad tests and fixes

See the `quality-testing` skill's `references/bad-tests.md` for language-neutral pairs covering removal checks, copied oracles, call-order mocks, side channels, copies instead of parameters, logic in tests, sleeps, assertion-free tests, eager tests, mystery guests, type re-checks, tampering, and whole-object snapshots.

### Hidden autouse state

Bad:

```python
@pytest.fixture(autouse=True)
def sandbox(monkeypatch):
    monkeypatch.setenv("PAYMENT_MODE", "sandbox")

def test_checkout_uses_sandbox():
    assert checkout().gateway == "sandbox"
```

The outcome depends on an environment change that the test never requests.

Fix:

```python
@pytest.fixture
def sandbox(monkeypatch):
    monkeypatch.setenv("PAYMENT_MODE", "sandbox")

def test_checkout_uses_sandbox(sandbox):
    assert checkout().gateway == "sandbox"
```

### Patching the wrong name without a spec

Bad:

```python
from unittest.mock import MagicMock, patch
from payments import checkout

def test_payment_is_declined():
    with patch("payments.client.charge", new=MagicMock()) as charge:
        charge.return_value = "declined"
        assert checkout.pay(10) == "declined"
```

If `payments.checkout` imports `charge` directly, this patches the unused definition while a bare `MagicMock` accepts nonexistent attributes.

Fix:

```python
from unittest.mock import patch
from payments import checkout

def test_payment_is_declined():
    with patch("payments.checkout.charge", autospec=True) as charge:
        charge.return_value = "declined"
        assert checkout.pay(10) == "declined"
```

### Catching any exception

Bad:

```python
def test_empty_duration_is_rejected():
    with pytest.raises(Exception):
        parse_seconds("")
```

An unrelated exception can satisfy this assertion without the promised validation error.

Fix:

```python
def test_empty_duration_is_rejected():
    with pytest.raises(ValueError, match=r"^empty duration$"):
        parse_seconds("")
```

## Do not write

Do delete obsolete tests and unused fixtures with removed behavior. Refuse tests
whose only claim is `pytest.raises(ImportError)` around an import of a removed module
or `assert not hasattr(mod, "old_fn")`. Test a forbidden user outcome instead when needed.
Do not re-check type hints using `get_type_hints`, annotations, or signature snapshots
when the type checker already enforces that contract. Runtime validation is different.
Also omit trivial getter tests, private-helper tests, copied production calculations,
and another level's duplicate scenario without a distinct risk. Explicit packaging,
API compatibility, audit, or security requirements can justify targeted contract checks.

## Defaults by use case

Add plugins only for a demonstrated need, not as a standard bundle.

| Use case | Default |
| --- | --- |
| Pure logic | `pytest` examples/parametrize; `hypothesis` for independent invariants |
| I/O adapters | `tmp_path`, `monkeypatch`, real narrow integration; owned fake/autospec where needed |
| HTTP handlers | Execute actual handler with framework test client; fake outbound services |
| Async/concurrency | `pytest-asyncio` or AnyIO plugin; isolated resources and explicit synchronization |
| CLI | Direct entry function with `capsys`/`caplog`; small subprocess smoke test |
| Parsers | Named malformed/boundary cases and `hypothesis`; `Atheris` for hostile-byte risk |
| CI lane | Full suite, type checker, branch coverage and diff review; occasional shuffle, targeted mutation |

## Sources

- [pytest fixtures](https://docs.pytest.org/en/stable/how-to/fixtures.html), [layout](https://docs.pytest.org/en/stable/explanation/goodpractices.html), [parametrize](https://docs.pytest.org/en/stable/how-to/parametrize.html)
- [unittest.mock](https://docs.python.org/3/library/unittest.mock.html), [AnyIO testing](https://anyio.readthedocs.io/en/stable/testing.html)
- [Hypothesis API](https://hypothesis.readthedocs.io/en/latest/reference/api.html), [Syrupy](https://pypi.org/project/syrupy/), [inline-snapshot](https://pypi.org/project/inline-snapshot/)
- [Polyfactory](https://pypi.org/project/polyfactory/), [factory_boy](https://pypi.org/project/factory-boy/), [RESPX](https://pypi.org/project/respx/), [pytest-httpx](https://pypi.org/project/pytest-httpx/)
- [mutmut](https://pypi.org/project/mutmut/), [Atheris](https://pypi.org/project/atheris/), [coverage branches](https://coverage.readthedocs.io/en/7.17.2/branch.html), [diff-cover](https://pypi.org/project/diff-cover/)
- [pytest plugins and versions](https://pypi.org/project/pytest/): [xdist](https://pypi.org/project/pytest-xdist/), [randomly](https://pypi.org/project/pytest-randomly/), [cov](https://pypi.org/project/pytest-cov/), [asyncio](https://pypi.org/project/pytest-asyncio/), [mock](https://pypi.org/project/pytest-mock/), [timeout](https://pypi.org/project/pytest-timeout/), [testmon](https://pypi.org/project/pytest-testmon/)
