# lang-typescript

TypeScript and JavaScript quality and profiling skills: the lint, type-check and test
commands to run through the shell tool, the type-safety rules, and the Bun and Node
profiler and benchmark tooling. Formatting is OpenCode's built-in formatter (`"formatter": true`); see
[docs/formatters.md](../../docs/formatters.md).

Replaces the TypeScript half of the former `languages` plugin, which ported the
omp-plugins `typescript` plugin. Its `typescript_quality` tool is not ported, and the
`typescript-type-safety` rule (which omp attached to `*.ts`, `*.tsx` and `*.mts` files) is
the "Type safety" section of `lang-typescript-quality`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/lang-typescript'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin install lang-typescript@srobroek-opencode
codex plugin add lang-typescript@srobroek-opencode
```

## Skills

Only `lang-typescript` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.
The profiling skill is also reached through the `quality` plugin's `quality-profiling` skill.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `lang-typescript`: the router.
- `lang-typescript-quality`: Biome or ESLint, `tsc --noEmit`, the test script, and the
  type-safety rules for unions, allow-lists and trust-boundary validation.
- `lang-typescript-profiling`: Bun and Node `--cpu-prof`, `--heap-prof`, heap snapshots,
  mitata, tinybench. The method is the `quality` plugin's `quality-profiling` skill.
