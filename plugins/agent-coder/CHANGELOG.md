# Changelog

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/agent-coder--v0.5.0...agent-coder--v0.6.0) (2026-11-11)


### Features

* **quality:** require quality-code-design only for new behavior, refactors, hard bugs and reviews ([#125](https://github.com/srobroek/opencode-plugins/issues/125)) ([774d73f](https://github.com/srobroek/opencode-plugins/commit/774d73f64e9966cdd1bbad40c13f152d17f2c61d))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/agent-coder--v0.4.0...agent-coder--v0.5.0) (2026-11-11)


### Features

* **agent-coder:** route reviews to code-reviewer and long commands to operator ([#120](https://github.com/srobroek/opencode-plugins/issues/120)) ([8a22f42](https://github.com/srobroek/opencode-plugins/commit/8a22f42b35dec7d47d2b7fcb533df7413de8a481))
* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/agent-coder--v0.3.0...agent-coder--v0.4.0) (2026-10-27)


### Features

* **agent-coder:** allow every lang-* skill by prefix ([21e27f7](https://github.com/srobroek/opencode-plugins/commit/21e27f7b9662cc04c3215bbb6c1b7e3a2970a215))
* **agent-coder:** allow the ast-grep-* skills for coder ([cedb3a7](https://github.com/srobroek/opencode-plugins/commit/cedb3a75638657b10b8e2965434b9c64a4798fc0))
* **lib:** coding-core type-checks after multi-file or signature changes ([ea722cd](https://github.com/srobroek/opencode-plugins/commit/ea722cd31c171b4b08969eaa0e9084c6fda0bdd9))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Performance

* **agent-coder:** allow coding skills by family prefix ([a1e1d3d](https://github.com/srobroek/opencode-plugins/commit/a1e1d3d201a73bdb2c964427f6ad9c828a6f3457))


### Refactors

* **agent-coder:** compose coder from coding-core ([e6032ab](https://github.com/srobroek/opencode-plugins/commit/e6032ab5e1ea4e8c916b5b8d38eff176ee9eb629))


### Documentation

* add repomix to the manual-test install loop ([d411160](https://github.com/srobroek/opencode-plugins/commit/d41116016e8a7f7390046cc8aca70f58b7c2ab22))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/agent-coder--v0.2.0...agent-coder--v0.3.0) (2026-10-27)


### Features

* **agent-coder:** allow the quality-testing and ci-github-actions skills ([11dba4a](https://github.com/srobroek/opencode-plugins/commit/11dba4a934526b4a58315e583c296456dbcd82b4))
* **quality:** quality-profiling method skill with per-language profiling skills ([7786848](https://github.com/srobroek/opencode-plugins/commit/7786848fb2cfe68b6c1c29848644023c6668197f))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/agent-coder--v0.1.0...agent-coder--v0.2.0) (2026-10-27)


### Features

* **agent-coder:** coder subagent for code development with coding tools and skills only ([b01da0b](https://github.com/srobroek/opencode-plugins/commit/b01da0be059d9c72b0c115b74120c7c771532b83))
* **lib:** shared review core composed into agents at build time ([d79c79b](https://github.com/srobroek/opencode-plugins/commit/d79c79b48ba09d5770c7586799f856237f3b00af))
