# Python runtime and architecture helpers

Choose runtime, packaging and lifecycle tools before adding resilience, concurrency or architecture dependencies.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Service runtime | Python `3.14`, conventional GIL build | Python `3.15` once wheels/dependencies pass; libraries choose consumer-tested support floors | Saying `3.14` is latest: `3.15` is released; `3.13` is security-only and `3.10` is EOL |
| Free-threading | Conventional build | Python `3.14` or later free-threaded build for measured CPU-thread benefits | Supported runtime does not mean all extensions work or performance improves |
| Package/dependency management | `uv` `0.13`, project lock and dependency groups | Existing packaging workflow that meets required compatibility | Resolving dependencies at startup; untested consumer ranges; host environment leakage |
| Pure-Python build | `uv_build` `0.13` for conventional packages | Existing backend or extension-capable backend for compiled/custom builds | uv_build is not a compiled-extension backend |
| Monorepo | `uv` `0.13` workspaces and `lang-python-packaging` guidance | Separate packages/environments when dependency isolation requires them | Unrelated packages forced into one release or dependency graph |
| Lint/type stack | `ruff` `0.17` plus `pyright` `1` or `mypy` `2` | `pyrefly` `1` after project evaluation; `ty` `0.0` pilot | Declaring ty stable: it is beta with unstable diagnostics/API; commands belong to `lang-python-quality` |
| Container base | Supported `python:3.14-slim`, explicit distro and digest | Distroless `python3-debian13` or Chainguard Python after ABI/dependency tests | Floating latest; incompatible builder/runtime ABI; hardened image assumed drop-in |
| Container build | `uv` `0.13`, locked dependency-first cached stages, production-only environment, nonroot runtime | Copy compatible built virtualenv into runtime | Host `.venv`; unnecessary compiler/build tooling in runtime |
| Server process | `uvicorn` `0.54`, one process per orchestrated container | `gunicorn` `27` plus `uvicorn-worker` `0.4` for host-managed multiprocess | Deprecated `uvicorn.workers`; automatic worker-count formulas |
| Graceful shutdown | Exec-form entrypoint, framework lifespan, owned task groups | Init process for child reaping/forwarding | Shell swallowing `SIGTERM`; shutdown budget shorter than task/client/pool/telemetry cleanup |
| Documentation | `Sphinx` `9`, autodoc for API references | `zensical` `0.1` for Markdown sites after plugin tests; `mkdocstrings` `1` in existing MkDocs stacks | New `mkdocs-material` `9` adoption without migration plan: EOL `2027-05-05`; test each Zensical plugin's compatibility |
| Changelog/releases | `towncrier` `26` fragments; PyPI Trusted Publishing | Hand-maintained changelog for small projects | Raw commit logs as user-facing changes; long-lived upload credentials when OIDC is available |
| Version metadata | Existing backend's static version | `hatch-vcs` `0.5` or `setuptools-scm` `10` for matching SCM-backed backend | Missing tags/shallow checkout; unintended tracked files in source distributions |
| Retries/backoff | `stamina` `26` for bounded selective retries | `tenacity` `9` for custom policy | Retrying non-idempotent writes; nested retry multiplication; unbounded overall deadline |
| Circuit breakers | Existing reviewed service policy | `pybreaker` `1` for synchronous breaker; Powertools Circuit Breaker on Lambda | New `aiobreaker` `1` without maintenance ownership: stale release/push evidence |
| Rate limits | Gateway/shared store, framework policy | `slowapi` `0.1` for application-level limits with shared storage | Per-process counters as cluster-wide quotas; ignoring retry-after and deadline budget |
| Async concurrency | `asyncio.TaskGroup`; `anyio` `4` for framework/library portability | `uvloop` `0.23` after workload/platform tests; offload blocking I/O | Unowned fire-and-forget tasks; blocking event loop; swallowing cancellation |
| CPU concurrency | Existing process/executor facilities in `concurrent.futures` | Validated free-threaded runtime for thread-parallel CPU work | Assuming ordinary GIL threads provide CPU parallelism; sharing mutable state without ownership |
| Errors | Domain exception hierarchy with `raise ... from ...`; framework boundary mapping | Existing exception contract | Catch-all swallowing cancellation/failures; leaking stack traces/secrets to clients |
| Time | Aware `datetime` plus `zoneinfo` | `whenever` `0.11` for explicit temporal types; `pendulum` `3` or `arrow` `1` for existing ergonomics | Naive timestamps for instants; unnecessary legacy library migration |
| IDs | `uuid.uuid7` on Python `3.14` or later; UUIDv4 for no timestamp disclosure | `python-ulid` `4` for ULID interoperability | Sortable IDs reveal time and cannot authorize access |
| Feature flags | `openfeature-sdk` `0.10` for applications/services with a maintained provider | Typed flag-module backend wrapper without a maintained provider; local options for CLIs/libraries/plugins | Authorization through flags; unowned release flags; see `quality-code-design`'s `feature-flags.md` |
| Dependency injection | Explicit constructors; FastAPI `Depends` at framework boundary | `dishka` `1` for scoped cross-framework DI; `svcs` `26` for lifecycle/health; `dependency-injector` `4` for provider graphs | Containers for simple composition; leaking framework dependencies into domain functions |
| State machines | Enum plus transition table for small states | `transitions` `0.9` for richer machines | In-memory state machine as durable execution |
| Utility/cache helpers | Standard library, including `functools`, `itertools`, `collections` | `cachetools` `8` for TTL/custom eviction | Grab-bag utility dependency without a gap; caching coroutine objects |
| Plugin discovery/hooks | `importlib.metadata` entry points | `pluggy` `1` for hook contracts | Arbitrary imports as a security boundary; hook engine when discovery suffices |

