# Changelog

## Unreleased

### Features

* Add `options.store` for project-specific ledger paths, canonical shared write locks, and consistent `BEADS_DIR` on plugin commands.

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/beads--v0.5.2...beads--v0.6.0) (2026-11-19)


### Features

* beads, speckit and journeys in Claude Code; translated subagents instead of raw OpenCode agents ([e5fcc23](https://github.com/srobroek/opencode-plugins/commit/e5fcc2338e0846cbebc3370f65826cf2edf137bc))
* **beads:** plan cross-workstream dependencies as contract, stub and swap beads ([43f8af0](https://github.com/srobroek/opencode-plugins/commit/43f8af0730d6da2077e32d4174b9323d678ec9a7))
* **beads:** tell a forked session which claims the original holds ([d093dbe](https://github.com/srobroek/opencode-plugins/commit/d093dbeb758749262e8d3c8f08ac77d388857bc8))
* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))


### Bug Fixes

* **beads:** admit subagent spawns without waiting on the ledger ([#194](https://github.com/srobroek/opencode-plugins/issues/194)) ([a1c7814](https://github.com/srobroek/opencode-plugins/commit/a1c78143cce37f8e9f96b8e004b2d6b9c756627d))
* **beads:** an older instance's shared state no longer crashes idle sessions ([b4efc89](https://github.com/srobroek/opencode-plugins/commit/b4efc895dc65e483bdf849523fc8b24eb2bc326c))
* **beads:** decide the actor gate on the parsed command, not re-joined argv ([#187](https://github.com/srobroek/opencode-plugins/issues/187)) ([9eaabde](https://github.com/srobroek/opencode-plugins/commit/9eaabde95f1dd57d0a650a8c6435455c004e28d2))
* **beads:** include delete and ignore steps in the binary-hook repair advisory ([4ee8798](https://github.com/srobroek/opencode-plugins/commit/4ee87982db3b4a0eee39f712c29d60fe10707e43))
* **beads:** keep process-global state and lock registries compatible across plugin versions ([#224](https://github.com/srobroek/opencode-plugins/issues/224)) ([8922608](https://github.com/srobroek/opencode-plugins/commit/892260873a5899c2ab24fffdbd7979ba0d24c426))
* **beads:** stale-import guidance says sync with Dolt, not commit JSONL ([#214](https://github.com/srobroek/opencode-plugins/issues/214)) ([3b264d9](https://github.com/srobroek/opencode-plugins/commit/3b264d9ab82376a3e761562636c9cad799599ccc))
* **beads:** track claims only when the ledger and outcome are certain ([#211](https://github.com/srobroek/opencode-plugins/issues/211)) ([9c35c16](https://github.com/srobroek/opencode-plugins/commit/9c35c16ec10eab256bf58cedd3393e47250de0ed))
* **beads:** track claims under any inherited ledger and warn on agent-run runner claims ([37e9525](https://github.com/srobroek/opencode-plugins/commit/37e95253db0ce6ef59feec799591e66e9bd71bdc))
* **beads:** wait for a busy ledger with backoff and say retry ([#186](https://github.com/srobroek/opencode-plugins/issues/186)) ([b2e02a9](https://github.com/srobroek/opencode-plugins/commit/b2e02a97afca90958b81e0c3a37ed5974e56afe6))
* **model-roles, beads:** a child's first idle with background work still running is not its end ([528943c](https://github.com/srobroek/opencode-plugins/commit/528943cb9186dfed871118c42a51529fac2c640b))


### Documentation

* **beads:** add hooks, sync and backup guidance to beads-setup ([e316c41](https://github.com/srobroek/opencode-plugins/commit/e316c411e3b8fa7fb1fd65818e7798b82e3cb3ff))
* **beads:** make beads-contention-retry and beads-setup pass the strict prose lint ([254253e](https://github.com/srobroek/opencode-plugins/commit/254253e4fca04ca8a40f6f316107c85af0c24a6b))
* **beads:** make the beads-guide pitfalls pass the strict prose lint ([2546404](https://github.com/srobroek/opencode-plugins/commit/25464047abb782ebfb827ea0c21346b269d658eb))

## [0.5.2](https://github.com/srobroek/opencode-plugins/compare/beads--v0.5.1...beads--v0.5.2) (2026-11-16)


### Bug Fixes

* **beads:** name the ledger in PR-link refusals, point cd refusals at workdir, warn on cross-repo bd create ([#180](https://github.com/srobroek/opencode-plugins/issues/180)) ([fae4ced](https://github.com/srobroek/opencode-plugins/commit/fae4cede5ac9af61d6261db4256f787fb1c7334e))


### Documentation

* **skills:** add a per-skill references/pitfalls.md standard and a check ([#178](https://github.com/srobroek/opencode-plugins/issues/178)) ([ff2489a](https://github.com/srobroek/opencode-plugins/commit/ff2489af6aab145e3a5e6be8462d390b43395ae7))

## [0.5.1](https://github.com/srobroek/opencode-plugins/compare/beads--v0.5.0...beads--v0.5.1) (2026-11-13)


### Bug Fixes

* **beads:** steer setup for ledgers outside the checkout ([a3e00df](https://github.com/srobroek/opencode-plugins/commit/a3e00dfaa7622a406e56ceeca1558670fe9168d4))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/beads--v0.4.1...beads--v0.5.0) (2026-11-13)


### Features

* **beads:** support per-project ledger stores ([#149](https://github.com/srobroek/opencode-plugins/issues/149)) ([af200e8](https://github.com/srobroek/opencode-plugins/commit/af200e8726bf029069a17919ca9c38ec8cbd657c))

## [0.4.1](https://github.com/srobroek/opencode-plugins/compare/beads--v0.4.0...beads--v0.4.1) (2026-11-12)


### Bug Fixes

* **beads:** stand down while OpenCode's built-in goal drives a session ([81c7d74](https://github.com/srobroek/opencode-plugins/commit/81c7d742a9890510c7cfb42da90d3ff8b168f107))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/beads--v0.3.0...beads--v0.4.0) (2026-11-12)


### Features

* **safety:** refuse direct 1Password reads and literal secrets in commands, pointing to fnox ([#131](https://github.com/srobroek/opencode-plugins/issues/131)) ([36cd391](https://github.com/srobroek/opencode-plugins/commit/36cd3912e954c1078b808802b069d7010d8f319f))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/beads--v0.2.1...beads--v0.3.0) (2026-11-11)


### Features

* **agent-efficiency:** add lead routing, a foreground sleep guard and subagent scratch reminders ([#122](https://github.com/srobroek/opencode-plugins/issues/122)) ([34bdb2d](https://github.com/srobroek/opencode-plugins/commit/34bdb2d512109065956f88397bd2dc8e6e99ecd3))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/beads--v0.2.0...beads--v0.2.1) (2026-10-27)


### Performance

* **beads:** add the prime text to compaction and generate requests ([477a5ea](https://github.com/srobroek/opencode-plugins/commit/477a5eaeb7dca69c44349769bc991ec2d53bfde4))

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
