# Security and dependency assurance

Choose established crypto, identity and scanners, with explicit limits for Node and Bun.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Cryptography | Runtime Web Crypto or Node `node:crypto` | Existing reviewed SDK for the application's encryption/key-management protocol. | Handwritten primitives, insecure random numbers, or encryption without an authenticated mode. |
| Password hashing | `@node-rs/argon2` `2` with reviewed Argon2id parameters | Bun native password API for Bun-only deployments. | Fast hashes for passwords; native packages without target/runtime tests. |
| JOSE/JWT | `jose` `6` | `aws-jwt-verify` `5` for Cognito-specific policy. | Decode-only auth; unchecked issuer/audience/token use/algorithm; unbounded JWKS retrieval. |
| Secrets | Platform secret store; Powertools Parameters `2` cached retrieval on Lambda | Existing secrets injection/agent when deployment owns refresh. | Checked-in env values; logs, prompts or test fixtures containing credentials. |
| SSRF | URL allowlist, network egress policy, redirect/address validation | Existing vetted transport integration when it enforces those controls for the deployed runtime. | A Node-agent filter assumed to protect Bun native fetch; validating only the initial URL before redirects/DNS changes. |
| HTML/content | `sanitize-html` `2` server; `dompurify` `3` browser | Framework escaping for plain text; current DOM implementation when server DOMPurify is required. | Regex sanitizers; modifying sanitized HTML; unsafe Markdown output. |
| Lint/type safety | `typescript` `7`; repository `@biomejs/biome` `2` or `oxlint` `1` plus necessary rules | Existing ESLint/security rules for gaps not covered by the selected linter. | Calling lint a taint-aware SAST engine or running multiple redundant linters without a gap. |
| SAST | Existing `semgrep` `1` or `opengrep` `1` with reviewed rules | `CodeQL` for eligible CI/language/licence coverage; `eslint-plugin-security` `4` for selected JS heuristics. | Confusing engine and rule licences: Semgrep-maintained rules changed permitted uses; claiming complete Bun-specific data-flow coverage. |
| Secret scanning | Offline `betterleaks` `1` or `gitleaks` `8` changed-content hook | `trufflehog` `3` history/verification scan; push protection where available. | Verified-only policy: it misses unverifiable secrets; duplicate mandatory scanners. |
| Dependency/SCA | Manager-native audit plus `osv-scanner` `2` | Organization-required scanner for vulnerability reachability/policy. | Treating an empty audit as proof of safety; unreviewed audit-fix major upgrades. |
| SBOM | `@cyclonedx/cyclonedx-npm` `7` for npm-supported workflows | Existing artifact/container SBOM generator for Bun or deployed images. | Assuming npm lockfile semantics match Bun lockfiles; SBOM generation without deployment identity. |
| Artifact SBOM | `syft` `1` for images/artifacts | `cdxgen` `13` tool release for supported source dependencies; verify the npm distribution separately. | Ignoring native binaries or image OS packages in a package-only inventory. |
| Licences | `license-checker-rseidelsohn` `5` dependency report plus policy review | `licensee` `10` for repository licence detection, not dependency compliance. | Inferring licence compliance from package availability; ignoring transitive/native assets. |
| Dependency updates | One existing updater, `renovate` `44` or Dependabot | `lockfile-lint` `5` where the lockfile format is supported. | Competing bots; auto-merging unreviewed major updates; missing cooldown/provenance checks. |
| Container assurance | `grype` `0.121` plus `syft` `1` | `trivy` `0.76` only with explicit artifact/action integrity review; `hadolint` `2` for Dockerfiles. | Ignoring Trivy's documented March `2026` supply-chain compromise or trusting mutable action tags. |
| Workflow security | `zizmor` `1`, `actionlint` `1`, SHA pinning with `pinact` `5` when workflows exist | Existing organization workflow controls. | Assuming a pinned wrapper secures every transitive action/download. |
| Dead code/dependencies | `knip` `6` | Compiler/linter unused-import checks for local concerns. | `unimported`: archived; claiming `ts-prune` is abandoned despite current activity. |
| Cognitive complexity | Biome `2` `noExcessiveCognitiveComplexity` set to error, threshold 15 | `eslint-plugin-sonarjs` `4` (SonarSource's rule, LGPL-3.0) in an ESLint stack. Oxlint and typescript-eslint have no cognitive rule. | Gating total repository complexity instead of new functions. |
| Duplication | `jscpd` `5` as reviewed report | Existing cross-language duplication scanner. | Mechanical deduplication of coincidentally similar code; arbitrary blocking thresholds. |

## Rules

- Keep scanner versions pinned in the existing toolchain. Current CodeQL CLI and Socket
  releases were not established by the research; verify them before adding either.
  Review scanner findings, suppression owner/expiry, engine and rule licences separately.
- Prefer OIDC trusted publishing and npm provenance, with SBOM/release identity checks.
  Signatures establish provenance, not harmlessness; retain supply-chain review.
- Validate inputs and cap payloads before expensive parsing, hashing, image/PDF or AI
  work. Restrict destinations and file paths; log only reviewed, redacted fields.
- Test crypto native binaries, JWKS networking and HTTP interception on Bun rather
  than assuming Node compatibility. See `project-secrets` for credential handling.
- Use `lang-typescript-quality` for commands; scanners complement review and tests.

## Sources

- [Node crypto](https://nodejs.org/api/crypto.html), [Bun password](https://bun.com/docs/runtime/hashing#bun-password), [JOSE](https://github.com/panva/jose).
- [OWASP cheat sheets](https://owasp.org/www-project-cheat-sheets/), [DOMPurify](https://github.com/cure53/DOMPurify).
- [Knip](https://knip.dev/), [unimported status](https://github.com/smeijer/unimported), [ts-prune status](https://github.com/nadeesha/ts-prune), [jscpd](https://github.com/kucherenko/jscpd).
- [CycloneDX npm](https://github.com/CycloneDX/cyclonedx-node-npm), [Semgrep](https://semgrep.dev/docs/), [CodeQL](https://codeql.github.com/docs/), [OSV Scanner](https://google.github.io/osv-scanner/).
- [Semgrep rule licensing](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss), [Trivy incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23), [Syft](https://github.com/anchore/syft), [Grype](https://github.com/anchore/grype).
- [Betterleaks](https://github.com/betterleaks/betterleaks), [licence inventory](https://www.npmjs.com/package/license-checker-rseidelsohn), [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- [Registry metadata](https://registry.npmjs.org/).
