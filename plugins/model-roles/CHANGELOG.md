# Changelog

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
