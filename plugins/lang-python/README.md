# lang-python

Python quality and profiling skills: the lint, type-check and test commands to run
through the shell tool, how to report a step that could not run, and the profiler and
benchmark tooling. Formatting is OpenCode's built-in formatter (`"formatter": true`); see
[docs/formatters.md](../../docs/formatters.md).

Replaces the Python half of the former `languages` plugin, which ported the omp-plugins
`python` plugin (its `python_quality` tool is not ported).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/lang-python'
```

Claude Code and Codex install the same skills from this repository's marketplace:

```sh
claude plugin install lang-python@srobroek-opencode
codex plugin add lang-python@srobroek-opencode
```

## Skills

Only `lang-python` is listed to the model in OpenCode: it is a router whose body maps each
situation to the skills below, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short. Claude Code
and Codex ignore that metadata, so there every skill is listed and triggers directly.
The profiling skill is also reached through the `quality` plugin's `quality-profiling` skill.

The plugin registers these skills from `skills/`, unless a skill with the same id
already exists:

- `lang-python`: the router.
- `lang-python-quality`: `ruff check`, `ruff format --check`, `pyright`, `pytest`.
- `lang-python-profiling`: py-spy, `profiling.sampling`, scalene, memray, cProfile, pyperf.
  The method is the `quality` plugin's `quality-profiling` skill.
