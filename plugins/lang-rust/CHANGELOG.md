# Changelog

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/lang-rust--v0.5.0...lang-rust--v0.6.0) (2026-11-20)


### Features

* **agents:** follow lang skills and the repo engineering doc, report departures ([#267](https://github.com/srobroek/opencode-plugins/issues/267)) ([2c15755](https://github.com/srobroek/opencode-plugins/commit/2c15755d62faed398c8f3ce4747a61d1c92ff00c))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **plugin-audit:** add plugin_audit_scan tool and plugin-audit skill ([d400433](https://github.com/srobroek/opencode-plugins/commit/d4004330e9a922d8e832b6f3266502141eaea4a3))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/lang-rust--v0.4.0...lang-rust--v0.5.0) (2026-11-19)


### Features

* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))
* **toolchain:** prescriptive testing and quality concerns for every language ([2cbcb66](https://github.com/srobroek/opencode-plugins/commit/2cbcb66c2e4589eccf2553d324d83680744cd6d7))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/lang-rust--v0.3.0...lang-rust--v0.4.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/lang-rust--v0.2.0...lang-rust--v0.3.0) (2026-11-12)


### Features

* **quality:** OpenFeature flags with a flags.yaml, SSM or AppConfig provider; code and storage guidance ([20baffa](https://github.com/srobroek/opencode-plugins/commit/20baffae842836d814f1f5c3e2cd410c5bde0dd4))
* **quality:** research-first engineering standards and per-language library standards for every coding agent ([09e8d46](https://github.com/srobroek/opencode-plugins/commit/09e8d461bb2b7654788a588ef6932929ff564d28))
* **quality:** testing standards: behavior tests, test budget, same-change maintenance, reviewers check test changes ([dcdf941](https://github.com/srobroek/opencode-plugins/commit/dcdf9413b6793ed06ef8978a0084d9f50d30b00c))
* **toolchain:** compare Connect, gRPC and OpenAPI, and use Connect for RPC beside Hono for HTTP ([d62b5c7](https://github.com/srobroek/opencode-plugins/commit/d62b5c79f355c687a9d53333c64cc583dcabfea8))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/lang-rust--v0.1.0...lang-rust--v0.2.0) (2026-10-27)


### Features

* **lang-rust:** cargo check once after multi-file or signature edits ([4223d51](https://github.com/srobroek/opencode-plugins/commit/4223d518d7379c017b371d9b849bee3ecb6f7b51))
* **lang-rust:** content-only lang-rust plugin with the lang-rust router and lang-rust-* skills ([e4550e2](https://github.com/srobroek/opencode-plugins/commit/e4550e2124e80efe3b1f9eeaa2e9b1a488aaa415))
* **lang-rust:** merge crate and workspace skills into lang-rust-packaging, add lang-rust-testing, and drop skills moved to quality ([f5b9be5](https://github.com/srobroek/opencode-plugins/commit/f5b9be5b9330116ee5872a522f054fda7dd619ed))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Documentation

* add repomix to the manual-test install loop ([d411160](https://github.com/srobroek/opencode-plugins/commit/d41116016e8a7f7390046cc8aca70f58b7c2ab22))
