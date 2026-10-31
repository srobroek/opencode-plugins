# Changelog

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/speckit--v0.3.1...speckit--v0.4.0) (2026-10-31)


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
