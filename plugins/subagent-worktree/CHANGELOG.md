# Changelog

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
