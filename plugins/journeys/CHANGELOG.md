# Changelog

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/journeys--v0.4.0...journeys--v0.5.0) (2026-11-20)


### Features

* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/journeys--v0.3.0...journeys--v0.4.0) (2026-11-19)


### Features

* beads, speckit and journeys in Claude Code; translated subagents instead of raw OpenCode agents ([e5fcc23](https://github.com/srobroek/opencode-plugins/commit/e5fcc2338e0846cbebc3370f65826cf2edf137bc))
* **toolchain:** prescriptive testing and quality concerns for every language ([2cbcb66](https://github.com/srobroek/opencode-plugins/commit/2cbcb66c2e4589eccf2553d324d83680744cd6d7))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/journeys--v0.2.1...journeys--v0.3.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/journeys--v0.2.0...journeys--v0.2.1) (2026-10-27)


### Performance

* **journeys:** make the journey agents' allowlists hold and hide them ([d5d0929](https://github.com/srobroek/opencode-plugins/commit/d5d09297e678e394af5910e12c2029d7114a0355))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/journeys--v0.1.0...journeys--v0.2.0) (2026-10-27)


### Features

* **journeys:** give journey-validator a 400-step budget ([fae4055](https://github.com/srobroek/opencode-plugins/commit/fae4055cd480f8dd811737721fb031c23e62b9c6))
* **journeys:** port journeys tools, skills and scribe/validator subagents ([88b9fec](https://github.com/srobroek/opencode-plugins/commit/88b9fec97bde041f9894937e6d2c19f3364447b7))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** register shipped agent files and content-only plugins ([df7fa53](https://github.com/srobroek/opencode-plugins/commit/df7fa53ac93f0327a1735fcf1e5c6017d0216754))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))


### Performance

* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* **journeys:** route the six journey skills through one journeys-guide listing entry ([bf326a7](https://github.com/srobroek/opencode-plugins/commit/bf326a7b5676d098c9a0347d861863d00a8e81d7))
* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
