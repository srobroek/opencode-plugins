# Changelog

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/agent-researcher--v0.6.0...agent-researcher--v0.7.0) (2026-11-20)


### Features

* **agent-researcher:** allow the whats-new skill to researcher ([bdc52c8](https://github.com/srobroek/opencode-plugins/commit/bdc52c82d5b90d25441381d4dbc9d7023663a9ee))
* **agent-researcher:** allow toolchain and aws-guidance skills ([6f4cdb6](https://github.com/srobroek/opencode-plugins/commit/6f4cdb68ccb2d46ee472b0eb26bc4f9d7ef9f0a3))
* **agent-researcher:** carry coding-core standards in the researcher prompt ([fbf6356](https://github.com/srobroek/opencode-plugins/commit/fbf635627177b7043c0dc5c7092155c2e6b0188f))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **plugin-audit:** add plugin_audit_scan tool and plugin-audit skill ([d400433](https://github.com/srobroek/opencode-plugins/commit/d4004330e9a922d8e832b6f3266502141eaea4a3))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/agent-researcher--v0.5.0...agent-researcher--v0.6.0) (2026-11-19)


### Features

* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))


### Bug Fixes

* **agents:** let read-only agents load quality and lang skills ([#208](https://github.com/srobroek/opencode-plugins/issues/208)) ([6eac5c5](https://github.com/srobroek/opencode-plugins/commit/6eac5c52afa176c0463755cef4d9871092192fa2))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/agent-researcher--v0.4.0...agent-researcher--v0.5.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/agent-researcher--v0.3.0...agent-researcher--v0.4.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/agent-researcher--v0.2.0...agent-researcher--v0.3.0) (2026-10-27)


### Features

* **agent-researcher:** allow repomix_pack for researcher ([56867d2](https://github.com/srobroek/opencode-plugins/commit/56867d20cff05af4d65f7d61ffccc28701d303e3))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Performance

* **agent-researcher:** allow only the repomix skill ([5746d1c](https://github.com/srobroek/opencode-plugins/commit/5746d1c8ae5594d71e74bbe3b9ac8e288229e84c))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/agent-researcher--v0.1.0...agent-researcher--v0.2.0) (2026-10-27)


### Features

* **agent-researcher:** move researcher into its own plugin with a delivery fallback ([5b03fdb](https://github.com/srobroek/opencode-plugins/commit/5b03fdb123fd5b1d967c3f52bd69c5e897d1af92))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))


### Bug Fixes

* **model-roles:** let user agent model pins win over tiers ([92a2a5b](https://github.com/srobroek/opencode-plugins/commit/92a2a5bda3dc0f2f880dda733994acb38aa93595))
