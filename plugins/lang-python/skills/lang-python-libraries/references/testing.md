# Python testing libraries

Choose tools by the behavior under test; `lang-python-testing` and `lang-python-quality` own test and check commands.
See [Python testing practice](../../lang-python-testing/references/practice.md) for idioms and tool selection, and [quality.md](quality.md) for lint, types, audit and docs.
Follow the install policy in `toolchain-languages` `concerns.md`: detect, recommend the install command, and ask before you add a dependency.

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `test-runner` | `pytest`; `--junitxml` for CI; `unittest.mock` for owned boundaries | >= 9.0 · 2026-10-27 · active | `uv pip show pytest` · `uv add --dev pytest` | unittest: dependency-free library suites | `pytest-xdist` (3.8, last release 2025-07-01) once files, ports and resources are isolated per worker | every-pr | Mocking every internal collaborator instead of testing behavior; parallel success as proof of race safety |
| `assertions` | Built-in: plain `assert` with pytest rewriting, `pytest.approx`, `pytest.raises` | - | Built-in | dirty-equals: partial or loose equality for dicts, dates and UUIDs (>= 0.11 · 2025-11-17 · beta, MIT); assertpy: the team wants a fluent style (2.36.0) | - | every-pr | PyHamcrest for new work (stale, last release 2023); `inline-snapshot` stays under `snapshot` |
| `watch` | `pytest-watcher` (`ptw`) | >= 0.6.3 · 2026-01-10 · beta | `uv pip show pytest-watcher` · `uv add --dev pytest-watcher` | None | `pytest-testmon` (2.3.0 · 2026-11-02 · beta) for affected-test selection; use both | on-demand | `pytest-watch` (dead since 2018); testmon as the sole gate |
| `property` | `hypothesis` | >= 6.100 · 2026-11-06 · active | `uv pip show hypothesis` · `uv add --dev hypothesis` | None | `hypothesis-jsonschema` to generate data from a JSON Schema; example tests for explicit regressions | every-pr | Random tests without preserved failing examples; HypoFuzz (commercial, source-available, stale) |
| `fuzz` | `atheris` for parsers and native-extension risk | >= 3.1 · 2026-06-17 · active | `uv pip show atheris` · `uv add --dev atheris` | hypothesis: pure-Python parsers, or macOS and aarch64 hosts where Atheris needs a source build | `hypothesis` for normal property suites and Atheris for hostile bytes | bounded-pr | Assuming one platform: PyPI wheels are manylinux x86_64 only, Python 3.11 to 3.14, Apple Clang lacks libFuzzer; `pythonfuzz` is dead; losing failing seeds |
| `fuzz-continuous` | Shared: clusterfuzzlite | - | Shared | oss-fuzz: accepted open-source projects, with the same Atheris targets | the OSS-Fuzz project builds the same Atheris targets as ClusterFuzzLite | scheduled | Running long campaigns in the PR job; discarding the corpus between runs |
| `mutation` | `mutmut` for selected critical code | >= 3.8 · 2026-10-28 · active | `uv pip show mutmut` · `uv add --dev mutmut` | cosmic-ray: Windows hosts or a configurable execution model; irradiate: pilot when a Stryker-schema report is wanted and a young tool is accepted | `cosmic-ray` with `cosmic-ray-to-mutation-elements-adapter` (third party) only when reports must be compared as Stryker-schema JSON | diff-pr + scheduled | Whole-project mandatory PR gate, mutmut needs `fork` so use POSIX or WSL and it exports no schema, so `quality_test_compare` cannot read it; `mutatest` and `mutpy` are stale; `pytest-gremlins` is young |
| `snapshot` | `syrupy` for external snapshots | >= 7.0 · 2026-11-16 · active | `uv pip show syrupy` · `uv add --dev syrupy` | inline-snapshot: small reviewable inline expectations | - | every-pr | Auto-accept in CI or unreviewed bulk updates; snapshotting whole object graphs |
| `component` | N/A: no UI component model | - | - | None | - | every-pr | - |
| `concurrency` | `pytest-run-parallel` runs each test in several threads | >= 0.10 · 2026-08-04 · beta | `uv pip show pytest-run-parallel` · `uv add --dev pytest-run-parallel` | None | A thread-sanitizer CPython build for native extension code, on free-threaded 3.14 builds | scheduled | `pytest-freethreaded` (abandoned); treating `pytest-xdist` as race evidence; async races belong in `anyio` tests with explicit synchronization |
| `coverage` | `coverage` branch coverage through `pytest-cov`; `diff-cover` for changed-line gaps | >= 7.17 · 2026-11-12 · active | `uv pip show coverage` · `uv add --dev coverage pytest-cov diff-cover` | None | `pytest-testmon` for local affected-test selection only (see `watch`) | every-pr | One universal percentage as correctness evidence; testmon as the sole gate |
| `benchmark` | `pytest-benchmark` | >= 5.3 · 2026-11-01 · active | `uv pip show pytest-benchmark` · `uv add --dev pytest-benchmark` | pytest-codspeed: managed regression tracking in CI | - | on-demand | Noisy shared-runner timings as hard guarantees; profilers live in `lang-python-profiling` |
| `flaky-order` | `pytest-randomly` for shuffled order, with the failing seed saved | >= 5.1 · 2026-11-08 · active | `uv pip show pytest-randomly` · `uv add --dev pytest-randomly` | pytest-repeat: repeat one suspect test (0.9.4, last release 2025-04-07) | `pytest-randomly` with `pytest-repeat` to reproduce a seed-dependent failure | scheduled | Blanket `pytest-rerunfailures`, which masks failures; quarantine without owner and expiry |
| `integration` | `testcontainers` | >= 4.15 · 2026-07-24 · active | `uv pip show testcontainers` · `uv add --dev testcontainers` | None | Platform-provided test service, or isolated deployed tests for IAM and cloud behavior | every-pr | SQLite or a mocked database as sole PostgreSQL evidence; unbounded container lifecycle |
| `contract` | Shared: contracts | - | Shared | pact-python 4.2.0: two or more services you own call each other and deploy independently (Pact Broker required) | - | every-pr | Pact as the only gate for public APIs; contract tests for a single deployable service |
| `api-schema` | Shared: schemathesis | - | Shared | None | `hurl` for a few hand-written requests | every-pr | Destructive generated tests against production; new archived Dredd adoption |
| `load` | `locust` for Python-authored scenarios | >= 2.47 · 2026-10-21 · active | `uv pip show locust` · `uv add --dev locust` | k6: shared cross-language suite, run as the Shared `k6` tool | - | scheduled | Treating k6 as a Python package; unapproved production load |

