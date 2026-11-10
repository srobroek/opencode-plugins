# Changelog

## [1.0.0](https://github.com/srobroek/opencode-plugins/compare/ast-grep--v0.2.0...ast-grep--v1.0.0) (2026-11-10)


### ⚠ BREAKING CHANGES

* **ast-grep:** the plugin no longer registers the ast-grep MCP server or reads the mcp option; agents run the ast-grep CLI through the shell.

### Features

* **ast-grep:** drop the MCP server for the CLI; add Semgrep, Serena and rust-analyzer guidance ([42c0b1c](https://github.com/srobroek/opencode-plugins/commit/42c0b1cf599bdf95611e06455afb3298c1f70bd5))


### Documentation

* **ast-grep:** add max_results, kind-with-regex, Rust macro and Go call gotchas ([b5fa7a8](https://github.com/srobroek/opencode-plugins/commit/b5fa7a8e7800c064559c1189a1ee34b828b4efb1))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/ast-grep--v0.1.0...ast-grep--v0.2.0) (2026-10-27)


### Features

* **ast-grep:** add the ast-grep MCP server, gated on the ast-grep binary, and the ast-grep-search skill ([a89994a](https://github.com/srobroek/opencode-plugins/commit/a89994adf07cb25fed98662407c5eaa2615d9693))
