# Adoption Policy

Adapted from the omp-plugins find-tools adoption policy for OpenCode V2.

## Decisions

- `Use existing`: already installed or configured. The scan's `local` source
  lists installed plugins (`plugin:`) and skills (`skill:`); MCP servers show as
  counts, so confirm with the user. A plugin that a catalog only lists is
  `Adopt`, not `Use existing`.
- `Adopt`: install at project scope (see *Scopes*). Install user-wide only when
  the user asks for it.
- `Trial`: useful but risky or unclear. Try it in a throwaway project or
  worktree without changing this project's source or the user's global config,
  and only after approval.
- `Reject`: unsafe, stale, unlicensed, duplicate, incompatible, or too weak.
- `Build`: nothing that exists fits well enough.

## Scopes

| Artifact | Project scope (default) | User-wide (ask separately) |
| --- | --- | --- |
| OpenCode plugin | add the spec to `plugins` in the project's `opencode.json` | `opencode plugin add <spec>` (global config) |
| MCP server | `opencode mcp add <name> --url …` or `-- <command>` | the same with `--global` |
| Skill | copy the skill directory to `.opencode/skills/<name>/`, or add a catalog URL to `skills` | `~/.config/opencode/skills/<name>/` |

A plugin from this repository installs with the spec
`github:srobroek/opencode-plugins::path:plugins/<name>`.

A V1 plugin (`@opencode-ai/plugin`) does not run on OpenCode V2. Check the
entry point imports `@opencode/plugin` before adopting a plugin.

A command that runs package code (`npx -y`, `bunx`, `uvx`, `docker run`, an
install script) needs its own confirmation that names the package and version.

## Catalog adoption

When a tool should be reusable across projects:

1. Prefer the upstream package or repository over copying its files.
2. Do not vendor third-party skill trees into this repository when the
   upstream publishes a catalog or package.
3. A Claude Code marketplace entry is a pointer to source. OpenCode does not
   install from it; adapt the skill or find the plugin's OpenCode package.

## Vetting rubric

Score each serious candidate on:

- **Popularity**: downloads, stars, Smithery use count, dependents.
- **Maintenance**: recent commits or releases, an identifiable maintainer,
  issue response.
- **Code quality**: readable source, tests or CI, schemas, typed config, error
  handling.
- **Security**: license, required secrets and their scope, destructive tools or
  write access, telemetry, network calls, how it installs (a published package
  or a script piped into a shell).
- **Fit**: overlap with installed plugins and skills, local versus hosted,
  simplicity, OpenCode V2 compatibility.

Reject:

- prompt-only wrappers around tools OpenCode already exposes cleanly;
- broad secret requirements without a strong reason;
- hidden or piped install scripts;
- missing licenses;
- duplicates of a better-maintained installed plugin or skill.
