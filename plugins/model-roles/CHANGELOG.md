# Changelog

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.7.0...model-roles--v0.8.0) (2026-11-20)


### Features

* **model-roles:** run regional Bedrock models as their global profile ([6de2603](https://github.com/srobroek/opencode-plugins/commit/6de2603e0cc03e066afb28d9471a9459706c9c63))
* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))


### Refactors

* **lib:** one MCP tool grant table for the tools option ([f8cc1d8](https://github.com/srobroek/opencode-plugins/commit/f8cc1d817d62b211b712d1889200f7c91f049c89))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.6.0...model-roles--v0.7.0) (2026-11-19)


### Features

* **model-roles:** guard.requireExplicit refuses any spawn that would inherit the session model ([#237](https://github.com/srobroek/opencode-plugins/issues/237)) ([953a0b7](https://github.com/srobroek/opencode-plugins/commit/953a0b79421bb43c969b5586883b4d396a2de906))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.5.0...model-roles--v0.6.0) (2026-11-19)


### Features

* **model-roles:** announce new recommendations with a toast and a badge ([fbbdb93](https://github.com/srobroek/opencode-plugins/commit/fbbdb93141a2ad7039c0d1265093d88f63329144))
* **model-roles:** assess explored arms and recommend through /tiers ([7ac8e89](https://github.com/srobroek/opencode-plugins/commit/7ac8e8905d2d46126c738d2b2feca514a9748819))
* **model-roles:** handle context-length failures; recent health history in model_roles_check ([152b39c](https://github.com/srobroek/opencode-plugins/commit/152b39ce7b7706c7823f6a18f531091cfde0c54b))
* **model-roles:** opt-in exploration inside a tier, logged with its propensity ([44a317b](https://github.com/srobroek/opencode-plugins/commit/44a317b938fb3682b49c9ab5c52549d95c0299be))
* **model-roles:** record time to first token per spawn and show it in the usage report ([7913f68](https://github.com/srobroek/opencode-plugins/commit/7913f688b3d800727624cad0cf6cd2610f9da33f))
* **model-roles:** runtimeFallback option to turn off retries, cooldowns and outage handling ([#231](https://github.com/srobroek/opencode-plugins/issues/231)) ([c6d51dc](https://github.com/srobroek/opencode-plugins/commit/c6d51dccd8d87eeda21adb5c3600301639a2f778))


### Bug Fixes

* **beads:** decide the actor gate on the parsed command, not re-joined argv ([#187](https://github.com/srobroek/opencode-plugins/issues/187)) ([9eaabde](https://github.com/srobroek/opencode-plugins/commit/9eaabde95f1dd57d0a650a8c6435455c004e28d2))
* **model-roles, beads:** a child's first idle with background work still running is not its end ([528943c](https://github.com/srobroek/opencode-plugins/commit/528943cb9186dfed871118c42a51529fac2c640b))
* **model-roles:** keep snapshots of resumable children; the tool-error overflow note never claims a switch ([bd105f4](https://github.com/srobroek/opencode-plugins/commit/bd105f402ca84c5cc6ef39dbd22cf259b61b485e))
* **model-roles:** the overflow switch respects the guard and never moves a chosen model ([ccd93f6](https://github.com/srobroek/opencode-plugins/commit/ccd93f62eccb73f5061473aaf48c7a0a664370e8))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.4.0...model-roles--v0.5.0) (2026-11-16)


### Features

* **model-roles:** per-tier usage report in model_roles_check and /tiers ([97d0f65](https://github.com/srobroek/opencode-plugins/commit/97d0f6568aab3e559b92132416dd1d8be2804e57))
* **model-roles:** record review verdicts, test results and test-file edits per spawn ([d4a624b](https://github.com/srobroek/opencode-plugins/commit/d4a624b5887f428015e30a894a8fcf20ddd0304a))


### Bug Fixes

* **model-roles:** the guard applies to resumed subagents; a refused model is switched to the tier's allowed one ([4ebeedc](https://github.com/srobroek/opencode-plugins/commit/4ebeedcb28f2659de56c49731ee653826f6e05e9))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.3.1...model-roles--v0.4.0) (2026-11-14)


### Features

* **model-roles:** record an outcome ledger per spawn ([26b6578](https://github.com/srobroek/opencode-plugins/commit/26b65789da10eb4f323685ad65764abb5764237e))


### Bug Fixes

* **model-roles:** a child keeps its resolved model and effort for its lifetime and on resume ([e2596dc](https://github.com/srobroek/opencode-plugins/commit/e2596dc58e4a63cce2edfea5eb55f7926b8ac641))

## [0.3.1](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.3.0...model-roles--v0.3.1) (2026-11-14)


### Bug Fixes

* **model-roles:** /tiers Agents screen lists every agent and edits its tier ([234e712](https://github.com/srobroek/opencode-plugins/commit/234e7124b65317cfd4e5843bc2c9adc86bc4857e))
* **model-roles:** one notice per provider outage instead of one per failed attempt ([0745fe6](https://github.com/srobroek/opencode-plugins/commit/0745fe66e35e884cadc2b75c1fe2a98e46befe4b))
* **model-roles:** tiers follow the effective config entry; atomic config writes with a rolling backup ([27ff926](https://github.com/srobroek/opencode-plugins/commit/27ff926cc4d8ead79ee31f240eea272c3441568e))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.2.2...model-roles--v0.3.0) (2026-11-13)


### Features

* **model-roles:** /tiers editor with model checkboxes, fallback order, per-model effort and a saved draft ([f5b9f20](https://github.com/srobroek/opencode-plugins/commit/f5b9f203144627e31e4c966318a0c716048cbf33))


### Bug Fixes

* **model-roles:** effort for custom and auto tiers, live config after /tiers saves, spawn receipts, validation and precedence docs ([ad60e50](https://github.com/srobroek/opencode-plugins/commit/ad60e50f01729b45c181a3e1793f79948f0ab9e9))

## [0.2.2](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.2.1...model-roles--v0.2.2) (2026-11-03)


### Bug Fixes

* **model-roles:** sit models out only when they stay down or flap ([#88](https://github.com/srobroek/opencode-plugins/issues/88)) ([992034a](https://github.com/srobroek/opencode-plugins/commit/992034a269acf8affb6be9a87706d043de1c9e1d))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.2.0...model-roles--v0.2.1) (2026-10-27)


### Performance

* **model-roles:** freeze the subagent tier parameter per session ([44c179e](https://github.com/srobroek/opencode-plugins/commit/44c179e4c6ad559b5b26df77fcce2729a5598f95))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/model-roles--v0.1.0...model-roles--v0.2.0) (2026-10-27)


### Features

* **model-roles:** /tiers TUI dialog writes tiers to the global config ([d0bb52c](https://github.com/srobroek/opencode-plugins/commit/d0bb52caeea0c2f05d3238203d95373dc389557a))
* **model-roles:** guard subagent spawns that would inherit an expensive session model ([5796f94](https://github.com/srobroek/opencode-plugins/commit/5796f94c3cec08ee5cbf068b0cadb905b716e03e))
* **model-roles:** let the spawner choose a role per subagent call ([bb3371f](https://github.com/srobroek/opencode-plugins/commit/bb3371f245b9661b0ca86883a29c08196f3d75e3))
* **model-roles:** opt-in auto decider picks a role for unroled spawns ([baff8d8](https://github.com/srobroek/opencode-plugins/commit/baff8d8d6286b2135f5e628e82e0b9eb18daef36))
* **model-roles:** resolve agent model roles to the first available candidate ([34aad99](https://github.com/srobroek/opencode-plugins/commit/34aad9999af3197e4ce6922bb935ae71b5dfadd3))
* **model-roles:** runtime model fallback, role subagents and model_roles_check ([d822e67](https://github.com/srobroek/opencode-plugins/commit/d822e672b7720406c6cd0924e3f6a57d43267a9a))
* **model-roles:** switch failing requests in the retry hook with scoped cooldowns, and guard explicit model overrides ([e2bd386](https://github.com/srobroek/opencode-plugins/commit/e2bd3869b7365af9fb401c4fa71ce77e2a3cd23d))
* **model-roles:** tiers derived from the catalog, reviewer tier and one-time classification ([4265016](https://github.com/srobroek/opencode-plugins/commit/42650166140c1fada15bda5066d235fdf5fce327))
* **subagent-worktree:** start subagents in a named worktree ([9c20954](https://github.com/srobroek/opencode-plugins/commit/9c209545deb91d7394ff90bb3aaa4ad96f573508))


### Bug Fixes

* **model-roles:** drop #default from notes, shorten the guard refusal, document host retries ([59a4071](https://github.com/srobroek/opencode-plugins/commit/59a4071a02a2f8a7b289fbdd110bc076233d7221))
* **model-roles:** find the running model of sessions on the default or an inherited model ([d1507d9](https://github.com/srobroek/opencode-plugins/commit/d1507d941152a72ceaaca4bb92901510a9f254cf))
* **model-roles:** let user agent model pins win over tiers ([92a2a5b](https://github.com/srobroek/opencode-plugins/commit/92a2a5bda3dc0f2f880dda733994acb38aa93595))
* **model-roles:** treat subscription session and usage limits as spent quota ([1fd9403](https://github.com/srobroek/opencode-plugins/commit/1fd9403c56bacb46949ac8ea335a13dafe2b39e1))


### Performance

* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
