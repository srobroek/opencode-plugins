---
name: lang-rust-quality
description: Use to run Rust format, lint, and test checks with the project toolchain.
metadata:
  opencode/autoinvoke: false
---

# Rust Quality

Run the checks through the shell tool from the crate or workspace root (the
directory with `Cargo.toml`):

| Step | Command |
| --- | --- |
| Format check | `cargo fmt --check` |
| Lint | `cargo clippy --all-targets --all-features -- -D warnings` |
| Test | `cargo nextest run` and `cargo test --doc` |
| Docs | `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features` |
| Dependencies | Configured `cargo deny check` and an unused-dependency check (`cargo shear` or `cargo machete`), preferably through the project's `just` tasks |
| API break (published libraries) | `cargo semver-checks` (the gate; `cargo-public-api` only for a committed API snapshot) |
| Mutation (changed code) | `cargo mutants --in-place --no-shuffle --in-diff git.diff` |
| Undefined behaviour (unsafe code) | `cargo +nightly miri nextest run` or `cargo +nightly careful test` |
| Format fix | `cargo fmt` |

Run them in that order and stop at the first failure you need to fix. In a
workspace, add `--workspace` to clippy and test, or `-p <crate>` to narrow them.

Default to `cargo-nextest` locally and in CI; run `cargo test --doc` beside it because
nextest does not run doc tests. It provides process-per-test isolation, parallelism,
retries that mark flaky tests, partitioning, and JUnit output. Costs are a separate
binary and doctest run; assumptions about state shared across tests in one process
break, usually revealing an isolation bug. Shared files, ports, and databases still
need isolation. Keep retries off by default. Use plain `cargo test` only when nextest
cannot be installed.

Unused-dependency tools: keep both `cargo-shear` and `cargo-machete` available and say which one a project runs. Their READMEs describe different trade-offs. `cargo-machete` calls itself "fast (yet imprecise)" and documents a false-positives section. `cargo-shear` parses sources with rust-analyzer's parser, checks all workspace members and offers `--fix`; it does not evaluate `cfg`, so references in disabled branches count as usage, and it can miss macro-generated references unless you pass `--expand` (nightly). Use `cargo-shear` as the gate. Use `cargo-machete` for a quick local pass and expect to triage false positives; sources: [cargo-shear README](https://github.com/Boshen/cargo-shear#readme), [cargo-machete README](https://github.com/bnjbvr/cargo-machete#readme). Never gate on both.

Keep the scaffold's configured deny gate: deny covers advisories, licences, bans and
sources. Unused dependencies use one tool (`cargo-shear` by default, `cargo-machete` for
speed, nightly `cargo-udeps` for accuracy); they do not replace rustc `dead_code`
warnings. Check supported feature/target combinations before deleting findings, and do
not stack the scanners as mandatory gates.

Run mutation under the default `cargo test` so doctests count; `--test-tool=nextest`
skips them. A test-only diff selects no mutants. Run Miri or `cargo careful` on a
schedule for crates with unsafe code, and skip them under `#![forbid(unsafe_code)]` only when no unsafe dependency is in scope.
Run `cargo semver-checks` for published libraries only.

Tool choices per concern are in `lang-rust-libraries`' `references/testing.md` and
`references/quality.md`. Install policy: detect the tool, recommend the install command
(`cargo binstall`, `cargo install --locked`, `rustup component add`), and ask the user
before installing; report a declined or missing tool as not run. For cognitive complexity,
run Lizard (`lizard -Ecognitive --CogC 15 src`) after checking its scores on a few
representative files, or SonarQube Cloud or Server; do not gate on Clippy
`cognitive_complexity`, which is not Sonar-equivalent and skips tests and macros.

After an edit that spans files or changes a signature, run `cargo check --all-targets`
(add `--workspace` in a workspace) once before handing back, or the project's own
script or `just`/`make` target for it when it has one.

CI runs the same steps with `--locked`; the Rust-specific workflow settings are in
`lang-rust-ci`.

In OpenCode, formatting after an edit is the host's job: with `"formatter": true` in
`opencode.json`, the built-in `rustfmt` formatter rewrites each `.rs` file after the
`edit`, `write` or `patch` tool changes it. `cargo fmt --check` still belongs in the
check, because files changed outside those tools are not formatted.

A missing `Cargo.toml` or `cargo` means the check did not run. Report it as not run,
never as a pass. Read failures as the project's actual toolchain output; do not
invent extra linters.

In OpenCode, the rust plugin refuses edits to a committed migration: only the
highest-numbered entry under a `migrations/` directory is editable. Write a new
migration instead.

## Lint baseline

