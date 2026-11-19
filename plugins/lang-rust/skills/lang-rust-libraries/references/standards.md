# Engineering standards

Checkable Rust rules for errors, logging, user-facing strings, the command line and the Rust version line. Each rule has a why, a source and a review check. Crate layout rules are in `lang-rust-packaging`; lint settings and the unused-dependency tools are in `lang-rust-quality`. A departure needs a stated reason in the PR body or the repo's `docs/engineering.md`; an unexplained one is a review finding.

Checked 2026-11-16.

## Errors

- **Rule:** a library crate returns a typed error built with `thiserror` `>= 2`. A binary reports errors with `anyhow` `>= 1` or one typed CLI error at its edge. A public error or other contract enum or struct (error, config, event, wire type) carries `#[non_exhaustive]`, so adding a variant or field is not a breaking change.
- **Rule:** never `unwrap()` or `expect()` a value that comes from untrusted input (arguments, files, network, environment, user text); return a typed error. `expect("...")` stays acceptable for an invariant the same function just established.
- **Hand-written error type:** acceptable for a tiny closed set (up to about three variants), for `no_std`, when stable error codes must be the type's identity (see User-facing strings), or when the derive's dependency is not worth it. The type still implements `std::error::Error` and `Display` and keeps `source()`.
- **Why:** typed errors let callers match on causes; erased errors are for the edge that only reports. `non_exhaustive` is the Rust API Guidelines' future-proofing rule. A panic on untrusted input is a remotely triggerable crash.
- **Source:** [thiserror](https://docs.rs/thiserror), [anyhow](https://docs.rs/anyhow), [API Guidelines: future proofing](https://rust-lang.github.io/api-guidelines/future-proofing.html), [`non_exhaustive`](https://doc.rust-lang.org/reference/attributes/type_system.html#the-non_exhaustive-attribute).
- **Rule:** `map_err` keeps the source error (`#[source]`, `#[from]` or a wrapping field); the full rule, with ignored-`Result` and numeric-conversion rules, is in `lang-rust-quality`.
- **Review check:** any of these: a library returns `anyhow` or a string error, a `map_err` drops its source, a public contract type lacks `#[non_exhaustive]`, `unwrap`/`expect` on untrusted input, a hand-written error with no stated reason.

## Rendering diagnostics

- **Rule:** the binary renders a user-facing error once, at the edge. For errors that point into text (source files, configuration, input lines) render with `annotate-snippets` (the rustc-aligned renderer: plain data in, string out) or `miette` `>= 7` (derive-based diagnostics with codes, help and a report handler). Plain errors need neither: print the message and the source chain.
- **Why:** a span, a label and a fix hint cost the user less time than a bare message; one renderer keeps format and colour decisions in one place. Libraries return the error and the span; they never print.
- **Source:** [annotate-snippets](https://github.com/rust-lang/annotate-snippets-rs), [miette](https://docs.rs/miette), [rustc diagnostics](https://rustc-dev-guide.rust-lang.org/diagnostics.html).
- **Review check:** a library formats or prints a diagnostic; two renderers in one binary; hand-built ASCII carets.

## Logging

- **Rule:** libraries never print (`println!`, `eprintln!`, `dbg!`) and never install a subscriber; they emit `tracing` events and spans. The binary owns exactly one `tracing-subscriber` registry, configured from an environment variable through `EnvFilter` (for example `RUST_LOG`), and flushes at exit. stdout carries results, stderr diagnostics.
- **Why:** a second global subscriber fails or is silently ignored, and a library that prints corrupts machine-readable output. The `print_stdout`, `print_stderr` and `dbg_macro` lints enforce it.
- **Source:** [tracing](https://docs.rs/tracing/latest/tracing/), [EnvFilter](https://docs.rs/tracing-subscriber/latest/tracing_subscriber/filter/struct.EnvFilter.html), [Clippy lints](https://doc.rust-lang.org/clippy/lints.html). Setup detail: `observability.md`.
- **Review check:** a print macro in a library; a subscriber or `init()` outside the binary; a log level hard-coded instead of read from the environment.

## User-facing strings

- **Rule:** a message a user can read comes from a registry, never a literal at the call site. The registry gives each message a stable code (for example `E0123`) and a named-parameter template (`"cannot read {path}: {reason}"`). The compiler checks it: building a message with a missing or extra parameter fails to compile. Code addresses a message by its typed identifier.
- **Rule:** enforce it in CI crate by crate as each crate migrates: an `ast-grep` rule (or an equivalent lint) rejects a string literal passed to the error or diagnostic constructor or to a print macro, and each migrated crate joins the checked list. New crates start on the list.
- **Rule:** generate the user documentation (the error index, `--explain` text) from the same registry so code, message and docs cannot drift.
- **Rule:** codes are never reused. Keep a lock file of every issued code with its message hash, and a retired list. CI fails when a code leaves the registry without moving to the retired list, or when a retired code reappears.
- **Options:** (a) a project-owned derive macro beside `thiserror` that attaches a code and a template to each error variant, with compile-time parameter checks; the model is rustc's `#[derive(Diagnostic)]`; best when stable codes and generated docs are the goal. (b) Fluent (`fluent-bundle`) with `i18n-embed`: messages live in `.ftl` resources with named arguments; best when localisation is a goal; wrap the message ids in typed identifiers and check resources in a build step. (c) Runtime-key crates such as `rust-i18n` (`t!("key")`) are simple, but keys are string literals resolved at run time: a mistyped key compiles and falls back, so the registry guarantee is gone, and its extractor is marked experimental. Prefer (a) or (b).
- **Why:** literals scatter wording, defeat translation and documentation, and make a message hard to find or retire. Reused codes break scripts and search results that cite them.
- **Source:** [rustc translation](https://rustc-dev-guide.rust-lang.org/diagnostics/translation.html), [diagnostic structs](https://rustc-dev-guide.rust-lang.org/diagnostics/diagnostic-structs.html), [error index](https://doc.rust-lang.org/error_codes/error-index.html), [Fluent](https://projectfluent.org/), [fluent-rs](https://github.com/projectfluent/fluent-rs), [i18n-embed](https://github.com/kellpossible/cargo-i18n), [rust-i18n](https://github.com/longbridge/rust-i18n), [ast-grep](https://ast-grep.github.io/).
- **Review check:** an inline user-facing string in a migrated crate; a code reused, renumbered or deleted without a retired entry; a message without a named-parameter template; docs written by hand beside the registry.

## Command line

- **Rule:** choose clap's builder or derive API once per project and record the choice in `docs/engineering.md`. Do not enable the `derive` feature unless code uses it. A library that owns a subcommand may expose `command()` (the `clap::Command`) and `run()` for the binary to wire; the binary owns parsing, exit codes and the subscriber.
- **Why:** two styles in one tree double the review surface, and an unused derive feature pulls proc-macro compile time and `syn` into every build.
- **Source:** [clap derive reference](https://docs.rs/clap/latest/clap/_derive/index.html), [Cargo features](https://doc.rust-lang.org/cargo/reference/features.html).
- **Review check:** both builder and derive in one project with no recorded reason; a `derive` feature with no derive in the crate; a library that parses `std::env::args`.

## Rust version line

- **Rule:** state the Rust version policy in `docs/engineering.md` instead of a fixed "latest": the toolchain pin (`rust-toolchain.toml`), the declared MSRV in `rust-version`, and how each moves (for example "MSRV is the stable release from six months ago; raising it is a minor version for libraries"). CI tests the MSRV on that toolchain (`cargo-msrv` finds it). Binaries may track the pin; published libraries move MSRV deliberately.
- **Why:** a version written once goes stale, and a declared but untested `rust-version` misleads dependants. The MSRV-aware resolver honours the declared value.
- **Source:** [rust-version](https://doc.rust-lang.org/cargo/reference/rust-version.html), [resolver](https://doc.rust-lang.org/cargo/reference/resolver.html), [cargo-msrv](https://github.com/foresterre/cargo-msrv).
- **Review check:** a `rust-version` bump without the policy or a CI job; a fixed "latest Rust" claim in a doc.

## Related

`lang-rust-packaging` for shared crates and one theme per crate, `lang-rust-quality` for the lint baseline and unused-dependency tools, `quality-code-design`'s `rust.md` for error enums and newtypes.
