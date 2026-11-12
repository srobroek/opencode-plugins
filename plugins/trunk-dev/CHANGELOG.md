# Changelog

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.6.0...trunk-dev--v0.7.0) (2026-11-12)


### Features

* **quality:** OpenFeature flags with a flags.yaml, SSM or AppConfig provider; code and storage guidance ([20baffa](https://github.com/srobroek/opencode-plugins/commit/20baffae842836d814f1f5c3e2cd410c5bde0dd4))
* **trunk-dev:** Flag: none with a reason is valid for a feat with nothing to switch off ([f311c5f](https://github.com/srobroek/opencode-plugins/commit/f311c5fa0c72ed58165f926a987b9fcd9c29e08b))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.5.0...trunk-dev--v0.6.0) (2026-11-12)


### Features

* **safety:** refuse direct 1Password reads and literal secrets in commands, pointing to fnox ([#131](https://github.com/srobroek/opencode-plugins/issues/131)) ([36cd391](https://github.com/srobroek/opencode-plugins/commit/36cd3912e954c1078b808802b069d7010d8f319f))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.4.0...trunk-dev--v0.5.0) (2026-11-11)


### Features

* **quality:** require quality-code-design only for new behavior, refactors, hard bugs and reviews ([#125](https://github.com/srobroek/opencode-plugins/issues/125)) ([774d73f](https://github.com/srobroek/opencode-plugins/commit/774d73f64e9966cdd1bbad40c13f152d17f2c61d))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.3.0...trunk-dev--v0.4.0) (2026-11-11)


### Features

* **agent-efficiency:** add lead routing, a foreground sleep guard and subagent scratch reminders ([#122](https://github.com/srobroek/opencode-plugins/issues/122)) ([34bdb2d](https://github.com/srobroek/opencode-plugins/commit/34bdb2d512109065956f88397bd2dc8e6e99ecd3))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.2.1...trunk-dev--v0.3.0) (2026-10-30)


### Features

* **trunk-dev:** add once-per-session stale branch reminders ([5d7b40c](https://github.com/srobroek/opencode-plugins/commit/5d7b40cd8a3a3bf96298535a58d21c5c3ea3c2c9))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.2.0...trunk-dev--v0.2.1) (2026-10-27)


### Performance

* **trunk-dev:** trigger the router on landing on main and feature flags ([efb0947](https://github.com/srobroek/opencode-plugins/commit/efb0947f2b8d7394a8fb770f5323fd39e1881405))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/trunk-dev--v0.1.0...trunk-dev--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **trunk-dev:** port commit gate, skip-CI and MR advisories, flag-cleanup bead and skills to V2 ([00d6d26](https://github.com/srobroek/opencode-plugins/commit/00d6d26a61b8b2d0c41e736326ec363d3b15122e))


### Performance

* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
* **trunk-dev:** route the three trunk-dev skills through one trunk-dev-guide listing entry ([afe0134](https://github.com/srobroek/opencode-plugins/commit/afe01344094070ab097f84b4b0c9ec0c42741165))