- **Rule:** in `[workspace.lints.clippy]` set `pedantic = { level = "warn", priority = -1 }` and add restriction lints deliberately: `unwrap_used`, `expect_used`, `panic`, `clippy::todo`, `unimplemented`, `dbg_macro`, `print_stdout` and `print_stderr` (libraries), `allow_attributes_without_reason`, `undocumented_unsafe_blocks`, `clone_on_ref_ptr`, and `indexing_slicing` and `string_slice` in code that parses untrusted text. Enable `nursery` lints one by one, never as a group. CI runs clippy with `-D warnings`.
- **Rule:** `#[allow]` and `#[expect]` need `reason = "..."`, and only where the lint blocks. Prefer `#[expect]`, which warns when it is no longer needed. Never allow a lint crate-wide to silence new code.
- **Rule:** exempt tests in `clippy.toml` (`allow-unwrap-in-tests`, `allow-expect-in-tests`, `allow-panic-in-tests`, `allow-indexing-slicing-in-tests`, `allow-dbg-in-tests`, `allow-print-in-tests`), not with attributes.
- **Rule:** a rollout with a large backlog may use crate-level allows marked `TEMPORARY`, each with a `reason` naming a tracked task; new code never grows them and the count only falls.
- **Note:** `missing_docs_in_private_items` is usually too noisy; use `missing_docs` for published libraries (see `lang-rust-libraries`' `references/quality.md`).
- **Why:** the restriction lints turn the error, logging and panic rules into compiler output; a reason makes each exception reviewable, and a tracked task keeps a migration from becoming permanent.
- **Source:** [Clippy lint groups](https://doc.rust-lang.org/clippy/lints.html), [Clippy configuration](https://doc.rust-lang.org/clippy/configuration.html), [lint attributes and `reason`](https://doc.rust-lang.org/reference/attributes/diagnostics.html#lint-check-attributes), [Cargo `[lints]`](https://doc.rust-lang.org/cargo/reference/manifest.html#the-lints-section).
- **Review check:** any of these: an `allow` or `expect` without a reason, a crate-level allow not marked `TEMPORARY` with a task or one that grew, an unwrap or index in a parser, a missing `-D warnings`, test exemptions set with attributes.

Error, logging, strings and command-line rules: `lang-rust-libraries`' `references/standards.md`. Crate layout rules: `lang-rust-packaging`.

## Results, errors and numeric conversions

- **Rule:** never discard a `#[must_use]` value or a `Result` with `.ok()`, `let _ =` or an unused binding just to satisfy a lint; handle it or propagate it. Where ignoring is right, write `let _ = ...` with a comment, or `#[expect(..., reason = "...")]`, that names why the failure is harmless. Writes, flushes and filesystem or cache operations are never silently ignored.
- **Rule:** `map_err` keeps the source error: wrap it (`#[source]`, `#[from]`, or a field holding the cause). A variant that carries no cause (`.map_err(|_| Error::Io)`) is a defect.
- **Rule:** lossless widening uses `From`/`into` (or a documented widening helper); narrowing uses `try_from` and returns an error; a saturating or truncating `as` cast is acceptable only where saturation or truncation is the specified behaviour, never as a lint workaround.
- **Lints:** `let_underscore_must_use` and `let_underscore_untyped` (restriction) flag a discarded must-use value; `map_err_ignore` (restriction) flags `map_err(|_| ...)`; `unused_io_amount` (correctness) flags an ignored read or write count; `cast_lossless`, `cast_possible_truncation`, `cast_possible_wrap`, `cast_sign_loss` and `cast_precision_loss` (pedantic) flag lossy `as` casts. Enable the restriction lints deliberately, as in the baseline above.
- **Why:** an ignored `Result` turns a failed write or cache operation into silent data loss; a dropped source error removes the cause from the report; a lossy cast changes a value without a signal.
- **Source:** [`#[must_use]`](https://doc.rust-lang.org/reference/attributes/diagnostics.html#the-must_use-attribute), [`TryFrom`](https://doc.rust-lang.org/std/convert/trait.TryFrom.html), [`From`](https://doc.rust-lang.org/std/convert/trait.From.html), [API Guidelines C-GOOD-ERR](https://rust-lang.github.io/api-guidelines/interoperability.html#error-types-are-meaningful-and-well-behaved-c-good-err), [Clippy lint list](https://rust-lang.github.io/rust-clippy/master/index.html).
- **Review check:** `.ok()`, `let _ =` or an unused binding on a `Result` or write, flush, filesystem or cache call with no comment or reasoned `expect`; `map_err` that drops the source; an `as` cast between numeric types with no stated reason.
