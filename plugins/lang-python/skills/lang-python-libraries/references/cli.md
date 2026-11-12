# Python CLI and configuration

Choose command parsing, terminal interaction and configuration libraries while keeping machine-readable output stable.

Checked 2026-11-12.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Commands | `typer` `0.29` for familiar typed CLIs | `argparse` for dependency-free tools; `click` `8` for explicit mature composition; `cyclopts` `5` for richer type/docstring handling | Migration solely for claimed speed; hidden CLI signature changes |
| Human output | `rich` `15` | Plain output for pipes/JSON; existing terminal renderer | ANSI decoration or progress bars in machine-readable stdout |
| Interactive prompts | `prompt_toolkit` `3` | Framework's simple confirmation API for a basic prompt | Full-screen framework for one prompt; interactive prompts in unattended runs |
| Full TUI | `textual` `8` | Native GUI toolkit when a terminal/browser UI is unsuitable | Calling Textual a native desktop-widget toolkit |
| Typed service/CLI settings | `pydantic-settings` `2`, validate at startup | Explicit stdlib configuration for small libraries; `dynaconf` `3` for layered files/environments/sources | Implicit working-directory `.env` discovery; application settings imported by reusable libraries |
| Config files | `tomllib` on Python `3.11` or later; `json` | `tomlkit` `0.15` for comment-preserving editing; `PyYAML` `6` safe loader for existing YAML | Lossy config rewriting; unsafe YAML loaders |
| Config writing | `tomli-w` `1` | `tomlkit` `0.15` when retaining user formatting | Treating a writer as a lossless parser/editor |
| Shared command policy | Explicit startup/shutdown and command hooks/decorators | Common wrapper for shared auth/config/telemetry | Hidden business dependencies in command middleware; logger/provider setup per subcommand |

## Head-to-head

- Typer is the familiar typed default. Cyclopts is an alternative when its type and docstring support removes actual parsing/help code; its published comparison is maintainer-authored, not an independent performance ranking.
- Click supplies explicit command composition; `argparse` avoids a dependency. Preserve an existing choice unless the requested behavior needs a migration.
- Rich formats output; `prompt_toolkit` handles prompts; Textual owns a full application UI. These are different responsibilities.

## Rules

- Define config source precedence, validate once, and keep secret values out of errors/help/logs. Do not commit credentials in `.env`.
- Keep JSON/data on stdout and diagnostics/progress on stderr. Provide a noninteractive mode and cancellation path where prompts are optional.
- For short-lived commands, close clients/pools and flush telemetry with a bounded shutdown.

## Sources

- [Typer registry](https://pypi.org/project/typer/), [Cyclopts comparison](https://cyclopts.readthedocs.io/en/latest/vs_typer/README.html), [Click](https://palletsprojects.com/p/click/)
- [Rich](https://rich.readthedocs.io/), [prompt_toolkit](https://python-prompt-toolkit.readthedocs.io/), [Textual](https://textual.textualize.io/)
- [Pydantic settings registry](https://pypi.org/project/pydantic-settings/), [Dynaconf](https://www.dynaconf.com/), [TOML](https://docs.python.org/3/library/tomllib.html), [Package version registry](https://pypi.org/)
