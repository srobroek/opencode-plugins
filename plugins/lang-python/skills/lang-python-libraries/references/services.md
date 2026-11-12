# Python services

Choose Python HTTP/RPC frameworks and content libraries; API style and standards belong to `toolchain-api`.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Typed APIs | `fastapi` `0.162` | `litestar` `2` for more integrated application features; `starlette` `1` for a minimal ASGI layer | Upgrading `starlette` outside `fastapi` constraints breaks compatibility |
| Full-stack web | `Django` `6` | `django-ninja` `1` for typed Django APIs; `djangorestframework` `3` for serializers/viewsets; `Flask` `3` for existing or small synchronous apps | Flask async views are not an ASGI concurrency architecture |
| ASGI serving | `uvicorn` `0.54`; `fastapi-cli` `0.0` uses it | `granian` `2` after workload benchmarks; `hypercorn` `0.18` for HTTP/2 or Trio; `gunicorn` `27` with `uvicorn-worker` `0.4` for existing host operations | Deprecated `uvicorn.workers`; production `--reload`; trusting arbitrary forwarded headers |
| Infrastructure middleware | Pure ASGI middleware in the framework-compatible `starlette` line | `Depends` in `fastapi` for route-specific authorization and resource lifetimes | `BaseHTTPMiddleware` blocks upward `contextvars` propagation; do not claim it universally breaks streaming |
| Common HTTP policy | Framework `CORSMiddleware`, `TrustedHostMiddleware`, `GZipMiddleware` | `asgi-correlation-id` `5` for request IDs; `secure` `2` for headers; `slowapi` `0.1` with shared storage for application limits | CORS is not authorization; gzip/body buffering must not defeat SSE; process-local limits do not enforce cluster quotas |
| Django middleware | Generated security/session/CSRF/auth/clickjacking stack in `Django` `6` | Sync/async-capable middleware for ASGI workloads | Reordering session/auth dependencies; consuming streaming content; needless sync adaptation |
| Request validation | `pydantic` `2` via framework integration | `msgspec` `0.22` for measured serialization needs outside Pydantic integration | Type annotations alone do not validate untrusted input |
| HTTP clients | `httpx` `0.28` | `aiohttp` `3` for async/WebSocket-heavy use; `requests` `2` for synchronous compatibility; `niquests` `3` for advanced protocols; `hishel` `2` for HTTP caching | Hot-loop clients; missing deadlines; HTTPX connection retries do not retry all statuses/read failures |
| Code-first OpenAPI | `fastapi` `0.162` contract export | Existing framework's supported schema export | Two independently maintained authoritative schemas |
| Schema-first models/clients | `openapi-python-client` `0.30` for clients; `datamodel-code-generator` `0.95` for models | Existing generator passes project schema fixtures | Models alone are not complete endpoint clients; latest specification does not imply generator support |
| gRPC/protobuf | `grpcio`/`grpcio-tools` `1`, `protobuf` `7` generated bindings | `betterproto2` `0.10` for idiomatic dataclasses after compatibility tests | Betterproto2 warns of breaking changes and incomplete docs; pin compiler/runtime/plugin family |
| Connect | Keep `grpcio` `1` as conservative Python RPC default | `connect-python` `0.9` ASGI/WSGI generation when beta risk is accepted | Treating Connect Python beta as a stable drop-in gRPC replacement |
| GraphQL server/client | `strawberry-graphql` `0.341`; `gql` `4` for clients | `ariadne` `1` for SDL-first; `graphene` `3` for existing integrations; `httpx` `0.28` for a few fixed queries | Unbounded resolver work/N+1; installing every client transport; sync calls inside an event loop |
| WebSockets/SSE | Framework WebSockets; `sse-starlette` `3` | `websockets` `17` for standalone server/client workloads | Parallel WebSocket server inside ASGI; handmade SSE lifecycle; missing backpressure/disconnect tests |
| JWT/OAuth | `PyJWT` `2`; `Authlib` `1` for OAuth/OIDC | `joserfc` `1` for broader JOSE requirements | Token-controlled algorithm selection; omitting issuer/audience checks; substituting JWT decode for authorization |
| Templates | Framework templates or `Jinja2` `3` | Framework-native choice is already adopted | Disabled HTML autoescaping; untrusted templates without sandbox/resource controls |
| Accepted HTML | `nh3` `0.3` | Contextual escaping when HTML need not be accepted | `bleach` is archived and receives no security releases |
| Markdown | `markdown-it-py` `4` | `mistune` `3` for custom rendering | Rendering is not HTML sanitization; define raw-HTML policy |
| PDF | `WeasyPrint` `70` for HTML/CSS documents | `reportlab` `5` for programmatic layout | Unrestricted resource fetching creates SSRF exposure; bound render time/memory |
| Images | `Pillow` `13` | `pyvips` `3` for large streaming pipelines with native runtime support | Disabling decompression-bomb protections; unlimited input dimensions |
| Email | `email` and `smtplib` | `aiosmtplib` `5` for async SMTP; provider SDK for provider APIs | Blocking SMTP in async handlers; universal provider wrappers without a named need |