## Tradeoffs

### assertions

- **plain `assert`**: wins as the default, with pytest rewriting for diffs; costs loose or partial matching.
- **dirty-equals**: wins when only some fields, dates or UUIDs are fixed; costs a beta dependency.
- **assertpy**: wins when the team wants fluent chains; costs a second assertion style.

### fuzz

- **atheris**: wins when the target is a byte parser or native extension and the host is Linux x86_64; costs a source build elsewhere and no support for Python 3.15.
- **hypothesis**: wins when the code is pure Python and a property with shrinking is enough; costs coverage guidance and a long-running corpus.

### fuzz-continuous

- **clusterfuzzlite**: wins when the project runs fuzzing in its own CI on a schedule; costs the runner time and corpus storage.
- **oss-fuzz**: wins when the project is open source and accepted into the program; costs an application and public bug disclosure.

### mutation

- **mutmut**: wins when the project is on POSIX or WSL and mutants are selected per critical module; costs no schema export and no native Windows.
- **cosmic-ray**: wins when Windows is required or sessions need configuration; costs slower setup and unverified Python 3.14 support.
- **irradiate**: wins when schema output is required and the team accepts a young tool; costs stability (0.4.3).

### snapshot

- **syrupy**: wins when outputs are large and a reviewed snapshot file is easier to read than assertions; costs a separate file to review.
- **inline-snapshot**: wins when expectations are small and belong beside the test; costs noisy diffs for large values.

