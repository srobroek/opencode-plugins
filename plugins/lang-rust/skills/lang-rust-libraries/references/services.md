# Services and content

Use these Rust crates for HTTP/RPC boundaries and content processing; use `toolchain-api` for API style and standards.

Checked 2026-11-12.

## Framework comparison

| Option | Fit and ergonomics | Selection and evidence |
| --- | --- | --- |
| `axum` `0.8` | Extractors, macro-free handlers, native Tower/Tokio integration | Default for new composable services. |
| `actix-web` `4.19` | Established independent service/middleware ecosystem | Existing Actix team or measured advantage; not automatically fastest. |
| `poem` `3.1` | Handler macros and endpoint abstraction | Its integrated API tools fit; Tower adapter details were not verified. |
| `salvo` `1.1` | Integrated OpenAPI, middleware, optional HTTP/3 and Tower adapters | Framework conventions fit; adapters are not proof of native Tower equivalence. |
| `rocket` `0.5` | Route macros, guards/fairings and Figment | Macro-oriented app; recent release, not established abandoned. |

The research found no controlled current-version framework benchmark. For Actix, resolve the decompression advisory against the full graph. Patched lines include `actix-web` `4.19` and `actix-http` `3.20`. The safe patch floor matters within each line.

## Picks

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Routing/middleware | `axum` `0.8`, `tower` `0.5`, `tower-http` `0.7` | `middleware::from_fn` for local async glue; `from_fn_with_state` for state | Duplicating CORS, trace, compression, request-ID, timeout, body-limit or sensitive-header middleware. |
| Quotas | `tower_governor` `0.8` | `governor` `0.10` outside Tower; gateway/shared store for global quotas | Untrusted forwarded IPs, unpruned keyed state, treating process quotas as global. |
| Request validation | `serde` `1`, `validator` `0.21` | `garde` `0.23` for enum/nested/context validation | Assuming successful decoding means domain validity. |
| Code-first OpenAPI | `utoipa` `6` | `aide` `0.15` for schema-aware routing | Treating generated documentation as runtime validation. |
| Schema-first clients | `progenitor` `0.16` | Broader generator through `toolchain-api` after support fixtures pass | Assuming its documented OpenAPI `3.0.x` support covers `3.1` or `3.2`. |
| gRPC/code generation | `tonic` `0.14`, `prost` `0.14` | `buffa` `0.9` when editions/borrowed views/unknown fields are required | Assuming codec changes are drop-in tonic integration; stale build recipes. |
| Connect | `tonic` `0.14` stays the Rust RPC default | `connectrpc` `0.9` (official, pre-1.0, conformance-tested) when browsers or HTTP/1.1 proxies must reach a Rust RPC server; integration-test it and pin it | Treating its pre-1.0 API as stable; rebranding plain HTTP JSON as Connect. |
| GraphQL | `async-graphql` `7.2` | `juniper` `0.18` for existing integrations; audit current DoS advisories | Unlimited query cost/depth; resolver-only authentication without object authorization. |
| WebSockets/SSE | `axum` `0.8` built-in `ws` and SSE | `tokio-tungstenite` `0.30` standalone; `fastwebsockets` `0.10` for measured low-level needs | Unbounded messages/queues; assuming Lambda HTTP adaptation supplies WebSockets. |
| JWT/JOSE | `jsonwebtoken` `11` | `josekit` `0.10` for JWE/broader JOSE | Decoding without signature, algorithm, issuer, audience and expiry checks. |
| OAuth/OIDC | Existing identity-provider integration | A reviewed client selected for provider requirements; version not established here | Writing token/PKCE/session security from scratch; approval required for an unlisted client. |
| Templates | `askama` `0.16` compiled templates | `minijinja` `3.1` runtime templates; `tera` `2.4` existing stack; `maud` `0.27` Rust HTML macros | Treating escaping as HTML sanitization. |
| HTML/Markdown | `ammonia` `4.2`, `pulldown-cmark` `0.13` | `comrak` `0.59` for AST/GFM | Untrusted rendered HTML without sanitizing; old wikilink parsing vulnerable to quadratic work. |
| PDF | `printpdf` `0.12` | `typst` `0.15` for typesetting; embedding needs a controlled environment | Unbounded document resources or filesystem access. |
| Images | `image` `0.25` | `fast_image_resize` `6.1` for resize workloads | Unbounded pixel/decode budgets; CPU decoding on async workers. |
| Email | `lettre` `0.11` | AWS SES through service SDK when its operations matter | Raw SMTP/MIME construction and credentials in logs. |

## HTTP client comparison

| Option | Fit | Trade-off |
| --- | --- | --- |
| `reqwest` `0.13` | Default async HTTP client | Reuse client; current default TLS is `rustls` with AWS-LC provider. |
| `ureq` `3.5` | Blocking/sequential CLI | Simple synchronous stack; never block runtime workers. |
| `hyper-util` `0.1` | Custom protocol/transport plumbing | Lower-level obligations than routine REST calls. |
| `isahc` `2` | libcurl requirements | Account for native dependency deployment. |

No controlled speed comparison was verified. `reqwest-middleware` `0.5` with `reqwest-retry` `0.9` can compose client concerns, but verify compatibility with the chosen client version first.

## Rules

- Use `quality-code-design`'s `middleware.md` checklist. `Service` handles a request. `Layer` wraps a service. Repeated Router `layer` calls run last-added first. `ServiceBuilder` runs first-added first, and responses unwind in reverse.
- Keep one framework per HTTP surface. Run the same `axum` `0.8` router through `lambda_http` `1.3` on Lambda, reusing its Tower layers.
- Use `tonic` `0.14` interceptors for RPC metadata checks and Tower layers for reusable service behavior. Do not assume an interceptor covers the complete streaming lifecycle.
- Use `reqwest-middleware` `0.5` for outgoing client concerns after checking client compatibility. Define authentication, tracing and retry ordering, and test safe request replay.
- Assign request IDs before recording them; redact before tracing; keep CORS/error headers on early exits. Map fallible Tower errors deliberately. Test authentication, limits, cancellation and streaming ordering.
- Put object/tenant authorization in domain boundaries, not only global middleware. Keep routes thin and state typed.
- Check generator fixtures and contract diffs. Do not claim schemas alone validate behavior.

## Sources

- [Axum middleware](https://docs.rs/axum/latest/axum/middleware/), [Tower HTTP](https://docs.rs/tower-http/latest/tower_http/).
- [Tonic](https://docs.rs/tonic/latest/tonic/), [Utoipa](https://github.com/juhaku/utoipa), [Progenitor](https://docs.rs/progenitor/latest/progenitor/).
- [Crate version registry](https://crates.io/), [Actix advisory](https://rustsec.org/advisories/RUSTSEC-2026-0447.html), [Markdown advisory](https://rustsec.org/advisories/RUSTSEC-2026-0433.html).
- [Askama](https://docs.rs/askama/latest/askama/), [Ammonia](https://docs.rs/ammonia/latest/ammonia/), [Typst](https://docs.rs/typst/latest/typst/), [Lettre](https://docs.rs/lettre/latest/lettre/).
