# Go services and content

Use these choices for network boundaries and generated or rendered content; use `toolchain-api` for API design.

Checked 2026-11-12. Standard-library entries use Go `1.27`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Server and ordinary routing | `net/http`, `http.ServeMux`; standard library is sufficient | `github.com/go-chi/chi/v5` `5` for groups, mounting and route-local middleware | A router dependency solely for method/wildcard matching, supplied since Go `1.22`. |
| Framework | No framework beyond `net/http` | `github.com/labstack/echo/v5` `5` or `github.com/gin-gonic/gin` `1` for established team conventions | `github.com/gofiber/fiber/v3` `3` without measured need and a fasthttp interoperability/lifetime audit. |
| Middleware composition | `func(http.Handler) http.Handler`; standard library is sufficient | Chi `5` middleware with its router; framework hooks within an existing framework | Per-handler copies of auth, telemetry or error translation. |
| CORS | No CORS for same-origin services | `github.com/rs/cors` `1` for cross-origin browser clients | Wildcard origins with credentials; confusing CORS with authorization. |
| Recovery, request IDs and access logs | Boundary middleware using `net/http` and `log/slog` | Chi `5` middleware when already installed | Chi `5` deprecated `RealIP`: spoofing risk; trust only configured proxies. |
| Timeouts and rate limits | `http.Server` deadlines, request `context`; `golang.org/x/time/rate` `0.16` | Shared-store limits for multiple replicas; streaming-specific deadlines | Blanket buffered timeout wrappers around SSE/WebSockets; process-local limits advertised as global. |
| Request validation | Explicit checks for small types; standard library is sufficient | `github.com/go-playground/validator/v10` `10` for shared struct-tag rules; Huma `2` for schema validation | Treating decoding, generated types or tags as domain authorization. |
| Code-first OpenAPI | `github.com/danielgtaylor/huma/v2` `2` when schema generation is needed | Plain `net/http` for endpoints without generated contracts | Hand-maintaining separate schemas and handlers that can drift. |
| Schema-first OpenAPI | `github.com/oapi-codegen/oapi-codegen/v2` `2` for ordinary handler integration | `github.com/ogen-go/ogen` `1` for generated client/server infrastructure | Old `deepmap` imports; assuming all generated handlers validate automatically. |
| Protobuf runtime | `google.golang.org/protobuf` `1` | Existing generated runtime during a planned migration | Mixing incompatible generated files, compiler plugins and runtimes. |
| HTTP-native RPC | `connectrpc.com/connect` `1` | `google.golang.org/grpc` `1` for native gRPC infrastructure/features | Bespoke RPC framing; assuming browser bidirectional streams work like native HTTP/2. |
| RPC middleware | Connect `1` interceptors; gRPC `1` interceptors/stats handlers | `github.com/grpc-ecosystem/go-grpc-middleware/v2` `2` for reusable gRPC chains | Duplicate instrumentation or mismatched unary/stream policy. |
| GraphQL | `github.com/99designs/gqlgen` `0.17` for schema-first generated resolvers | `github.com/graphql-go/graphql` `0.8` for existing runtime-schema integrations | GraphQL without per-resolver auth, cost limits and N+1 controls. |
| WebSockets | `github.com/coder/websocket` `1` | `github.com/gorilla/websocket` `1` for existing integrations | Old `nhooyr.io/websocket` imports; claiming Gorilla is still archived. |
| SSE | `net/http`, flushing and request cancellation; standard library is sufficient | A replay/subscription layer when resumable delivery is required | WebSockets for one-way notifications; untested proxy buffering and reconnect behavior. |
| JWT | `github.com/golang-jwt/jwt/v5` `5` for signed-token verification | `github.com/lestrrat-go/jwx/v3` `3` for JWK/JWE/JWS requirements | Decoding without signature, issuer, audience, expiry and algorithm checks. |
| OAuth/OIDC | `golang.org/x/oauth2` `0.38`; `github.com/coreos/go-oidc/v3` `3` for discovery and verification | Existing provider SDK when its integration supplies required behavior | Custom OAuth flows or accepting an ID token as an API access token. |
| HTML templates | `html/template`; standard library is sufficient | `github.com/a-h/templ` `0.3` for compiled typed components | `text/template` for untrusted HTML; marking user strings trusted. |
| HTML sanitization | Plain text and escaping when rich HTML is unnecessary | `github.com/microcosm-cc/bluemonday` `1` for an allowlisted rich-HTML policy | Regex sanitizers; treating escaping as sanitization. |
| Markdown | `github.com/yuin/goldmark` `1` | Required extensions with explicit sanitization | Raw HTML output without a trust policy. |
| PDF | `github.com/johnfercher/maroto/v2` `2` for programmatic reports | Browser rendering for CSS-heavy documents | Archived `github.com/jung-kurt/gofpdf` for new projects. |
| Images | `image`, `image/png`, `image/jpeg`; standard library is sufficient for codecs | `github.com/disintegration/imaging` `1` for transforms; `github.com/davidbyttow/govips/v2` `2` for measured libvips workloads | Native dependencies without need; unbounded image dimensions or decompression. |
| Email | `github.com/wneessen/go-mail` `0.8` for SMTP/MIME | Provider SDK/API for managed delivery | New message-building systems on frozen `net/smtp` alone. |

