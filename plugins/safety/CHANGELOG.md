# Changelog

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.7.0...safety--v0.8.0) (2026-11-19)


### Features

* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))
* stop long tools and their processes on ToolContext.signal ([94c0ac5](https://github.com/srobroek/opencode-plugins/commit/94c0ac59e12df53eee73d3152da8523f10148bb0))


### Bug Fixes

* **beads:** decide the actor gate on the parsed command, not re-joined argv ([#187](https://github.com/srobroek/opencode-plugins/issues/187)) ([9eaabde](https://github.com/srobroek/opencode-plugins/commit/9eaabde95f1dd57d0a650a8c6435455c004e28d2))
* **safety:** close two history-rewrite gate bypasses ([48c357b](https://github.com/srobroek/opencode-plugins/commit/48c357be482dc207c44003c7a2eea3e16bab47e1))
* **safety:** refuse history rewrites the guard cannot fully parse ([#223](https://github.com/srobroek/opencode-plugins/issues/223)) ([a80d574](https://github.com/srobroek/opencode-plugins/commit/a80d574613789362a4adf8317321eb3ab9f0737b))
* **safety:** refuse history-rewriting git in a canonical checkout ([#210](https://github.com/srobroek/opencode-plugins/issues/210)) ([515f7ba](https://github.com/srobroek/opencode-plugins/commit/515f7ba36493307fad32de51e48c47197bb31f26))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.6.1...safety--v0.7.0) (2026-11-16)


### Features

* **safety:** refuse route53 delete-hosted-zone without a parent-cleanup marker ([#176](https://github.com/srobroek/opencode-plugins/issues/176)) ([ffc4054](https://github.com/srobroek/opencode-plugins/commit/ffc4054b4ae218b8f3e71089f742b6b8cb9095cc))

## [0.6.1](https://github.com/srobroek/opencode-plugins/compare/safety--v0.6.0...safety--v0.6.1) (2026-11-13)


### Bug Fixes

* **safety:** reference-only fnox set for read-only providers, op vault list, and scratch folders without prompts ([9b83124](https://github.com/srobroek/opencode-plugins/commit/9b831248b7b1a73a7f5677bd67153ee3182c0d13))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.5.0...safety--v0.6.0) (2026-11-12)


### Features

* **safety:** refuse direct 1Password reads and literal secrets in commands, pointing to fnox ([#131](https://github.com/srobroek/opencode-plugins/issues/131)) ([36cd391](https://github.com/srobroek/opencode-plugins/commit/36cd3912e954c1078b808802b069d7010d8f319f))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.4.0...safety--v0.5.0) (2026-11-11)


### Features

* **agent-efficiency:** add lead routing, a foreground sleep guard and subagent scratch reminders ([#122](https://github.com/srobroek/opencode-plugins/issues/122)) ([34bdb2d](https://github.com/srobroek/opencode-plugins/commit/34bdb2d512109065956f88397bd2dc8e6e99ecd3))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.3.0...safety--v0.4.0) (2026-11-05)


### Features

* **safety:** redact secret environment values from tool output ([#113](https://github.com/srobroek/opencode-plugins/issues/113)) ([5ca701a](https://github.com/srobroek/opencode-plugins/commit/5ca701adb139a7a93b7134406467dd703fd84dec))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.2.0...safety--v0.3.0) (2026-10-27)


### Features

* **safety:** git-aware migration-edit gate and external_directory check for directory flags ([5f35605](https://github.com/srobroek/opencode-plugins/commit/5f356054281f62e9458007aee836d1942df9e52e))


### Documentation

* list the profiling skills in the marketplace export table ([f40f96c](https://github.com/srobroek/opencode-plugins/commit/f40f96c2adb224704660399730daedee5cbab870))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/safety--v0.1.0...safety--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
* **safety:** add opt-in commit-msg hook that rejects AI attribution ([9973023](https://github.com/srobroek/opencode-plugins/commit/99730231c3d23e184db2565f49e61dca794bcb06))
* **safety:** port safety gates, permission checks, close-keywords and package advisory ([f5ceff9](https://github.com/srobroek/opencode-plugins/commit/f5ceff953fbfe532aaef066acb858195c7a9f34a))


### Bug Fixes

* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **safety:** fail closed when a probe's exit is never reported ([db86eba](https://github.com/srobroek/opencode-plugins/commit/db86eba3a68ebd8d19d9e640cd8463a57e224011))
