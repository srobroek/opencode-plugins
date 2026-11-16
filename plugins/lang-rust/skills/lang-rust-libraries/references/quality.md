# Quality tooling

Lint, format, safety, dependency, API and docs checks for Rust. Testing tools are in [testing.md](testing.md); crypto, secrets and scanners for supply chain are in [security.md](security.md); commands are in `lang-rust-quality` and `lang-rust-ci`. Follow the install policy in `toolchain-languages`' `concerns.md`: detect a tool, recommend the install command and ask before you install it. Maintenance cells give a minimum version; use the latest release the manager offers.

Checked 2026-11-16.

## Concerns

| Concern | Default | Maintenance | Install | Alternatives | Use both when | Run | Avoid |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `lint` | Built-in: clippy (`cargo clippy --all-targets --all-features -- -D warnings`) | - | `cargo clippy --version` · `rustup component add clippy` | None | - | every-pr | Allowing lints crate-wide instead of at the item with a reason |
| `format` | Built-in: rustfmt (`cargo fmt --check`) | - | `cargo fmt --version` · `rustup component add rustfmt` | None | - | every-pr | Unformatted files merged; a second formatter |
| `types` | Built-in: `cargo check --all-targets` | - | Built-in | `Kani`: bounded model checking of critical unsafe or arithmetic code | `cargo check` always; Kani for chosen proofs | every-pr | Skipping `--all-targets`, so tests and benches go unchecked |
| `sast` | Shared: semgrep | - | Shared | `Opengrep`: the Semgrep CE rule licence does not fit; `codeql`: the Shared tool, GitHub code scanning with a supported Rust query pack | `semgrep` with `codeql` when both are licensed | scheduled | Universal Rust coverage assumed; untested rule packs; clippy treated as a SAST program |
| `memory-safety` | Built-in: Miri (nightly component) | - | `cargo +nightly miri --version` · `rustup +nightly component add miri` | `cargo-careful`: cheap extra runtime checks on nightly; AddressSanitizer or ThreadSanitizer: FFI or native code Miri cannot run; Valgrind: native dependencies without nightly | Miri for pure-Rust unsafe, sanitizers for FFI | scheduled | Running it on `#![forbid(unsafe_code)]` crates with no unsafe dependencies; Miri on FFI-heavy tests |
| `dep-audit` | `cargo-deny` | >= 0.20 · 2026-07-09 · active | `cargo deny --version` · `cargo binstall cargo-deny` | `cargo-audit`: a standalone advisory scan without licence or ban policy; `osv-scanner`: one scanner across languages | `cargo-deny` with `cargo-audit` only for an extra advisory view | every-pr + scheduled | Redundant mandatory tools; latest dependency mistaken for a safe graph |
| `dead-code` | Built-in: rustc `dead_code` lint | - | Built-in | None | - | every-pr | Silencing with `allow(dead_code)` instead of deleting |
| `unused-deps` | `cargo-shear` | >= 1.14 · 2026-11-13 · active | `cargo shear --version` · `cargo binstall cargo-shear` | `cargo-machete`: fast regex check, accepts false positives; `cargo-udeps`: accurate, nightly and a full build | `cargo-shear` with `cargo-udeps` for one investigation | every-pr | Stacking scanners as mandatory gates; text matches as reachability proof |
| `complexity` | Shared: lizard | - | Shared | None | - | on-demand | Blanket thresholds as correctness rules; gating on Clippy `cognitive_complexity`; `rust-code-analysis` (stale) |
| `duplication` | Shared: jscpd | - | Shared | None | - | on-demand | Generated-code noise in the report |
| `api-break` | `cargo-semver-checks` | >= 0.51 · 2026-10-03 · active | `cargo semver-checks --version` · `cargo binstall cargo-semver-checks` | `cargo-public-api`: only where a committed API snapshot is wanted for review (nightly) | `cargo-semver-checks` is the gate; add `cargo-public-api` only for a committed API snapshot | every-pr | Release automation mistaken for API compatibility evidence; running it for unpublished binaries |
| `docs` | Built-in: rustdoc (`RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features`) | - | Built-in | `mdBook`: narrative guides beside the API reference; `cargo-rdme`: README generated from crate docs | rustdoc with `mdBook` for a guide | every-pr | Indiscriminate `--all-features` with conflicting features; docs.rs metadata missing for feature-gated items |

## Tradeoffs

### types

