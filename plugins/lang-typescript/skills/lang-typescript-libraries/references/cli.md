# Command-line interfaces and configuration

Choose arguments, prompts, terminal rendering and settings for the actual Node or Bun deployment.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Arguments | Standard argument parser for tiny CLIs; `commander` `15` for subcommands/help | `citty` `0.2` for UnJS; `yargs` `18` for parser features; `cac` `7` for small CLIs; existing framework when migration is not requested. | Reimplementing option parsing/help; accidental Clipanion `4` release-candidate adoption. |
| Prompts | `@clack/prompts` `1` | Existing prompt library or non-interactive flags in automation. | Waiting for input in CI; printing secrets or ignoring cancellation. |
| TUI | `ink` `8` when a React terminal UI is needed | Plain text for ordinary command output. | A full UI framework for one prompt; assuming TTY support or Bun compatibility without tests. |
| Color | `picocolors` `1` | Existing renderer's color support. | Forced ANSI codes in redirected output; color as the only status indication. |
| CLI logging | `consola` `3` | `pino` `10` when machine-readable structured logs are required. | Mixing diagnostics into machine-readable stdout. |
| Env files | Node native env-file support; Bun built-in env loading | `dotenv` `18` for existing loader/tool compatibility. | Adding env loaders without checking runtime support; committing real secrets. |
| Settings validation | `zod` `4` once at startup | `@t3-oss/env-core` `0.13` for server/client env boundaries; `envalid` `9` for env-specific validators. | Unchecked env in business code; coercing string `"false"` to true; client bundles with server secrets. |
| Layered config | Native file/env handling for simple settings | `c12` `3` when layered config/loading semantics are needed. | Adopting `c12` `latest` prereleases automatically; executing untrusted config files. |

## Rules

- Define precedence between flags, environment and files. Report missing/invalid settings
  without printing values. Keep secrets separate from ordinary checked-in config.
- Return meaningful exit status, honor cancellation, and make automation non-interactive.
  Separate JSON stdout from diagnostics on stderr; test redirected and TTY output.
- Native Bun env loading differs from Node's opt-in file loading. Do not depend on
  implicit local files in containers or Lambda. Pin the runtime floor for CLI dependencies.

## Sources

- [Commander](https://github.com/tj/commander.js), [Clack](https://github.com/bombshell-dev/clack), [Ink](https://github.com/vadimdemedes/ink).
- [Node environment files](https://nodejs.org/api/cli.html#--env-filefile), [Bun env](https://bun.com/docs/runtime/environment-variables), [T3 env](https://env.t3.gg/docs/core).
- [c12](https://github.com/unjs/c12), [registry metadata](https://registry.npmjs.org/).
