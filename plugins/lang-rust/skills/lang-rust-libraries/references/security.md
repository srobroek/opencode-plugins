# Security and quality tooling

Combine reviewed cryptography and boundary controls with distinct lint, vulnerability and supply-chain checks.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| TLS/crypto provider | `rustls` `0.23`, default `aws-lc-rs` `1.19` | `ring` `0.17` for target/dependency constraints; platform TLS for actual requirements | Handwritten crypto; unsupported generic FIPS claims; calling ring abandoned. |
| Password hashes | RustCrypto `argon2` `0.6` | Existing audited password scheme with migration plan | Fast general-purpose hashes for passwords. |
| JWT/JOSE | `jsonwebtoken` `11` | `josekit` `0.10` for broader JOSE/JWE | Unverified decoding for authorization; arbitrary algorithm acceptance. |
| Secret values | `secrecy` `0.10`, `zeroize` `1.9` where appropriate | Deployment secret manager or extension for retrieval | Debug leaks; assuming wrappers erase all copies. |
| Constant-time operations | `subtle` `2.6` through reviewed crypto | Established primitive in the chosen crypto provider | DIY comparison/crypto based only on timing intuition. |
| SSRF | `reqwest` `0.13` with explicit destination/redirect policy | Existing reviewed outbound gateway | User-chosen URLs reaching private/link-local metadata addresses; unchecked redirects/DNS. |
| HTML/parse budgets | `ammonia` `4.2`; bounded format parsers | Existing reviewed sanitization policy | Escaping mistaken for sanitizing; unlimited decompression/depth. |
| Security lint/dead code | Toolchain `clippy`, compiler `dead_code` | Curated project checks for specific risks | Clippy/structural rules treated as a full SAST program or cognitive complexity as universal gate. |
| SAST | `Opengrep` `1.33` with tested Rust rules | `Semgrep CE` `1.185` where rule license/use fits | Universal Rust coverage or private entitlement assumed for CodeQL; untested rule packs. |
| Secret scanning | Offline `Betterleaks` `1.10` or `Gitleaks` `8.30` | `TruffleHog` `3.99` history/verification scan separately | Verified-only findings as the entire secret policy. |
| Advisories/licences/sources | `cargo-deny` `0.20` | `cargo-audit` `0.23` standalone advisory scan | Redundant mandatory tools; latest dependency mistaken for safe graph. |
| Dependency review | `cargo-vet` `0.10` | Existing equivalent reviewed trust policy | Provenance/signature mistaken for harmless code. |
| Unused dependencies | `cargo-machete` `0.9` | `cargo-shear` `1.14` pilot for misplaced dependencies; nightly `cargo-udeps` `0.1` investigation | Stacking scanners without purpose; textual matches as reachability proof. |
| Duplication/complexity | Optional `jscpd` `5.4` report; `Lizard` `1.26` `-Ecognitive` for cognitive complexity (threshold 15) after checking representative files | `PMD CPD` `7.29`; SonarQube Cloud or Server for managed metrics; `rust-code-analysis-cli` for richer metric exports (last release 2023) | Generated-code noise; blanket thresholds as correctness rules. |
| SBOM | `cargo-cyclonedx` `0.5` for Cargo; `Syft` `1.57` for artifacts/images | `cdxgen` `13.7` source inventory; `cargo-auditable` `0.7` embedded dependency metadata | SBOM mistaken for vulnerability remediation or license approval. |
| Unsafe inventory | `cargo-geiger` `0.14` for review targeting | Direct unsafe-boundary audit | Unsafe count as risk score or safety proof. |
| Container scans | `Grype` `0.121` with `Syft` `1.57` | Verified `Trivy` `0.76` explicit opt-in; `Docker Scout` `1.29` integrated workflow | Ignoring documented March 2026 Trivy compromise/transitive action integrity. |
| Container/workflow lint | `Hadolint` `2.15`; `zizmor` `1.32`, `actionlint` `1.7`, `pinact` `5` when applicable | Existing equivalent policy checks | Pinning wrapper action while trusting unverified downloaded executables. |

## Rules

- Commands remain in `lang-rust-quality`; use `lang-rust-ci` for build/installer details. Review full targets/features and lockfile, not only direct dependencies.
- Validate algorithms, issuer, audience/client, token use and expiry. Refresh bounded JWKS caches; authentication does not supply object/tenant authorization.
- Keep secret scanners offline in hooks. Add history scanning and push protection. Rotate exposed credentials. Review engine and rule licenses separately.
- Assign owners and expiry to suppressions; schedule rescans. One updater, verified artifacts and release inventories reduce duplicate work, not the need for review.

## Sources

- [Rustls providers](https://docs.rs/rustls/latest/rustls/), [Argon2](https://docs.rs/argon2/latest/argon2/), [JWT](https://docs.rs/jsonwebtoken/latest/jsonwebtoken/).
- [RustSec](https://rustsec.org/advisories/), [Cargo deny](https://github.com/EmbarkStudios/cargo-deny), [Cargo vet](https://docs.rs/cargo-vet/latest/cargo_vet/), [Cargo shear](https://github.com/Boshen/cargo-shear).
- [Semgrep changes](https://semgrep.dev/blog/2024/important-updates-to-semgrep-oss), [Opengrep](https://github.com/opengrep/opengrep), [Betterleaks](https://github.com/betterleaks/betterleaks), [Trivy incident](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23).
- [Syft](https://github.com/anchore/syft), [Grype](https://github.com/anchore/grype), [Crate registry](https://crates.io/), [Clippy complexity limitation](https://rust-lang.github.io/rust-clippy/master/index.html#cognitive_complexity).
