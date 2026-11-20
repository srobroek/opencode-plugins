# Changelog

## [0.12.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.11.0...quality--v0.12.0) (2026-11-20)


### Features

* **agent-reviewer:** judge reviews against the quality, standards and testing parts ([7669ebf](https://github.com/srobroek/opencode-plugins/commit/7669ebfa5c5311d6a3da796a3cca16a9fbaad268))
* **agents:** follow lang skills and the repo engineering doc, report departures ([#267](https://github.com/srobroek/opencode-plugins/issues/267)) ([2c15755](https://github.com/srobroek/opencode-plugins/commit/2c15755d62faed398c8f3ce4747a61d1c92ff00c))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **plugin-audit:** add plugin_audit_scan tool and plugin-audit skill ([d400433](https://github.com/srobroek/opencode-plugins/commit/d4004330e9a922d8e832b6f3266502141eaea4a3))
* **quality:** allow lang-* and architecture-* skills to adversarial-challenger ([e614877](https://github.com/srobroek/opencode-plugins/commit/e614877191586707aa554bcbf5fbd3eedbbafdb9))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))


### Documentation

* **quality:** list the shipped agents that carry coding-core in their prompt ([9f727f3](https://github.com/srobroek/opencode-plugins/commit/9f727f30c159c294cc25af7a7e2e2b9cc465d12e))

## [0.11.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.10.0...quality--v0.11.0) (2026-11-19)


### Features

* beads, speckit and journeys in Claude Code; translated subagents instead of raw OpenCode agents ([e5fcc23](https://github.com/srobroek/opencode-plugins/commit/e5fcc2338e0846cbebc3370f65826cf2edf137bc))
* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **project:** REUSE guidance for scaffold, code policy and release setup ([c09cf94](https://github.com/srobroek/opencode-plugins/commit/c09cf9454847afa1f73791511f937daef8df93ca))
* **quality:** add stub-and-swap rules to coding and testing standards ([2bdfe9b](https://github.com/srobroek/opencode-plugins/commit/2bdfe9b4755dfc284200dadfb4648e6e9239f3b6))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))
* **toolchain:** prescriptive testing and quality concerns for every language ([2cbcb66](https://github.com/srobroek/opencode-plugins/commit/2cbcb66c2e4589eccf2553d324d83680744cd6d7))


### Bug Fixes

* **safety:** refuse history-rewriting git in a canonical checkout ([#210](https://github.com/srobroek/opencode-plugins/issues/210)) ([515f7ba](https://github.com/srobroek/opencode-plugins/commit/515f7ba36493307fad32de51e48c47197bb31f26))

## [0.10.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.9.0...quality--v0.10.0) (2026-11-16)


### Features

* **quality:** add audit learnings on order, load, leaks and noisy runs ([#170](https://github.com/srobroek/opencode-plugins/issues/170)) ([07964f1](https://github.com/srobroek/opencode-plugins/commit/07964f1e58836ae59ac261dcc692a8d9521e0f83))

## [0.9.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.8.0...quality--v0.9.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.7.0...quality--v0.8.0) (2026-11-13)


### Features

* **quality:** the test audit recommends drops, rewrites, simplifications, new tests and suite practices ([39eca1a](https://github.com/srobroek/opencode-plugins/commit/39eca1a29a13d09bb810320c2288c43ad06b0c6a))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.6.0...quality--v0.7.0) (2026-11-12)


### Features

* **quality:** OpenFeature flags with a flags.yaml, SSM or AppConfig provider; code and storage guidance ([20baffa](https://github.com/srobroek/opencode-plugins/commit/20baffae842836d814f1f5c3e2cd410c5bde0dd4))
* **quality:** quality-test-audit skill with quality_test_summarize and quality_test_compare tools ([6436731](https://github.com/srobroek/opencode-plugins/commit/64367311ec0a20a51a45b8c21aaeb01dad368f23))
* **quality:** research-first engineering standards and per-language library standards for every coding agent ([09e8d46](https://github.com/srobroek/opencode-plugins/commit/09e8d461bb2b7654788a588ef6932929ff564d28))
* **quality:** testing standards: behavior tests, test budget, same-change maintenance, reviewers check test changes ([dcdf941](https://github.com/srobroek/opencode-plugins/commit/dcdf9413b6793ed06ef8978a0084d9f50d30b00c))
* **toolchain:** compare Connect, gRPC and OpenAPI, and use Connect for RPC beside Hono for HTTP ([d62b5c7](https://github.com/srobroek/opencode-plugins/commit/d62b5c79f355c687a9d53333c64cc583dcabfea8))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.5.0...quality--v0.6.0) (2026-11-11)


### Features

* **quality:** require quality-code-design only for new behavior, refactors, hard bugs and reviews ([#125](https://github.com/srobroek/opencode-plugins/issues/125)) ([774d73f](https://github.com/srobroek/opencode-plugins/commit/774d73f64e9966cdd1bbad40c13f152d17f2c61d))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.4.0...quality--v0.5.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.3.0...quality--v0.4.0) (2026-10-27)


### Features

* **quality:** type-check once after multi-file or signature edits ([72871bf](https://github.com/srobroek/opencode-plugins/commit/72871bf9e3005d741eb80fde938beff51eecd06f))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))
* **quality:** quality-profiling loads the exact lang-&lt;language&gt;-profiling id, not the router ([80f44bc](https://github.com/srobroek/opencode-plugins/commit/80f44bc6b6f19ecedfe4f4755b0a7cc0d9dc777d))


### Performance

* **quality:** allow the challenger fallback quality-* skills ([1c85401](https://github.com/srobroek/opencode-plugins/commit/1c8540191f1ec9a979353689ecfd763dc8475b7d))


### Documentation

* add repomix to the manual-test install loop ([d411160](https://github.com/srobroek/opencode-plugins/commit/d41116016e8a7f7390046cc8aca70f58b7c2ab22))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.2.0...quality--v0.3.0) (2026-10-27)


### Features

* **quality:** quality-profiling method skill with per-language profiling skills ([7786848](https://github.com/srobroek/opencode-plugins/commit/7786848fb2cfe68b6c1c29848644023c6668197f))
* **quality:** safe-mutation, persistence, contracts, TypeScript and Python references and a quality-testing skill ([d53491a](https://github.com/srobroek/opencode-plugins/commit/d53491adc07943d68e372db34e61eba2d897d7b3))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/quality--v0.1.0...quality--v0.2.0) (2026-10-27)


### Features

* **agent-reviewer:** reviewer subagents on a shared review core ([74f29b7](https://github.com/srobroek/opencode-plugins/commit/74f29b73b257531d894e508e957cddd7f9bfd4a3))
* **lib:** carry steps and the model-role header from shipped agent files ([7538ab1](https://github.com/srobroek/opencode-plugins/commit/7538ab1a05b3071564defb2ab11ce356245c3890))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))
* **quality:** add code design skills, policy skill and adversarial-challenger agent ([30fb138](https://github.com/srobroek/opencode-plugins/commit/30fb1380855f520943aa8e5b8031eb580bd1b500))
* **quality:** declare the challenger model role ([c16af77](https://github.com/srobroek/opencode-plugins/commit/c16af77f61f6fac3ee8c25f460e2f65d20092f6f))


### Performance

* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* keep shipped agent descriptions under 150 characters ([7023675](https://github.com/srobroek/opencode-plugins/commit/70236752520b0fd02b872ec61510ec1388028778))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
