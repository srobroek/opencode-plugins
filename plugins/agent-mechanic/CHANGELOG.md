# Changelog

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/agent-mechanic--v0.5.0...agent-mechanic--v0.6.0) (2026-11-20)


### Features

* **agent-mechanic:** allow toolchain-languages and its router to mechanic ([0165e31](https://github.com/srobroek/opencode-plugins/commit/0165e310f5accbd682714545a8a16a263894de1b))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **plugin-audit:** add plugin_audit_scan tool and plugin-audit skill ([d400433](https://github.com/srobroek/opencode-plugins/commit/d4004330e9a922d8e832b6f3266502141eaea4a3))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/agent-mechanic--v0.4.0...agent-mechanic--v0.5.0) (2026-11-19)


### Features

* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))


### Bug Fixes

* **agents:** let read-only agents load quality and lang skills ([#208](https://github.com/srobroek/opencode-plugins/issues/208)) ([6eac5c5](https://github.com/srobroek/opencode-plugins/commit/6eac5c52afa176c0463755cef4d9871092192fa2))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/agent-mechanic--v0.3.0...agent-mechanic--v0.4.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/agent-mechanic--v0.2.1...agent-mechanic--v0.3.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/agent-mechanic--v0.2.0...agent-mechanic--v0.2.1) (2026-10-27)


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/agent-mechanic--v0.1.0...agent-mechanic--v0.2.0) (2026-10-27)


### Features

* **agent-mechanic:** mechanic subagent for mechanical edits ([8c02def](https://github.com/srobroek/opencode-plugins/commit/8c02def8db2cd5e451c8cb653e073166dfdeff80))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
