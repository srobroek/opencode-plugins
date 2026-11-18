# REUSE tool: install and run

Checked 2026-11-18. `reuse` >=6.3.0 (6.3.0 released on PyPI 2026-10-30). mise cannot express a minimum, so the example uses `"latest"`. It checks per-file licence and copyright data against the [REUSE specification](https://reuse.software/spec-3.3/). Setup, headers and `REUSE.toml` are in `license-picker`'s `references/reuse.md`.

## Encoding detector

`reuse` needs an encoding detector, `charset-normalizer` or `chardet`, and works when at least one is installed ([changelog](https://github.com/fsfe/reuse-tool/blob/main/CHANGELOG.md)). A bare install exits with a message to install `reuse[charset-normalizer]`. Install the extra.

## Install

mise, with the `extras` option of the PyPI backend, which the `pipx:` prefix also accepts ([mise docs](https://mise.jdx.dev/dev-tools/backends/pypi.html#extras)):

```toml
[tools]
"pipx:reuse" = { version = "latest", extras = ["charset-normalizer"] }
```

Without an install, through uv:

```sh
uvx --with charset-normalizer reuse lint
```

## Run

- Local: `reuse lint` from `just check`.
- CI: `fsfe/reuse-action` pinned by commit SHA, in a job that `ci-gate` requires ([releases](https://github.com/fsfe/reuse-action/releases)).
- Hook: the REUSE project's own hook, below.

```yaml
- repo: https://github.com/fsfe/reuse-tool
  rev: v6.3.0  # hooks pin a rev by design
  hooks:
    - id: reuse
```

The hook id `reuse` runs `reuse lint` on the whole project and installs both detectors itself ([.pre-commit-hooks.yaml](https://github.com/fsfe/reuse-tool/blob/main/.pre-commit-hooks.yaml)). Use `reuse-lint-file` to check only changed files. prek reads the same file.