## Head-to-head and rules

- Stamina supplies a bounded retry default; Tenacity fits custom policies. HTTPX transport retries cover connection failures only, not a complete resilience policy. Combine retries with a single total deadline and idempotency.
- Use framework lifecycle/DI where already available; explicit composition before Dishka/provider containers. State transitions and durable workflow replay are different concerns.
- Locks protect applications; library compatibility ranges need consumer-version tests. Load `lang-python-packaging` for layout/workspaces and `lang-python-quality` for commands.
- Validate SIGTERM, cancellation, client/pool close and telemetry flush under the deployment shutdown budget. Keep middleware request state isolated.

## Sources

- [Python lifecycle](https://devguide.python.org/versions/), [free-threading](https://docs.python.org/3.14/whatsnew/3.14.html), [UUIDv7](https://docs.python.org/3.14/library/uuid.html)
- [uv build backend](https://docs.astral.sh/uv/concepts/build-backend/), [Docker integration](https://docs.astral.sh/uv/guides/integration/docker/), [ty beta](https://github.com/astral-sh/ty)
- [Official Python images](https://github.com/docker-library/docs/tree/master/python), [Distroless](https://github.com/GoogleContainerTools/distroless), [entrypoint signal handling](https://docs.docker.com/reference/dockerfile/#entrypoint)
- [Sphinx](https://www.sphinx-doc.org/), [Zensical/Material EOL](https://zensical.org/upcoming-changes/), [Towncrier](https://github.com/twisted/towncrier), [PyPI attestations](https://docs.pypi.org/attestations/)
- [Stamina tutorial](https://stamina.hynek.me/en/stable/tutorial.html), [aiobreaker activity](https://github.com/arlyon/aiobreaker), [asyncio tasks](https://docs.python.org/3/library/asyncio-task.html), [AnyIO](https://anyio.readthedocs.io/)
- [OpenFeature](https://github.com/open-feature/python-sdk), [Whenever](https://whenever.readthedocs.io/), [Dishka](https://dishka.readthedocs.io/), [svcs](https://svcs.hynek.me/), [transitions](https://github.com/pytransitions/transitions), [pluggy](https://pluggy.readthedocs.io/)
- [Package version registry](https://pypi.org/)