- **cargo check**: wins as the fast, built-in whole-target type check; costs no proofs beyond the compiler.
- **Kani**: wins for proving bounded properties of critical code; costs harness writing and long runs.

### sast

- **semgrep**: wins as the shared engine with tested Rust rules; costs the rule licence terms for some packs.
- **Opengrep**: wins where the Semgrep CE licence does not fit; costs a younger fork and fewer tested Rust rules.
- **codeql**: wins for GitHub code scanning with data flow; costs limited Rust query coverage and a licence for private repositories.

### memory-safety

- **Miri**: wins at catching undefined behaviour in unsafe Rust, with `MIRIFLAGS=-Zmiri-many-seeds` for scheduling; costs speed, nightly and no FFI.
- **cargo-careful**: wins as a cheap nightly run with extra std checks (`cargo +nightly careful test`); costs coverage far below Miri.
- **AddressSanitizer or ThreadSanitizer**: wins on FFI and native code; costs nightly `-Zsanitizer=address|thread` with `-Zbuild-std`.
- **Valgrind**: wins when nightly is unavailable; costs speed and noisy output.

### dep-audit

- **cargo-deny**: wins by covering advisories, licences, bans and sources in one config; costs a policy file to maintain.
- **cargo-audit**: wins as a simple advisory-only scan; costs no licence, ban or source policy.
- **osv-scanner**: wins when one scanner must serve every language; costs less Cargo feature and target awareness.

### unused-deps

- **cargo-shear**: wins on AST-based detection and active development; costs misreports on macro-heavy code.
- **cargo-machete**: wins on speed with no build; costs regex false positives.
- **cargo-udeps**: wins on accuracy; costs nightly and a full build.

### api-break

- **cargo-semver-checks**: wins as a rustdoc-based lint gate for published libraries; costs coupling to rustdoc JSON and no checks for behaviour changes.
- **cargo-public-api**: use only where a committed API snapshot is wanted; wins at showing the exact API diff for review; costs nightly and no pass-or-fail rules.

### docs

- **mdBook**: wins for narrative guides; costs a second build and links to keep in sync.
- **cargo-rdme**: wins at keeping the README equal to crate docs; costs a generated file (or use `#![doc = include_str!("../README.md")]` instead).

## Language-specific

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Unsafe inventory | `cargo-geiger` `>= 0.14` for review targeting | Direct unsafe-boundary audit | Unsafe count as risk score or safety proof. |
| Dependency review | `cargo-vet` `>= 0.10` | Existing equivalent reviewed trust policy | Provenance mistaken for harmless code. |
| Library docs lint | `missing_docs` for published libraries; docs.rs metadata | Private crates | `#![deny(missing_docs)]` on binaries. |
| Unsafe policy | `#![forbid(unsafe_code)]` where no unsafe is needed | Audited unsafe modules with Miri coverage | Blanket `allow(unsafe_code)`. |

## Rules

- Skip memory-safety tooling for a crate with `#![forbid(unsafe_code)]` and no unsafe dependency in scope; report it as not applicable.
- Review the full target and feature matrix and the lockfile, not only direct dependencies. Check supported feature and target combinations before deleting an unused-dependency finding.
- Assign owners and expiry to suppressions, and schedule rescans.

- Lint baseline rules and `clippy.toml` test exemptions are in `lang-rust-quality`; `cargo-shear` is the gate, `cargo-machete` the quick local pass (never both as gates).

- Use `obi1kenobi/cargo-semver-checks-action@v2` for semver checks in CI.

## Sources

- [Clippy](https://doc.rust-lang.org/clippy/), [rustdoc lints](https://doc.rust-lang.org/rustdoc/lints.html), [docs.rs metadata](https://docs.rs/about/metadata), [mdBook](https://github.com/rust-lang/mdBook).
- [Miri](https://github.com/rust-lang/miri), [cargo-careful](https://github.com/RalfJung/cargo-careful), [Kani](https://github.com/model-checking/kani).
- [cargo-deny](https://github.com/EmbarkStudios/cargo-deny), [cargo-audit](https://github.com/rustsec/rustsec), [cargo-shear](https://github.com/Boshen/cargo-shear), [cargo-machete](https://github.com/bnjbvr/cargo-machete), [cargo-udeps](https://github.com/est31/cargo-udeps).
- [cargo-semver-checks](https://github.com/obi1kenobi/cargo-semver-checks), [cargo-public-api](https://github.com/cargo-public-api/cargo-public-api), [cargo-rdme](https://github.com/orium/cargo-rdme).
