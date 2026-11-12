# Runtime, packaging and shared helpers

Choose supported runtimes and build tools, then add resilience or architecture helpers only for a named need.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Runtime | Node `24` LTS for portable production; Bun `1.4` for Bun projects | Node `26` when its supported deployment/features are required. | Current releases as a substitute for deployment support policy; unsupported runtime floors. |
| Type checking | `typescript` `7` through the repository script | Existing pinned compiler during a reviewed migration. | Node type stripping/Bun transpilation as type checking; unsupported syntax assumptions. |
| Packaging | Explicit package exports and one reviewed module strategy | Existing CJS/dual package contract when consumers need it. | Unnecessary dual packages, broad barrel exports or accidental internal exports. |
| Library build | `tsdown` `0.23` for a new bundled library | Existing compiler/build tool; Bun bundler for Bun-specific distribution. | Adopting a replacement solely from this list; bundling optional runtime dependencies blindly. |
| App build | Existing framework tool; `vite` `8` for web apps | Bun bundler for Bun-targeted apps; `esbuild` `0.28` for direct bundles; `rolldown` `1` for custom tooling. | Bun-target bundles on Node; one bundle/config for browser and server secrets; assuming bundling checks types. |
| Monorepo | Package-manager workspaces first | `turbo` `2` for task caching; `nx` `24` for graph/generator conventions. | New orchestration when workspace scripts suffice; incorrect cache inputs. |
| Containers | Supported official Node/Bun image, pinned digest, multi-stage build | Distroless when native dependencies, diagnostics and runtime entrypoints are proven. | Mutable tags as release identity; assuming glibc/musl/native binary interchangeability. |
| Shutdown | Runtime signals plus server drain, worker intake stop, pool close and telemetry flush | Platform-specific lifecycle hooks when deployed there. | Exiting before transports/exporters flush; indefinitely awaiting unbounded work. |
| HTTP client | Native `fetch`, `AbortSignal` and generated/service SDKs | `ky` `2` for hooks/retries. `undici` `8` for Node pooling. `got` `16` for Node streams/timeouts. `ofetch` `1` for UnJS. `axios` `1` for existing adapters. | Assuming fetch rejects HTTP errors. `got` `11` is unmaintained. Unsafe retries or unbounded timeouts. |
| Retries | SDK retry policy first; `p-retry` `9` for uncovered operations | `cockatiel` `4` for combined retry/circuit-breaker policies. | Nested retry layers multiplying attempts; retrying permanent errors or unsafe writes. |
| Concurrency | `p-limit` `7` | `p-queue` `10` for queue/rate/scheduling controls. | Unbounded `Promise.all`; confusing process-local limits with distributed quotas. |
| Rate limiting | Framework limiter or gateway policy | Shared store for multi-instance quotas; `@fastify/under-pressure` `9` for overload shedding. | Load shedding as client quotas; incorrect trusted-proxy IP configuration. |
| Errors | Native `Error` with `cause`, discriminated domain results | `neverthrow` `8` for result composition; `effect` `4` for a deliberately adopted resource/concurrency architecture. | Catch-and-ignore; framework exceptions throughout domain code; an effects runtime for one helper. |
| Date/time | Native `Date`/`Intl` for simple instants; native `Temporal` on Node `26` and Bun `1.4` for calendar semantics | `date-fns` `4` for utilities; `temporal-polyfill` `1` for older floors; `dayjs` `1` for existing compact APIs; `luxon` `3` for zone-aware objects. | Assuming native Temporal on Node `24`; local timezone arithmetic for elapsed durations. |
| IDs | Runtime `crypto.randomUUID()` | `uuid` `14` for required UUID variants; `nanoid` `6` for compact random IDs. | Non-cryptographic random IDs for secrets; sortability as authorization. |
| Feature flags | `@openfeature/server-sdk` `1` for services; `@openfeature/web-sdk` `1` for browsers, with a maintained provider | Typed backend wrapper without a maintained provider; local accessor for CLIs/libraries/plugins | Scattered keys or unsafe defaults; see `quality-code-design`'s `feature-flags.md`. |
| Dependency injection | Functions/composition first | `awilix` `13` for an existing/service-container need; Nest native DI in Nest. | Reflection/decorator machinery just to pass two dependencies. |
| State machines | Discriminated unions/pure reducers | `xstate` `5` when hierarchical/concurrent state and tooling justify it. | Scattered boolean state that permits invalid combinations. |
| Local event bus | `node:events` for Node servers | `mitt` `3` for tiny cross-runtime events; `eventemitter3` `5` for existing integrations. | Hiding dependencies behind events; local emitters as durable messaging. |
| Utilities | Standard library | `es-toolkit` `1` for missing helpers; `remeda` `2` for typed pipelines; `immer` `11` for substantial immutable updates; `lodash-es` `4` for existing compatibility. | New utility dependency for one trivial operation or indiscriminate helper imports. |
| Equality | Node `isDeepStrictEqual` or domain-specific comparison | `fast-deep-equal` `3` when its semantics fit. | Assuming different equality implementations handle prototypes, maps and cycles identically. |
| Documentation | `typedoc` `0.28` for public TypeScript APIs | `@microsoft/api-extractor` `7` for declaration/API report governance. | Generated docs as a substitute for usage/contracts; unreviewed public API changes. |
| Releases | Existing repository release automation | `@changesets/cli` `3` for multi-package release notes; `release-please` `17` for release PRs; `semantic-release` `25` for commit-driven publishing. | Competing release owners or new release tooling without approval. |
| Frontend | `react` `19`, `vite` `8` when a React frontend is actually needed | `@tanstack/react-query` `5` for remote state, `@tanstack/react-router` `1` for typed routing, `tailwindcss` `4` for utility styling; existing UI stack wins. | Adding frontend libraries to backends; assuming copied shadcn/ui components update like runtime packages. |

## Rules

- Node type stripping does not apply the project's complete TypeScript configuration.
  Bun transpilation also does not replace a type checker. Use `lang-typescript-packaging`
  and `lang-typescript-quality` for package contracts and commands.
- TypeScript `7` lacks a stable programmatic compiler API; embedded-language/framework
  tools can require a TypeScript `6` compatibility path. Keep framework-aware checking.
  `tsup` explicitly disclaims active maintenance; prefer the listed build choices for new work.
- Test portability where it matters: native DB/image/broker bindings, HTTP/2,
  transport workers, env-file behavior and OTel interception. Keep Bun-only APIs
  behind an intentional runtime boundary rather than accidental imports.
- Share one operation deadline across retries. Use jitter, bounded attempts, and
  cancellation; count downstream attempts when an SDK already retries.
- Follow `toolchain-guide` for tool selection and `quality-profiling` for evidence
  before optimizing. A version number is not a support or performance guarantee.

## Sources

- [Node releases](https://nodejs.org/en/about/previous-releases), [Node TypeScript](https://nodejs.org/api/typescript.html), [Node `26`](https://nodejs.org/en/blog/release/v26.0.0).
- [Bun `1.4`](https://bun.com/blog/bun-v1.4), [Bun bundler](https://bun.com/docs/bundler), [Bun Docker](https://bun.com/docs/guides/ecosystem/docker).
- [tsdown](https://tsdown.dev/), [OpenFeature](https://openfeature.dev/docs/reference/technologies/server/javascript/), [Cockatiel](https://github.com/connor4312/cockatiel).
- [TypeDoc](https://typedoc.org/), [API Extractor](https://api-extractor.com/), [Changesets](https://github.com/changesets/changesets), [registry metadata](https://registry.npmjs.org/).
