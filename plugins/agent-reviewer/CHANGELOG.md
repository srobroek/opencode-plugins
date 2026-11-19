# Changelog

## [0.8.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.7.0...agent-reviewer--v0.8.0) (2026-11-19)


### Features

* beads, speckit and journeys in Claude Code; translated subagents instead of raw OpenCode agents ([e5fcc23](https://github.com/srobroek/opencode-plugins/commit/e5fcc2338e0846cbebc3370f65826cf2edf137bc))
* **modes:** debug, refactor and concept agents ([6369b8a](https://github.com/srobroek/opencode-plugins/commit/6369b8ae6c4ca35c664f094b60c28d356cc13298))
* **safety:** secret_store tool stores a generated or command-issued secret without a shell ([d84a1d2](https://github.com/srobroek/opencode-plugins/commit/d84a1d22b0ff6e72f327fb185c512b2296a80a1e))


### Bug Fixes

* **agents:** let read-only agents load quality and lang skills ([#208](https://github.com/srobroek/opencode-plugins/issues/208)) ([6eac5c5](https://github.com/srobroek/opencode-plugins/commit/6eac5c52afa176c0463755cef4d9871092192fa2))


### Documentation

* **delivery:** add a repository CI and landing standard for parallel agents ([c47d0ef](https://github.com/srobroek/opencode-plugins/commit/c47d0ef303865da47122e79dccff73b5dbf8a36f))

## [0.7.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.6.0...agent-reviewer--v0.7.0) (2026-11-13)


### Features

* **agents:** a tools option that lets read-only and coding agents call allowed MCP tools ([70558c3](https://github.com/srobroek/opencode-plugins/commit/70558c30dc450faec7e6012cdb0f678f1ecd7f01))

## [0.6.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.5.0...agent-reviewer--v0.6.0) (2026-11-12)


### Features

* **quality:** testing standards: behavior tests, test budget, same-change maintenance, reviewers check test changes ([dcdf941](https://github.com/srobroek/opencode-plugins/commit/dcdf9413b6793ed06ef8978a0084d9f50d30b00c))

## [0.5.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.4.0...agent-reviewer--v0.5.0) (2026-11-11)


### Features

* cap every shipped agent with a step limit ([#123](https://github.com/srobroek/opencode-plugins/issues/123)) ([7b3b60f](https://github.com/srobroek/opencode-plugins/commit/7b3b60f84ac4aabcf8d5d649042e26054f79b0f4))

## [0.4.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.3.0...agent-reviewer--v0.4.0) (2026-11-10)


### Features

* **agent-reviewer:** let code-reviewer run ast-grep and semgrep read-only ([f3baf1a](https://github.com/srobroek/opencode-plugins/commit/f3baf1aab2e972ce9aa929e6dabb34442970e206))

## [0.3.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.2.0...agent-reviewer--v0.3.0) (2026-10-27)


### Features

* **agent-reviewer:** allow the ast-grep-* skills for code-reviewer and security-reviewer ([f78c258](https://github.com/srobroek/opencode-plugins/commit/f78c2586a251ee7495ed45db831f3170a71a12b8))


### Bug Fixes

* **lib:** keep a shipped agent hidden when the host prefills hidden: false ([6156c94](https://github.com/srobroek/opencode-plugins/commit/6156c946f8a5265ff5498bb4062a9d822bbd0555))


### Performance

* **agent-reviewer:** allow reviewer skills by family prefix ([3dbe55a](https://github.com/srobroek/opencode-plugins/commit/3dbe55af1c04e50ff011f3487a0d473c12c1a2bf))

## [0.2.0](https://github.com/srobroek/opencode-plugins/compare/agent-reviewer--v0.1.0...agent-reviewer--v0.2.0) (2026-10-27)


### Features

* **agent-reviewer:** reviewer subagents on a shared review core ([74f29b7](https://github.com/srobroek/opencode-plugins/commit/74f29b73b257531d894e508e957cddd7f9bfd4a3))
