# Changelog

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/session--v0.1.0...session--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
* **agent-mechanic:** mechanic subagent for mechanical edits ([8c02def](https://github.com/srobroek/opencode-plugins/commit/8c02def8db2cd5e451c8cb653e073166dfdeff80))
* generate Claude Code and Codex marketplaces ([59ae2a2](https://github.com/srobroek/opencode-plugins/commit/59ae2a2775ec41c30b57570f84ce7f7052a49f7f))
* **session:** add session_resume tool and resume-session skill ([3361876](https://github.com/srobroek/opencode-plugins/commit/3361876cd36c2bda94aac8b78edecea9a65ef026))


### Bug Fixes

* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **session:** guard opencode api reads against lost exit events ([1e324c2](https://github.com/srobroek/opencode-plugins/commit/1e324c25e15d502dbe11aaa10d6ddea5e7a100f8))
* **session:** skip git for a directory that no longer exists ([f9eb522](https://github.com/srobroek/opencode-plugins/commit/f9eb5226f5b9b2e8870cf2ff3b6ae1fd279620e7))


### Performance

* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))


### Refactors

* **session:** move the transcript normalizer into lib ([ef1e36e](https://github.com/srobroek/opencode-plugins/commit/ef1e36e7e593380b3737a7c0f77ad75213a53b4d))