## Rules

- Use `quality-code-design` and its `middleware.md` reference for the shared design checklist. Test the assembled middleware stack, not only individual components.
- Keep one framework per HTTP surface: FastAPI for a service that also runs outside Lambda, Powertools Event Handler for Lambda-only HTTP. Never stack both on one surface.
- Define inbound/outbound order explicitly: outer correlation/tracing and completion logging, central error mapping, authentication, principal limits, validation, then route logic. Cheap anonymous abuse limits can run earlier; allow CORS preflight and put required headers on errors.
- FastAPI's last-added middleware is outermost; outbound order reverses inbound. Background tasks run after middleware. Test pinned versions for early returns, exceptions, cancellation, streaming and disconnects.
- HTTPX async hooks must be async. Hooks that read bodies can defeat streaming; use transport wrappers for send policy.
- Keep object/tenant authorization explicit in route dependencies or business services. Use lifespan-managed clients/pools and bounded shutdown.

## Sources

- [FastAPI choices and middleware](https://fastapi.tiangolo.com/alternatives/), [middleware ordering](https://fastapi.tiangolo.com/tutorial/middleware/)
- [Starlette middleware](https://starlette.dev/middleware/), [Django middleware](https://docs.djangoproject.com/en/6.0/topics/http/middleware/)
- [Uvicorn deployment](https://uvicorn.dev/deployment/), [HTTPX transports](https://www.python-httpx.org/advanced/transports/)
- [OpenAPI clients](https://github.com/openapi-generators/openapi-python-client), [model generator](https://github.com/datamodel-code-generator/datamodel-code-generator)
- [gRPC Python](https://grpc.github.io/grpc/python/), [Connect Python beta](https://connectrpc.com/docs/python/getting-started/), [betterproto2](https://github.com/betterproto/python-betterproto2)
- [Protobuf registry](https://pypi.org/project/protobuf/), [gRPC generator registry](https://pypi.org/project/grpcio-tools/), [Connect registry](https://pypi.org/project/connect-python/)
- [Strawberry](https://github.com/strawberry-graphql/strawberry), [SSE](https://github.com/sysid/sse-starlette)
- [JWT security](https://fastapi.tiangolo.com/tutorial/security/oauth2-jwt/), [Jinja](https://jinja.palletsprojects.com/), [nh3](https://github.com/messense/nh3), [Bleach notice](https://github.com/mozilla/bleach)
- [Markdown security](https://markdown-it-py.readthedocs.io/en/latest/security.html), [WeasyPrint warnings](https://doc.courtbouillon.org/weasyprint/stable/first_steps.html), [Pillow security](https://pillow.readthedocs.io/en/stable/handbook/security.html)
- [Package version registry](https://pypi.org/)
