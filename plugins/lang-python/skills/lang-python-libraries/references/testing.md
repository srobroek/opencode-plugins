# Python testing libraries

Choose tools by the behavior under test; `lang-python-testing` and `lang-python-quality` own test and check commands.
See [Python testing practice](../../lang-python-testing/references/practice.md) for idioms and tool selection.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Unit tests | `pytest` `9`; `unittest.mock` for owned boundaries | `unittest` in dependency-free library suites | Mocking every internal collaborator instead of testing behavior |
| Async tests | `anyio` `4` pytest plugin for AnyIO code | `pytest-asyncio` `1` for asyncio-only code | Competing async plugin auto modes; unsupported backend assumptions |
| Property tests | `hypothesis` `6` | Example tests for explicit regression cases alongside properties | Random tests without preserved failing examples |
| Time | `time-machine` `3` | `freezegun` `1` for established portability/integration needs | Assuming every native clock is frozen; comparison is maintainer-authored |
| Snapshots | `syrupy` `7` for external snapshots | `inline-snapshot` `0.36` for small reviewable inline expectations | Auto-accept in CI or unreviewed bulk updates |
| HTTPX mocking | `respx` `0.23` | `pytest-httpx` `0.36` for fixture-oriented tests; actual ASGI app tests for route behavior | Mocked HTTP as proof of proxy/TLS/retry behavior |
| HTTP recording | `pytest-recording` `0.14` with `vcrpy` `9` | Explicit mocks for narrow unit tests | Unredacted secrets/PII in cassettes; replay is not live integration coverage |
| Factories | Plain functions with fresh deterministic defaults | `polyfactory` `3` for typed models; `factory_boy` `3` for ORM relationships | Random important fields without explicit values |
| Real service integration | `testcontainers` `4` for database/broker containers | Platform-provided test service; isolated deployed tests for IAM/cloud behavior | SQLite/mocked DB as sole PostgreSQL evidence; unbounded container lifecycle |
| AWS tests | `moto` `5` and SDK stubs for fast tests | DynamoDB Local, SAM local, LocalStack or isolated cloud tests as appropriate | Emulator success mistaken for production concurrency/IAM/service semantics |
| API contracts | `schemathesis` `4` | `pact-python` `4` for consumer/provider agreements; shared API tools in `toolchain-api` | Destructive generated tests against production; new archived Dredd adoption |
| Load tests | `locust` `2` for Python-authored scenarios | `k6` `2` for shared cross-language suite | Treating k6 as a Python package; unapproved production load |
| Mutation | `mutmut` `3` for selected critical code | `cosmic-ray` `8` for configurable execution | Whole-project mandatory PR gate; mutmut needs fork, use WSL rather than native Windows |
| Coverage-guided fuzzing | `atheris` `3` for parser/native risk | Hypothesis for normal property suites | Assuming identical platform/native toolchain requirements; losing failing seeds |
| Benchmarks | `pytest-benchmark` `5` | `pytest-codspeed` `5` for managed regression tracking; profilers in `lang-python-profiling` | Noisy shared-runner timings as hard guarantees |
| Coverage | `coverage` `7` branch coverage through `pytest-cov`; `diff-cover` for changed-line gaps | Existing compatible reporting integration | One universal coverage percentage as correctness evidence |
| Telemetry | `opentelemetry-sdk` `1` in-memory exporter/readers | Export-pipeline integration tests for deployment behavior | Asserting random trace IDs/timestamps; SDK globals shared between tests |

## Rules

- Keep tests deterministic, own fixtures/resources, and test real storage/protocol boundaries when those semantics matter.
- Assert contracts, state changes and failures; make retries, cancellation, timeouts, tenant authorization and duplicate delivery visible in the suite.
- Review snapshots/cassettes and redact before committing. Shard deterministically, record first-attempt failures, and use retries diagnostically rather than to erase failures.
- Run bounded fuzz smoke in CI and longer campaigns on a schedule. Preserve failing seeds; quarantine needs an owner and expiry.

## Sources

- [pytest](https://docs.pytest.org/), [AnyIO tests](https://anyio.readthedocs.io/en/stable/testing.html), [Hypothesis](https://hypothesis.readthedocs.io/)
- [time-machine comparison](https://time-machine.readthedocs.io/en/latest/comparison.html), [Syrupy](https://github.com/syrupy-project/syrupy)
- [RESPX](https://github.com/lundberg/respx), [pytest-httpx](https://github.com/Colin-b/pytest_httpx), [recording](https://github.com/kiwicom/pytest-recording), [VCR](https://github.com/kevin1024/vcrpy)
- [Polyfactory](https://github.com/litestar-org/polyfactory), [Testcontainers](https://github.com/testcontainers/testcontainers-python), [AWS testing](https://docs.aws.amazon.com/lambda/latest/dg/testing-guide.html)
- [Schemathesis](https://github.com/schemathesis/schemathesis), [Pact](https://pact-foundation.github.io/pact-python/), [Locust](https://docs.locust.io/)
- [mutmut](https://github.com/boxed/mutmut), [Atheris](https://github.com/google/atheris), [benchmarks](https://pytest-benchmark.readthedocs.io/), [Coverage](https://github.com/coveragepy/coveragepy), [Package version registry](https://pypi.org/)
