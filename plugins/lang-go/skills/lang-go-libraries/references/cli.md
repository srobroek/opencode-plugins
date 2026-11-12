# Go command-line applications

Keep small tools on the standard library and reserve rich terminal dependencies for interactive needs.

Checked 2026-11-12. Standard-library entries use Go `1.27`.

| Concern | Default | Use instead when | Avoid (why) |
| --- | --- | --- | --- |
| Small CLI | `flag`, `fmt`, `os`; standard library is sufficient | `github.com/spf13/cobra` `1` for command trees/completions | Command framework for a few flags. |
| Structured commands | Cobra `1` for established command-tree conventions | `github.com/alecthomas/kong` `1` for struct parsing; `github.com/urfave/cli/v3` `3` for its API | Treating `github.com/peterbourgon/ff/v4` `4` beta as stable. |
| Prompts/forms | Noninteractive flags first | `charm.land/huh/v2` `2` for forms | Blocking prompts in automation; old Charm paths mistaken for v2 modules. |
| Full TUI | `charm.land/bubbletea/v2` `2` when a stateful TUI is needed | `charm.land/bubbles/v2` `2` for components | A TUI for ordinary command output; blocking work in the event/update path. |
| Plain/machine output | `fmt`, `encoding/json`, `text/tabwriter`; standard library is sufficient | `github.com/fatih/color` `1` for modest color; `charm.land/lipgloss/v2` `2` for styling | ANSI on machine output, diagnostics mixed with JSON stdout. |
| Tiny configuration | `os.LookupEnv`, typed immutable structs; standard library is sufficient | `github.com/caarlos0/env/v11` `11` for typed environment parsing | Hidden defaults, no startup validation or mutable global settings. |
| Layered configuration | `github.com/knadh/koanf/v2` `2` when files/env/flags must combine | `github.com/spf13/viper` `1` for existing Cobra integrations; `github.com/kelseyhightower/envconfig` `1` for existing code | Viper concurrent reads/writes, case-sensitive-key assumptions or unnoticed environment rereads. |
| Config formats | JSON via standard library when sufficient | Maintained YAML `3` or TOML `2` modules from `data.md` | Inventing parsers or installing formats the project does not need. |

## Rules

- Define and test config precedence; parse once, validate and freeze typed settings. Keep secrets out of printed diagnostics.
- Support noninteractive execution, cancellation, sensible exit status and plain/machine output. Keep diagnostics on stderr.
- Respect terminal capability and non-TTY output. Test command behavior separately from the terminal renderer.
- Flush telemetry on command exit; do not replace explicit startup/shutdown with a middleware framework for one command.

## Sources

- [flag](https://pkg.go.dev/flag), [Cobra](https://pkg.go.dev/github.com/spf13/cobra), [Kong](https://pkg.go.dev/github.com/alecthomas/kong), [urfave CLI](https://pkg.go.dev/github.com/urfave/cli/v3), [ff beta](https://pkg.go.dev/github.com/peterbourgon/ff/v4).
- [Bubble Tea](https://pkg.go.dev/charm.land/bubbletea/v2), [Bubbles](https://pkg.go.dev/charm.land/bubbles/v2), [Huh](https://pkg.go.dev/charm.land/huh/v2), [Lip Gloss](https://pkg.go.dev/charm.land/lipgloss/v2), [color](https://pkg.go.dev/github.com/fatih/color), [tabwriter](https://pkg.go.dev/text/tabwriter).
- [env](https://pkg.go.dev/github.com/caarlos0/env/v11), [koanf](https://pkg.go.dev/github.com/knadh/koanf/v2), [Viper behavior](https://github.com/spf13/viper#readme), [envconfig](https://pkg.go.dev/github.com/kelseyhightower/envconfig).
