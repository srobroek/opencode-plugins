# Changelog

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.2.0...architecture--v0.2.1) (2026-10-27)


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Performance

* **architecture:** drop Code Mode and allow skills by family ([83f757a](https://github.com/srobroek/opencode-plugins/commit/83f757a1a830697ca8010814b49b0af28bf840bb))
* **architecture:** trigger the router on mapping components and monorepo layout ([fdc250e](https://github.com/srobroek/opencode-plugins/commit/fdc250e3cfcae6607e9d80e5a06d6bb5a1d008e9))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/architecture--v0.1.0...architecture--v0.2.0) (2026-10-27)


### Features

* **architecture:** add architecture skills and read-only architect agent ([5e46e6e](https://github.com/srobroek/opencode-plugins/commit/5e46e6e8ea2ecb27e1c1def7db9ba0c3f7a5c4a7))
* **architecture:** declare the architect model role ([b2dc547](https://github.com/srobroek/opencode-plugins/commit/b2dc5472127b214e0c5d29fcbea653366e3ae2c8))
* **lib:** carry steps and the model-role header from shipped agent files ([7538ab1](https://github.com/srobroek/opencode-plugins/commit/7538ab1a05b3071564defb2ab11ce356245c3890))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))


### Performance

* **architecture:** route the three architecture skills through one architecture-guide listing entry ([44a463b](https://github.com/srobroek/opencode-plugins/commit/44a463b774d7ed64009869ea7b39d249fde9dfe0))
* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* keep shipped agent descriptions under 150 characters ([7023675](https://github.com/srobroek/opencode-plugins/commit/70236752520b0fd02b872ec61510ec1388028778))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
