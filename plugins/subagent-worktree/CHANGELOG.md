# Changelog

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.3.0...subagent-worktree--v0.4.0) (2026-11-20)


### Features

* plugin scan fixes, wider agent access and the plugin-audit plugin ([9c71525](https://github.com/srobroek/opencode-plugins/commit/9c7152559776aaf80cfed9626d78bafdd845fa9a))
* **subagent-worktree:** give ui-implementer a worktree by default ([b8d1292](https://github.com/srobroek/opencode-plugins/commit/b8d12923a57d616ec53ff0cae2b3e825b26435e6))


### Bug Fixes

* **subagent-worktree:** keep build directories of a child that may still run ([#269](https://github.com/srobroek/opencode-plugins/issues/269)) ([a1954fb](https://github.com/srobroek/opencode-plugins/commit/a1954fb46c2b2f6e325f33be684a4467a889737e))
* **subagent-worktree:** never remove a worktree whose child is still alive ([#239](https://github.com/srobroek/opencode-plugins/issues/239)) ([5695c34](https://github.com/srobroek/opencode-plugins/commit/5695c3492ec2271ec13c8d88339e10fe7771576a))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.5...subagent-worktree--v0.3.0) (2026-11-19)


### Features

* stop long tools and their processes on ToolContext.signal ([94c0ac5](https://github.com/srobroek/opencode-plugins/commit/94c0ac59e12df53eee73d3152da8523f10148bb0))
* **subagent-worktree:** free build dirs, handle closed-unmerged lanes, share delivery helpers ([14db9ad](https://github.com/srobroek/opencode-plugins/commit/14db9ad7a1eee5ca5bfde292b9d5822a5deed662))
* **subagent-worktree:** remove agent worktrees once their work lands ([1cbfd38](https://github.com/srobroek/opencode-plugins/commit/1cbfd38f569bd7ad7d04c99173edb2df55b0351f))


### Bug Fixes

* **subagent-worktree:** refuse a second live writer in a named worktree ([#202](https://github.com/srobroek/opencode-plugins/issues/202)) ([1c66f3e](https://github.com/srobroek/opencode-plugins/commit/1c66f3e9d710c40cc257bda9ea64e9e1a437ad59))
* **subagent-worktree:** send each lane notice once, and never for a worktree that is gone ([5de4799](https://github.com/srobroek/opencode-plugins/commit/5de4799c536cc67ef0b53326c08fcadd9ad034df))

## [0.2.5](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.4...subagent-worktree--v0.2.5) (2026-11-16)


### Bug Fixes

* **subagent-worktree:** ignore the Beads ledger when checking for tracked changes ([#174](https://github.com/srobroek/opencode-plugins/issues/174)) ([7167f51](https://github.com/srobroek/opencode-plugins/commit/7167f51ca2055385e87b901ecfd322c95cd55da2))

## [0.2.4](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.3...subagent-worktree--v0.2.4) (2026-11-13)


### Bug Fixes

* **subagent-worktree:** start the child on the spawn's resolved model and variant ([0f1f2d4](https://github.com/srobroek/opencode-plugins/commit/0f1f2d4bf60c3d04a4bd104f9847e95bf508bbba))

## [0.2.3](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.2...subagent-worktree--v0.2.3) (2026-11-11)


### Bug Fixes

* **subagent-worktree:** ignore worktree on resume, opt coder in, and skip lanes for dirty checkouts ([#121](https://github.com/srobroek/opencode-plugins/issues/121)) ([c1f1c47](https://github.com/srobroek/opencode-plugins/commit/c1f1c47e8d821ee198562dda3199c07446416656))

## [0.2.2](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.1...subagent-worktree--v0.2.2) (2026-11-05)


### Bug Fixes

* **subagent-worktree:** run in place when the repository has no commit yet ([#111](https://github.com/srobroek/opencode-plugins/issues/111)) ([d0ec69f](https://github.com/srobroek/opencode-plugins/commit/d0ec69f3f6f7cba13a5c833a5bf05f7d18ba90be))

## [0.2.1](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.2.0...subagent-worktree--v0.2.1) (2026-10-30)


### Bug Fixes

* **subagent-worktree:** guard lane listing with permission ([85883ff](https://github.com/srobroek/opencode-plugins/commit/85883ff5f9b636cefd5f2bbba000a0ae33d6f477))
* **subagent-worktree:** move sessions before cleanup and skip unneeded lanes ([0671175](https://github.com/srobroek/opencode-plugins/commit/06711754dde181e1613980cc4049d142780ca68e))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/subagent-worktree--v0.1.0...subagent-worktree--v0.2.0) (2026-10-27)


### Features

* **subagent-worktree:** adopt Ensemble merge safety and lane inventory ([0a95bd2](https://github.com/srobroek/opencode-plugins/commit/0a95bd23dd94ff7a5535fa38a31df72c141f1c70))
* **subagent-worktree:** run opted-in subagents in their own worktree ([0586821](https://github.com/srobroek/opencode-plugins/commit/05868212367ced70ce329d56aae68e2e8a606082))
* **subagent-worktree:** start subagents in a named worktree ([9c20954](https://github.com/srobroek/opencode-plugins/commit/9c209545deb91d7394ff90bb3aaa4ad96f573508))


### Bug Fixes

* **lib:** accept numeric signal codes from @types/bun 1.4.4 ([a3d2e42](https://github.com/srobroek/opencode-plugins/commit/a3d2e4225211d1a288fa3fed561e1c9d8e696284))
* **subagent-worktree:** bound git commands and guard lost exit events ([76b17dd](https://github.com/srobroek/opencode-plugins/commit/76b17dd6521f8e9cc6c0b4e20841ee095531f79e))


### Performance

* lead every tool description with a first line under 120 characters ([74b65d9](https://github.com/srobroek/opencode-plugins/commit/74b65d9f446fcc535320b7c320ccaf8482d594df))
