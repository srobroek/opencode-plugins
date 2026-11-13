# Changelog

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/project--v0.5.0...project--v0.6.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/project--v0.4.0...project--v0.5.0) (2026-11-12)


### ⚠ BREAKING CHANGES

* the srobroek.goal plugin is gone. Remove github:srobroek/opencode-plugins#main::path:plugins/goal from the plugins list. /goal comes from OpenCode itself. The plugin's /loop command has no built-in replacement.

### Features

* **quality:** research-first engineering standards and per-language library standards for every coding agent ([09e8d46](https://github.com/srobroek/opencode-plugins/commit/09e8d461bb2b7654788a588ef6932929ff564d28))


### Refactors

* drop the goal plugin now that OpenCode ships /goal ([dee39af](https://github.com/srobroek/opencode-plugins/commit/dee39afc5f8cdc37f6602ecdb88324f962a3a769))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/project--v0.3.3...project--v0.4.0) (2026-11-12)


### Features

* **project:** let agents store generated and tool-issued secrets themselves in project-secrets ([#130](https://github.com/srobroek/opencode-plugins/issues/130)) ([ceec8c0](https://github.com/srobroek/opencode-plugins/commit/ceec8c0c52a2d15c38c5b8094371888bc3363fa6))
* **project:** restructure project-secrets into a router with per-task fnox references ([#128](https://github.com/srobroek/opencode-plugins/issues/128)) ([8645784](https://github.com/srobroek/opencode-plugins/commit/8645784a7bba4ca45971c815da3903835426d13f))

## [0.3.3](https://github.com/srobroek/opencode-plugins/compare/project--v0.3.2...project--v0.3.3) (2026-11-05)


### Bug Fixes

* **project:** document fixer hooks in the scaffold just check convention ([#112](https://github.com/srobroek/opencode-plugins/issues/112)) ([a417bdc](https://github.com/srobroek/opencode-plugins/commit/a417bdcce2fae1fd66503bbea17f2be73bfe72a3))

## [0.3.2](https://github.com/srobroek/opencode-plugins/compare/project--v0.3.1...project--v0.3.2) (2026-11-05)


### Bug Fixes

* **project:** match project-secrets to live 1Password lookups through the fnox daemon ([#109](https://github.com/srobroek/opencode-plugins/issues/109)) ([759b836](https://github.com/srobroek/opencode-plugins/commit/759b836c50021b67c64aa81a3ae37789382d9783))

## [0.3.1](https://github.com/srobroek/opencode-plugins/compare/project--v0.3.0...project--v0.3.1) (2026-11-05)


### Bug Fixes

* **project:** describe the host fnox providers as they are now ([#107](https://github.com/srobroek/opencode-plugins/issues/107)) ([25df1c6](https://github.com/srobroek/opencode-plugins/commit/25df1c6e02194e4c1eb095deaf9922595cdb900d))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/project--v0.2.1...project--v0.3.0) (2026-11-05)


### Features

* **project:** add /new-project with project-scaffold and project-secrets skills ([#105](https://github.com/srobroek/opencode-plugins/issues/105)) ([1c96349](https://github.com/srobroek/opencode-plugins/commit/1c96349220473d0fbc25c8cf2b0ad2c5e052dba4))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/project--v0.2.0...project--v0.2.1) (2026-10-27)


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/project--v0.1.0...project--v0.2.0) (2026-10-27)


### Features

* **lib:** carry steps and the model-role header from shipped agent files ([7538ab1](https://github.com/srobroek/opencode-plugins/commit/7538ab1a05b3071564defb2ab11ce356245c3890))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
* **project:** add license-picker skill ([1b84d3a](https://github.com/srobroek/opencode-plugins/commit/1b84d3aaa9768416bf7709fa5e16abf20c8108d0))


### Performance

* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
