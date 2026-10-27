# languages

Short Go, Python and TypeScript quality skills: the lint, type-check and test
commands to run through the shell tool, and how to report a step that could not
run. Formatting is OpenCode's built-in formatter (`"formatter": true`); see
[docs/formatters.md](../../docs/formatters.md).

Replaces the omp-plugins `go`, `python` and `typescript` plugins. Their
`go_quality`, `python_quality` and `typescript_quality` tools are not ported, and the
`typescript-type-safety` rule (which omp attached to `*.ts`, `*.tsx` and `*.mts`
files) is the "Type safety" section of `typescript-quality`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/languages'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin install languages@srobroek-opencode
codex plugin add languages@srobroek-opencode
```

## Skills

Only `language-quality` is listed to the model in OpenCode: it is a router whose body maps each
situation to the per-language skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `go-quality`: `gofmt -l`, `golangci-lint run` or `go vet`, `go test ./...`.
- `python-quality`: `ruff check`, `ruff format --check`, `pyright`, `pytest`.
- `typescript-quality`: Biome or ESLint, `tsc --noEmit`, the test script, and the
  type-safety rules for unions, allow-lists and trust-boundary validation.
- `lang-typescript-profiling`, `lang-python-profiling`, `lang-go-profiling`: profiler
  and benchmark commands, how to read their output, and pitfalls (Bun and Node; py-spy,
  `profiling.sampling`, scalene, memray; pprof and benchstat). The method is the
  `quality` plugin's `quality-profiling` skill.
