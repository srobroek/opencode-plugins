# Changelog

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
