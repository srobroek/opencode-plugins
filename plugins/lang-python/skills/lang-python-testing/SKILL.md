---
name: lang-python-testing
description: Use to write or fix Python tests (pytest fixtures, parametrize, monkeypatch, hypothesis property tests, coverage).
metadata:
  opencode/autoinvoke: false
---

# Python Testing

Sources: [pytest](https://docs.pytest.org/en/stable/) (9.x: [fixtures](https://docs.pytest.org/en/stable/how-to/fixtures.html), [parametrize](https://docs.pytest.org/en/stable/how-to/parametrize.html), [good practices](https://docs.pytest.org/en/stable/explanation/goodpractices.html)), [Hypothesis](https://hypothesis.readthedocs.io/), [pytest-cov](https://pytest-cov.readthedocs.io/), [coverage.py](https://coverage.readthedocs.io/).

What to test and which double to use is the `quality-testing` skill. This skill is the
pytest and Hypothesis idioms. Follow the project's existing tests, `conftest.py` and
`[tool.pytest.ini_options]` first. Run commands through the project runner
(`uv run python -m pytest …`), as in `lang-python-quality`.

## Layout and config

```toml
[tool.pytest.ini_options]
testpaths = ["tests"]
addopts = ["--import-mode=importlib", "--strict-markers", "--strict-config"]
xfail_strict = true
```

`--import-mode=importlib` is what the pytest docs recommend for new projects: tests
import the installed package (with a `src/` layout, see `lang-python-packaging`), not
whatever sits in the working directory, and test files need no `__init__.py`.
`--strict-markers` turns a mistyped `@pytest.mark.slwo` into an error.

## Fixtures

```python
@pytest.fixture
def repo(tmp_path: Path) -> Iterator[Repo]:
    repo = Repo.create(tmp_path / "db.sqlite")
    yield repo                    # code after yield is teardown, run even when the test fails
    repo.close()

def test_saves_order(repo: Repo) -> None:
    repo.save(an_order(total=0))
    assert repo.count() == 1
```

- Use built-ins before writing your own: `tmp_path`, `monkeypatch` (`setenv`,
  `setattr`, `chdir`, undone after the test), `capsys`, `caplog`.
- Default to function scope. Widen to `module` or `session` only for expensive,
  read-only resources; a mutable session fixture leaks state between tests.
- Shared fixtures go in the nearest `conftest.py`; no import needed. Do not use
  `autouse=True` for anything a reader would need to know about.
- `monkeypatch.setattr("billing.client.send", fake_send)` patches where the name
  is looked up, not where it is defined; `from x import send` binds a copy.

## Parametrize

```python
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        pytest.param("5m", timedelta(minutes=5), id="minutes"),
        pytest.param("", None, id="empty", marks=pytest.mark.xfail(raises=ValueError)),
    ],
)
def test_parse_duration(raw: str, expected: timedelta | None) -> None:
    assert parse_duration(raw) == expected
```

Give each case an `id` so a failure reads `test_parse_duration[empty]`. Assert errors
with `with pytest.raises(ValueError, match=r"empty duration"):`; `match` is a regex
searched in the message.

## Property tests with Hypothesis

```python
from hypothesis import example, given, strategies as st

@given(st.timedeltas(min_value=timedelta(0), max_value=timedelta(days=365)))
@example(timedelta(0))                       # a regression found earlier, kept forever
def test_duration_round_trips(value: timedelta) -> None:
    assert parse_duration(format_duration(value)) == value
```

- Assert invariants (round trip, idempotence, ordering, "never raises anything but
  `ValueError`"), not values copied from the implementation.
- Build domain objects with `st.builds(Order, total=st.decimals(min_value=0, places=2))`
  and filter sparingly; prefer strategies that only generate valid inputs over
  `assume()` that rejects most of them.
- Hypothesis shrinks a failure to a minimal example and stores it in
  `.hypothesis/` (gitignore it). Copy the shrunk example into `@example(...)` so it
  stays a regression test in CI.
- Register a profile for CI with more examples and no deadline flakes:
  `settings.register_profile("ci", max_examples=500, deadline=None)` in
  `conftest.py`, selected with `pytest --hypothesis-profile=ci`.

## Running and coverage

```sh
python -m pytest -x                          # stop at the first failure
python -m pytest --lf -x                     # rerun last failures only
python -m pytest tests/test_orders.py::test_saves_order -vv
python -m pytest -n auto                     # pytest-xdist, when installed; tests must not share files or ports
python -m pytest --cov=billing --cov-branch --cov-report=term-missing
```

Read the `Missing` column for untested behavior; `--cov-fail-under` belongs in config
only when the project already gates on it. Async tests need the plugin the project
uses (`pytest-asyncio` with `@pytest.mark.asyncio` or `asyncio_mode = "auto"`, or
`anyio`'s `@pytest.mark.anyio`). For HTTP clients, stub the transport
(`httpx.MockTransport`, or `respx` / `responses` when the project already uses them),
not the client class.
