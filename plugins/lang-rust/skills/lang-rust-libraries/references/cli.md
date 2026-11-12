# CLI and configuration

Use explicit command boundaries and settings precedence for interactive tools and unattended execution.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Arguments | `clap` `4.6` derive | `argh` `0.1` for smaller parsers with sufficient features | Manual parsing once subcommands/help/validation are needed. |
| Interactive prompts | `dialoguer` `0.12` | `inquire` `0.9` for its prompt UX | Prompts in CI, redirected input or noninteractive mode. |
| TUI | `ratatui` `0.30` | Plain output for scripts | Assuming full-screen terminal behavior works when redirected. |
| Progress/output | `indicatif` `0.18`, `console` `0.16` | Plain structured output for pipelines | Progress/color escapes in machine-readable stdout. |
| Layered settings | `config` `0.15` | `figment` `0.10` for profiles/provenance; `envy` `0.4` env-only structs | Unspecified precedence, secret-bearing debug dumps. |
| Local env files | `dotenvy` `0.15` for development/tests | Deployment-injected env or secret manager in production | `dotenv` unmaintained; using env files as a production secret manager. |
| Errors | `anyhow` `1` at binary boundary | `miette` `7` for source diagnostics; `eyre` `0.6` with `color-eyre` `0.6` for custom reports | Erasing actionable typed domain errors before classification. |
| HTTP | `ureq` `3.5` for sequential tools | `reqwest` `0.13` when useful async concurrency exists | Async runtime solely by habit. |

## Rules

- Parse once and call testable command functions. Configure output and exit codes explicitly; stdout is results, stderr diagnostics.
- Supply noninteractive options for every prompt. Respect terminal detection, cancellation and bounded network/CPU work.
- Document settings precedence and validate after merging. Install logging/telemetry once in the binary, and flush at exit.
- Desktop apps use `lang-rust-tauri`, not CLI configuration assumptions.

## Sources

- [Clap](https://crates.io/crates/clap), [parser comparison](https://github.com/rust-cli/argparse-benchmarks-rs), [Ratatui](https://crates.io/crates/ratatui).
- [Config](https://docs.rs/config/latest/config/), [Figment](https://docs.rs/figment/latest/figment/), [Dotenv advisory](https://rustsec.org/advisories/RUSTSEC-2021-0141.html), [Dotenvy](https://github.com/allan2/dotenvy).
