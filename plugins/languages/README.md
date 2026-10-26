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

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `go-quality`: `gofmt -l`, `golangci-lint run` or `go vet`, `go test ./...`.
- `python-quality`: `ruff check`, `ruff format --check`, `pyright`, `pytest`.
- `typescript-quality`: Biome or ESLint, `tsc --noEmit`, the test script, and the
  type-safety rules for unions, allow-lists and trust-boundary validation.
