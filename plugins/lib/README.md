# @srobroek/opencode-lib

Shared helpers for the plugins in this repository. This package is internal: it is
not a plugin, has no `Plugin.define`, and is not released on its own. Plugins list it as a `workspace:*` dev dependency and
`scripts/build.ts` inlines it into their `dist/`.

Import a module by path, for example `@srobroek/opencode-lib/tool-targets`, or
everything except the test helpers from `@srobroek/opencode-lib`.

| Module | What it does |
| --- | --- |
| `shell-tokenizer` | Static shell lexer: quotes, separators, `$(`, here-documents. Never evaluates. |
| `shell-command` | Command segments, wrapper-aware invocations, positional `scanShell`, structural `parse`. |
| `command-words` | Drops wrappers (`sudo`, `env`, `timeout`, …) to find the command that runs. |
| `dep-detect` | Offline dependency detection from root manifests and lockfiles (npm, Python, Cargo, Go, Ruby, PHP). |
| `shell-write-targets` | Absolute paths a shell command writes: redirects, `tee`, `cp`/`mv`, `sed -i`, `perl -i`. |
| `tool-targets` | File targets and commands of the built-in `edit`, `write`, `patch`, `read` and `shell` tools. |
| `shell-result` | `shellExit`, `shellOutput` and `appendResultText` for `execute.after` results. |
| `patterns` | OpenCode-style wildcard rules for `permission.hook("evaluate")` gates. |
| `skill-files` | Registers `SKILL.md` files shipped in a plugin package through `ctx.skill.transform`. |
| `testing` | `createFakeContext()`, an in-memory plugin context for `bun:test`. |

The shell modules and `dep-detect` are ported from
[omp-plugins](https://github.com/srobroek/omp-plugins), with the Oh My Pi specific
parts removed.
