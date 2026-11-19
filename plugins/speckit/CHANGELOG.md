# Changelog

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.7.1...speckit--v0.8.0) (2026-11-19)


### Features

* beads, speckit and journeys in Claude Code; translated subagents instead of raw OpenCode agents ([e5fcc23](https://github.com/srobroek/opencode-plugins/commit/e5fcc2338e0846cbebc3370f65826cf2edf137bc))
* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* stop long tools and their processes on ToolContext.signal ([94c0ac5](https://github.com/srobroek/opencode-plugins/commit/94c0ac59e12df53eee73d3152da8523f10148bb0))


### Bug Fixes

* **beads:** decide the actor gate on the parsed command, not re-joined argv ([#187](https://github.com/srobroek/opencode-plugins/issues/187)) ([9eaabde](https://github.com/srobroek/opencode-plugins/commit/9eaabde95f1dd57d0a650a8c6435455c004e28d2))
* **beads:** keep process-global state and lock registries compatible across plugin versions ([#224](https://github.com/srobroek/opencode-plugins/issues/224)) ([8922608](https://github.com/srobroek/opencode-plugins/commit/892260873a5899c2ab24fffdbd7979ba0d24c426))
* **beads:** wait for a busy ledger with backoff and say retry ([#186](https://github.com/srobroek/opencode-plugins/issues/186)) ([b2e02a9](https://github.com/srobroek/opencode-plugins/commit/b2e02a97afca90958b81e0c3a37ed5974e56afe6))
* **speckit:** spec agent commits, resumes, analyzes and creates tasks safely ([d08fcf1](https://github.com/srobroek/opencode-plugins/commit/d08fcf18090b0b9a5e906cf882484758bf9d16ca))

## [0.7.1](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.7.0...speckit--v0.7.1) (2026-11-16)


### Bug Fixes

* **beads:** name the ledger in PR-link refusals, point cd refusals at workdir, warn on cross-repo bd create ([#180](https://github.com/srobroek/opencode-plugins/issues/180)) ([fae4ced](https://github.com/srobroek/opencode-plugins/commit/fae4cede5ac9af61d6261db4256f787fb1c7334e))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.6.0...speckit--v0.7.0) (2026-11-13)


### Features

* **beads:** support per-project ledger stores ([#149](https://github.com/srobroek/opencode-plugins/issues/149)) ([af200e8](https://github.com/srobroek/opencode-plugins/commit/af200e8726bf029069a17919ca9c38ec8cbd657c))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.5.0...speckit--v0.6.0) (2026-11-12)


### Features

* **safety:** refuse direct 1Password reads and literal secrets in commands, pointing to fnox ([#131](https://github.com/srobroek/opencode-plugins/issues/131)) ([36cd391](https://github.com/srobroek/opencode-plugins/commit/36cd3912e954c1078b808802b069d7010d8f319f))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.4.0...speckit--v0.5.0) (2026-11-11)


### Features

* **agent-efficiency:** add lead routing, a foreground sleep guard and subagent scratch reminders ([#122](https://github.com/srobroek/opencode-plugins/issues/122)) ([34bdb2d](https://github.com/srobroek/opencode-plugins/commit/34bdb2d512109065956f88397bd2dc8e6e99ecd3))
* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.3.1...speckit--v0.4.0) (2026-11-03)


### Features

* **claude-compat:** load trusted Claude Code plugins per project ([#89](https://github.com/srobroek/opencode-plugins/issues/89)) ([5143689](https://github.com/srobroek/opencode-plugins/commit/5143689de3933c3fe8a266d94e0e1355dfb42229))

## [0.3.1](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.3.0...speckit--v0.3.1) (2026-10-30)


### Refactors

* **lib:** share the beads formula installer and take runtime agent rules ([0efdd40](https://github.com/srobroek/opencode-plugins/commit/0efdd40d9b2a2f98118eda686792f0d60f537a81))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.2.1...speckit--v0.3.0) (2026-10-27)


### Features

* **speckit:** add a primary spec agent ([ece9f0b](https://github.com/srobroek/opencode-plugins/commit/ece9f0b9b4c30f38ed50da22a9d52b04452879f8))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))
* **speckit:** continue setup when optional extensions cannot install ([5a94570](https://github.com/srobroek/opencode-plugins/commit/5a945701b3d2ce78d003f5d19fa8802a5dc13dd1))


### Performance

* **speckit:** hide the speckit agents and drop Code Mode ([08040a4](https://github.com/srobroek/opencode-plugins/commit/08040a4a405d7ee4efea79bbd985d22adfa2e7a9))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.2.0...speckit--v0.2.1) (2026-10-27)


### Performance

* **speckit:** decide the workflow text once per session ([db389e5](https://github.com/srobroek/opencode-plugins/commit/db389e54fdff84ece37a3d2fbaedaa978e217e36))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.1.0...speckit--v0.2.0) (2026-10-27)


### Features

* **agent-efficiency:** run bash tool calls as the built-in shell tool ([bdca7d7](https://github.com/srobroek/opencode-plugins/commit/bdca7d779c47d9cd2cdc6db8d8a8d5f78a3ba8cc))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))
* **speckit:** compose speckit-verify from the review core ([b518409](https://github.com/srobroek/opencode-plugins/commit/b5184097b5f61e77dedc57f6ef810dc5d471a293))
* **speckit:** port SpecKit to OpenCode V2 ([ec0dadd](https://github.com/srobroek/opencode-plugins/commit/ec0daddaea8994556aaae4c8c74afad5e0de0266))


### Bug Fixes

* **speckit:** drop the review extension ([11deaee](https://github.com/srobroek/opencode-plugins/commit/11deaeea0b1a3fdfa413984b0d7b5ac4d7faba32))


### Performance

* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