## Rules

- Put request context and OTel outside middleware that emits correlated logs. Apply authorization before business handlers; place recovery so it catches inner failures and instrumentation still observes the outcome.
- Treat body limits, authentication, validation and error translation as boundary concerns. Test ordering and failure paths rather than copying one universal middleware order.
- Preserve optional response interfaces when wrapping writers. Test flushing, hijacking, compression and cancellation on streaming endpoints.
- Put telemetry and retry behavior in shared client transports. Do not add a retry loop inside each handler.
- Use `http.RoundTripper` for client middleware; establish retry/auth/tracing ordering and safe body replay. The standard library mechanism is sufficient.
- Keep one framework per HTTP surface. Reuse the same `net/http` handler and middleware on Lambda through Web Adapter or an `aws-lambda-go` HTTP adapter.
- Use `quality-code-design` and `middleware.md` for the language-neutral composition rules.
- Use validator `10` with `WithRequiredStructEnabled` for its recommended struct behavior. Keep business invariants explicit.
- Pin the Protobuf compiler and generation plugins together; use Buf's `v2` configuration for reproducible generation and compatibility gates. The configuration version is not the CLI major. See `toolchain-api` for the workflow.
- Connect `1` was the registry line checked here, but current interceptor documentation uses `v2` APIs. Re-check the module and matching docs before copying signatures.

## Sources

- [Standard HTTP](https://pkg.go.dev/net/http), [Chi](https://pkg.go.dev/github.com/go-chi/chi/v5), [Echo](https://pkg.go.dev/github.com/labstack/echo/v5), [Fiber caveats](https://docs.gofiber.io/), [CORS](https://pkg.go.dev/github.com/rs/cors).
- [Validator](https://pkg.go.dev/github.com/go-playground/validator/v10), [Huma](https://pkg.go.dev/github.com/danielgtaylor/huma/v2), [oapi-codegen](https://pkg.go.dev/github.com/oapi-codegen/oapi-codegen/v2), [ogen](https://pkg.go.dev/github.com/ogen-go/ogen).
- [Connect](https://pkg.go.dev/connectrpc.com/connect), [gRPC](https://pkg.go.dev/google.golang.org/grpc), [Protobuf](https://pkg.go.dev/google.golang.org/protobuf), [gRPC middleware](https://pkg.go.dev/github.com/grpc-ecosystem/go-grpc-middleware/v2), [gqlgen](https://pkg.go.dev/github.com/99designs/gqlgen).
- [Coder WebSocket](https://pkg.go.dev/github.com/coder/websocket), [Gorilla](https://github.com/gorilla/websocket), [JWT](https://pkg.go.dev/github.com/golang-jwt/jwt/v5), [JOSE](https://pkg.go.dev/github.com/lestrrat-go/jwx/v3), [OIDC](https://pkg.go.dev/github.com/coreos/go-oidc/v3), [OAuth](https://pkg.go.dev/golang.org/x/oauth2).
- [HTML templates](https://pkg.go.dev/html/template), [templ](https://pkg.go.dev/github.com/a-h/templ), [Bluemonday](https://pkg.go.dev/github.com/microcosm-cc/bluemonday), [Goldmark](https://pkg.go.dev/github.com/yuin/goldmark).
- [Maroto](https://pkg.go.dev/github.com/johnfercher/maroto/v2), [archived PDF library](https://github.com/jung-kurt/gofpdf), [images](https://pkg.go.dev/image), [imaging](https://pkg.go.dev/github.com/disintegration/imaging), [govips](https://pkg.go.dev/github.com/davidbyttow/govips/v2), [mail](https://pkg.go.dev/github.com/wneessen/go-mail).
