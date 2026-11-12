# Go security and code audits

Use standard cryptographic primitives, explicit boundary policies and complementary scanners with reviewed findings.

Checked 2026-11-12. Standard-library entries use Go `1.27`; commands belong in `lang-go-quality`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Cryptography/randomness | `crypto`, `crypto/rand`, `crypto/tls`; standard library is sufficient for supplied primitives | `golang.org/x/crypto` `0.59` for missing approved algorithms | Homemade crypto, `math/rand` for secrets or bypassed TLS verification. |
| Password storage | `golang.org/x/crypto/argon2` `0.59` Argon2id with reviewed parameters | `golang.org/x/crypto/bcrypt` `0.59` for compatibility | Plain/fast hashes; bcrypt passwords beyond its `72`-byte limit. |
| JWT/JOSE | `github.com/golang-jwt/jwt/v5` `5` for verification | `github.com/lestrrat-go/jwx/v3` `3` for JWK/JWE/JWS and cached keys | Decode-only authentication; unbounded key fetching or absent algorithm/issuer/audience/time checks. |
| OAuth/OIDC | `golang.org/x/oauth2` `0.38`, `github.com/coreos/go-oidc/v3` `3` | Provider integration for a named flow | Handwritten OAuth protocols or identity tokens used as API access tokens. |
| Secrets | Workload identity and managed-secret retrieval, detailed in `aws.md` | Existing approved secret manager | Values in source, fixtures, errors, logs or telemetry; env vars mistaken for secure storage. |
| Filesystem containment | `os.Root`; standard library is sufficient for its rooted operations | Reviewed sandbox/process isolation for stronger threat models | String-prefix path checks as a race-safe filesystem boundary. |
| SSRF | Restricted `net/http.Transport`/dialer plus destination policy; standard library supplies the mechanism and the application enforces the policy | Network egress proxy/controls | Hostname-only checks, DNS-check-then-redial, unrestricted redirects/proxies; validate actual IPv4/IPv6/mapped dial addresses. |
| HTML/input | `html/template` escaping for ordinary output | `github.com/microcosm-cc/bluemonday` `1` for allowlisted rich HTML | Regex sanitizers or decoding treated as validation. |
| CSRF | `net/http.CrossOriginProtection`; standard library suffices for origin-based protection | `github.com/gorilla/csrf` `1` for synchronizer-token requirements | Assuming origin checks and token mechanisms are identical. |
| Security headers | Explicit `net/http` headers; standard library is sufficient | `github.com/unrolled/secure` `1` for configurable shared middleware | Blind CSP/HSTS defaults; CORS as authorization. |
| Security lint/SAST | `github.com/securego/gosec/v2` `2` plus configured `golangci-lint` `2` | `Opengrep` `1` or `Semgrep CE` `1` for targeted rules; organization CodeQL where licensed | Scanner output as complete audit; ignoring separate engine/rule licenses. |
| Secret scanning | Offline `Betterleaks` `1` or `Gitleaks` `8` on changed content | `TruffleHog` `3` for separate history/verification scans | Verified-only policy that drops unverifiable secrets. |
| Dependency SCA | `golang.org/x/vuln/cmd/govulncheck` `1` for reachable Go vulnerabilities | `OSV-Scanner` `2` for broader source dependencies; `Grype` `0.121` for built artifacts | Redundant mandatory scans with no ownership; no scan of shipped binaries/images. |
| SBOM | `github.com/CycloneDX/cyclonedx-gomod` `1` for Go source modules | `Syft` `1` for images/artifacts; `cdxgen` `13` for multilingual source | SBOM generation presented as vulnerability detection. |
| Dependency licences | `go-licenses` `2` inventory and project policy | Organization-approved compliance tooling | Repository-licence detection as equivalent to dependency compliance. |
| Dead declarations | Configured `unused`/`staticcheck` in golangci `2` | `golang.org/x/tools/cmd/deadcode` `0.52` for whole-program executable/test-root reachability | Deleting exported library APIs solely because one executable does not reach them. |
| Duplication/complexity | `gocognit` `1` through golangci `2` at 15 (cognitive) and `gocyclo` at 10-12, with review | `jscpd` `5` or PMD CPD `7` optional duplication report | Multiple overlapping universal gates; generated-code duplication or arbitrary limits as defects. |
| Container security | Verified `Grype` `0.121` plus `Syft` `1` when images ship | `Trivy` `0.76` only with explicit artifact/transitive-action review | Ignoring Trivy's documented March 2026 compromise or trusting mutable installer tags. |
| Workflow security | `actionlint` `1`, `zizmor` `1`, `pinact` `5` when workflows exist | Scheduled Scorecard `5` assessment for repository posture | Treating an action SHA alone as proof of downloaded-tool integrity. |

## Rules

- Authorize tenant/object/action/field access in the domain boundary, not only at the gateway. Bound bodies, decompression, queries, concurrency and outbound waits.
- Distinguish escaping, sanitization, CSRF, SSRF, SAST, SCA and SBOM purposes. No one scanner supplies all of them.
- Pin scanners and artifacts. Review suppressions with an owner, rationale and expiry; configure one tool per gate.
- Keep a single dependency updater, such as `Renovate` `44`, with project cooldown and vulnerability policy. Review supply-chain and license changes alongside advisories.
- Report dead code/duplication before gating a mature codebase; library entry points and generated code need explicit exclusions.

## Sources

- [Go crypto additions](https://go.dev/doc/go1.24), [Argon2](https://pkg.go.dev/golang.org/x/crypto/argon2), [bcrypt](https://pkg.go.dev/golang.org/x/crypto/bcrypt), [JWT](https://pkg.go.dev/github.com/golang-jwt/jwt/v5), [JOSE](https://pkg.go.dev/github.com/lestrrat-go/jwx/v3), [rooted files](https://pkg.go.dev/os#Root).
- [HTTP/dial policy mechanisms](https://pkg.go.dev/net/http), [dialer](https://pkg.go.dev/net#Dialer), [CSRF additions](https://go.dev/doc/go1.25#nethttp), [Gorilla CSRF](https://pkg.go.dev/github.com/gorilla/csrf), [secure headers](https://pkg.go.dev/github.com/unrolled/secure).
- [gosec](https://pkg.go.dev/github.com/securego/gosec/v2), [Go vulnerability tooling](https://go.dev/security/vuln/), [govulncheck](https://pkg.go.dev/golang.org/x/vuln/cmd/govulncheck), [golangci linters](https://golangci-lint.run/docs/linters/), [deadcode](https://pkg.go.dev/golang.org/x/tools/cmd/deadcode).
- [Opengrep](https://github.com/opengrep/opengrep), [Semgrep rule-license changes](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss), [Betterleaks](https://github.com/betterleaks/betterleaks), [Gitleaks](https://github.com/gitleaks/gitleaks), [TruffleHog](https://github.com/trufflesecurity/trufflehog).
- [OSV](https://github.com/google/osv-scanner), [CycloneDX Go](https://pkg.go.dev/github.com/CycloneDX/cyclonedx-gomod), [Syft](https://github.com/anchore/syft), [cdxgen](https://github.com/cdxgen/cdxgen), [go-licenses](https://github.com/google/go-licenses), [Grype](https://github.com/anchore/grype), [Trivy incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).
- [jscpd](https://github.com/kucherenko/jscpd), [PMD](https://github.com/pmd/pmd), [actionlint](https://github.com/rhysd/actionlint), [zizmor](https://github.com/zizmorcore/zizmor), [pinact](https://github.com/suzuki-shunsuke/pinact), [Renovate](https://github.com/renovatebot/renovate).
