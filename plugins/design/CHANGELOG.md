# Changelog

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/design--v0.3.1...design--v0.4.0) (2026-10-31)


### Features

* **claude-compat:** load trusted Claude Code plugins per project ([#89](https://github.com/srobroek/opencode-plugins/issues/89)) ([5143689](https://github.com/srobroek/opencode-plugins/commit/5143689de3933c3fe8a266d94e0e1355dfb42229))

## [0.3.1](https://github.com/srobroek/opencode-plugins/compare/design--v0.3.0...design--v0.3.1) (2026-10-30)


### Refactors

* **design:** install formulas through the shared lib installer ([4b6861d](https://github.com/srobroek/opencode-plugins/commit/4b6861d621a1f4e73686ec31248513e489117d56))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/design--v0.2.0...design--v0.3.0) (2026-10-27)


### Features

* **design:** add accessibility-scanner and wire-dsl MCP servers in frontend projects ([9895602](https://github.com/srobroek/opencode-plugins/commit/989560280d8e5c46b09f8cd5012e206473be6da9))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Performance

* **design:** allow the design agents' skills by family ([d273ee4](https://github.com/srobroek/opencode-plugins/commit/d273ee4b201c71dc896b8e682aaccb884a5a9e06))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/design--v0.1.0...design--v0.2.0) (2026-10-27)


### Features

* **design:** add design skills, design rules as skills and four design agents ([9b9b4a8](https://github.com/srobroek/opencode-plugins/commit/9b9b4a8b4b80ea8d06253b644a12ae960fbe6068))
* **design:** compose design-critic and a11y-auditor from the review core ([958003b](https://github.com/srobroek/opencode-plugins/commit/958003b6c99198a8b33036be1ab44c526faf7dda))
* **design:** declare model roles and a 400-step budget for ui-ux-specialist ([6f3a8af](https://github.com/srobroek/opencode-plugins/commit/6f3a8af00c4da1742a839c6b43cd12561b625b06))
* **design:** port the beads formulas and the impeccable detector ([c4780c6](https://github.com/srobroek/opencode-plugins/commit/c4780c6824827c108738f86ceb9f14cbd7ff8806))
* **lib:** carry steps and the model-role header from shipped agent files ([7538ab1](https://github.com/srobroek/opencode-plugins/commit/7538ab1a05b3071564defb2ab11ce356245c3890))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))


### Performance

* **design:** route the ten listed design skills through one design-guide listing entry ([f3c0510](https://github.com/srobroek/opencode-plugins/commit/f3c0510e328683b62e4fada9da8de02310cb2f03))
* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* keep shipped agent descriptions under 150 characters ([7023675](https://github.com/srobroek/opencode-plugins/commit/70236752520b0fd02b872ec61510ec1388028778))
* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