### benchmark

- **pytest-benchmark**: wins when you compare timings locally or in a stored baseline; costs noisy results on shared runners.
- **pytest-codspeed**: wins when CI needs managed regression tracking; costs a hosted service.

### flaky-order

- **pytest-randomly**: wins when order dependence and leaked global state are the suspects; costs a seed to carry through the report.
- **pytest-repeat**: wins when one test fails rarely and must be run many times; costs an unmaintained release line.

## Language-specific

| Topic | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Async tests | `anyio` pytest plugin for AnyIO code | `pytest-asyncio` for asyncio-only code | Competing async plugin auto modes; unsupported backend assumptions |
| Time | `time-machine` | `freezegun` for established portability needs | Assuming every native clock is frozen |
| HTTPX mocking | `respx` | `pytest-httpx` for fixture-oriented tests; actual ASGI app tests for route behavior | Mocked HTTP as proof of proxy, TLS or retry behavior |
| HTTP recording | `pytest-recording` with `vcrpy` | Explicit mocks for narrow unit tests | Unredacted secrets or PII in cassettes; replay is not live integration coverage |
| Factories | Plain functions with fresh deterministic defaults | `polyfactory` for typed models; `factory_boy` for ORM relationships | Random important fields without explicit values |
| AWS tests | `moto` and SDK stubs for fast tests | DynamoDB Local, SAM local, LocalStack or isolated cloud tests as appropriate | Emulator success mistaken for production concurrency, IAM or service semantics |
| Telemetry | `opentelemetry-sdk` in-memory exporter and readers | Export-pipeline integration tests for deployment behavior | Asserting random trace IDs or timestamps; SDK globals shared between tests |

## Rules

- Keep tests deterministic, own fixtures and resources, and test real storage and protocol boundaries when those semantics matter.
- Assert contracts, state changes and failures; make retries, cancellation, timeouts, tenant authorization and duplicate delivery visible in the suite.
- Review snapshots and cassettes and redact before committing. Shard deterministically, record first-attempt failures, and use retries diagnostically rather than to erase failures.
- Run bounded fuzz smoke in CI and longer campaigns on a schedule. Preserve failing seeds; quarantine needs an owner and expiry.
- Memory safety has no row here: Python is managed. For native extensions see the `memory-safety` row in [quality.md](quality.md).

## Sources

- [pytest](https://docs.pytest.org/), [AnyIO tests](https://anyio.readthedocs.io/en/stable/testing.html), [Hypothesis](https://hypothesis.readthedocs.io/), [hypothesis-jsonschema](https://github.com/python-jsonschema/hypothesis-jsonschema)
- [time-machine comparison](https://time-machine.readthedocs.io/en/latest/comparison.html), [Syrupy](https://github.com/syrupy-project/syrupy), [inline-snapshot](https://15r10nk.github.io/inline-snapshot/)
- [RESPX](https://github.com/lundberg/respx), [pytest-httpx](https://github.com/Colin-b/pytest_httpx), [recording](https://github.com/kiwicom/pytest-recording), [VCR](https://github.com/kevin1024/vcrpy)
- [Polyfactory](https://github.com/litestar-org/polyfactory), [Testcontainers](https://github.com/testcontainers/testcontainers-python), [AWS testing](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html)
- [Pact](https://pact-foundation.github.io/pact-python/), [Locust](https://docs.locust.io/), [pytest-run-parallel](https://github.com/Quansight-Labs/pytest-run-parallel)
- [mutmut](https://github.com/boxed/mutmut), [cosmic-ray](https://github.com/sixty-north/cosmic-ray), [Atheris](https://github.com/google/atheris), [OSS-Fuzz Python](https://google.github.io/oss-fuzz/getting-started/new-project-guide/python-lang/), [ClusterFuzzLite](https://google.github.io/clusterfuzzlite/)
- [benchmarks](https://pytest-benchmark.readthedocs.io/), [Coverage](https://github.com/coveragepy/coveragepy), [diff-cover](https://github.com/Bachmann1234/diff_cover), [Package version registry](https://pypi.org/)
