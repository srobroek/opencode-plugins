# Changelog

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/delivery--v0.1.0...delivery--v0.2.0) (2026-10-27)


### Features

* **agent-researcher:** move researcher into its own plugin with a delivery fallback ([5b03fdb](https://github.com/srobroek/opencode-plugins/commit/5b03fdb123fd5b1d967c3f52bd69c5e897d1af92))
* **agent-reviewer:** reviewer subagents on a shared review core ([74f29b7](https://github.com/srobroek/opencode-plugins/commit/74f29b73b257531d894e508e957cddd7f9bfd4a3))
* **delivery:** emit model-role headers and defer to model-roles when installed ([2a53139](https://github.com/srobroek/opencode-plugins/commit/2a531399f9483e688e652b485febf7a1533fce45))
* **delivery:** port delivery_land, delivery_cleanup, receipts and delivery agents to V2 ([2ea028e](https://github.com/srobroek/opencode-plugins/commit/2ea028e44498f5138e93dd2e256c6334a99bb522))
* **lib:** honour metadata opencode/autoinvoke in shipped SKILL.md files ([881e7df](https://github.com/srobroek/opencode-plugins/commit/881e7df220095d0155b07437e733fdb795d9279b))
* **lib:** register shipped agent files and content-only plugins ([df7fa53](https://github.com/srobroek/opencode-plugins/commit/df7fa53ac93f0327a1735fcf1e5c6017d0216754))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))


### Bug Fixes

* **delivery:** accept a verdict line below a preamble or inside a code fence ([6ad154e](https://github.com/srobroek/opencode-plugins/commit/6ad154ed08d6d76c27aa38d27c71a54639c0d640))
* **delivery:** build the rebase fixture in one fast-import and time the land interrupt from the abort ([80dd989](https://github.com/srobroek/opencode-plugins/commit/80dd989ed639b6323a3ba72a2d9e208dd170617c))
* **delivery:** raise git read bounds to 5 s and guard lost exits ([2f73194](https://github.com/srobroek/opencode-plugins/commit/2f73194a9c228ed60075331c6d1065f1ae822285))
* **delivery:** run the deadline test's script through /bin/sh so the deadline cannot fire before it starts ([93fc2bd](https://github.com/srobroek/opencode-plugins/commit/93fc2bd29e96c9aec3b5a51147b1c92b1ffdcda7))
* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **model-roles:** let user agent model pins win over tiers ([92a2a5b](https://github.com/srobroek/opencode-plugins/commit/92a2a5bda3dc0f2f880dda733994acb38aa93595))


### Performance

* **delivery:** shrink the fan-out block and gate it on the subagent tool ([927712e](https://github.com/srobroek/opencode-plugins/commit/927712ec0dfa5709df668030ed8ee4e93ae57631))
* give shipped subagents tool allowlists ([014fffb](https://github.com/srobroek/opencode-plugins/commit/014fffb403fd1363f494af84c63bf93074af6d20))
* keep shipped agent descriptions under 150 characters ([7023675](https://github.com/srobroek/opencode-plugins/commit/70236752520b0fd02b872ec61510ec1388028778))
* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
* shorten skill descriptions and hide pure reference skills from the listing ([51841bd](https://github.com/srobroek/opencode-plugins/commit/51841bd68ae7fe809711430fe3430b75b63e81c0))
