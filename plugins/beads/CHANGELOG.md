# Changelog

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/beads--v0.1.0...beads--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
* **beads:** bundle plugin and write-lock runner into dist, add adapter tests ([dc6bc02](https://github.com/srobroek/opencode-plugins/commit/dc6bc0204c04bc0be2d69b78f528129cf3f15965))
* **beads:** enforce FO-5 bead agent routing on subagent spawns ([7b515b8](https://github.com/srobroek/opencode-plugins/commit/7b515b8762ab398fcce1ee913ef0c985373ec194))
* **beads:** port beads shell gates and V2 adapter ([994f45d](https://github.com/srobroek/opencode-plugins/commit/994f45dbc4afdef572da35eec3b726bec1394c6e))
* **beads:** stop nudge, guarded claim release, lease heartbeat, session-start advisories and skills ([2ae103a](https://github.com/srobroek/opencode-plugins/commit/2ae103a473f57ae99d5d6f57abae984a69362946))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))


### Bug Fixes

* **beads:** give the binary-hook git probe 5 s instead of 1 s ([01d034d](https://github.com/srobroek/opencode-plugins/commit/01d034d8eaec25ef4bb5540bcfc81dd3391db316))
* **beads:** guard bd subprocesses against lost exit events ([6ad305f](https://github.com/srobroek/opencode-plugins/commit/6ad305f388ea6120cee6039e40ddca99222b61f3))
* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))


### Performance

* **beads:** route the four listed Beads skills through one beads-guide listing entry ([c4de10c](https://github.com/srobroek/opencode-plugins/commit/c4de10c34fdaf09c503011895f8aef8994c32fe3))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))


### Documentation

* **beads:** document gates, options and runner permissions ([5ce95d9](https://github.com/srobroek/opencode-plugins/commit/5ce95d9e9d9e91eec50705fa5b119b9462342b9b))
