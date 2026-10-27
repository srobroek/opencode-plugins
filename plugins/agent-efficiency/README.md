# agent-efficiency

Stops wasted turns on tool names that do not exist in OpenCode V2.

Models trained on other harnesses call a `bash` tool. OpenCode V2 names it `shell`,
so each such call fails with "No tool named bash" and the model retries. This plugin
runs a `bash` (or `Bash`) call as the built-in `shell` call it means.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-efficiency'
```

## How it works

OpenCode runs `tool.hook("execute.before")` before it looks the tool up, and a hook
may rename the call. The plugin's hook renames `bash` and `Bash` to `shell` and maps
the input to `shell`'s shape:

- `command` as a string, or as an argv array (`["bash", "-lc", "script"]` runs
  `script`; another array is shell-quoted and joined). `cmd` is read the same way.
- `workdir`, `cwd` or `working_directory` becomes `workdir`.
- `timeout` or `timeout_ms` (milliseconds) becomes `timeout`.
- `background` or `run_in_background` becomes `background`.
- Every other field, such as `description`, is dropped.

The call then runs as the built-in `shell` tool, not a copy: the same permission
rules and prompts, timeout, working directory checks and background jobs. Every
`execute.after` hook sees `shell`. If the session's agent cannot use `shell`, the
call fails just as a `shell` call would.

Nothing is added to the request: no tool definition and no system prompt text.

A plugin that registers a real `bash` tool keeps it; the hook leaves the call alone.

## Ordering with guards

Hooks run in plugin load order. A guard whose `execute.before` hook runs before this
plugin's sees the call still named `bash`. The guards in this repository (`safety`,
`trunk-dev`, `worktrunk`, `beads`, `chezmoi`, `rust`, `speckit`) treat `bash` and
`Bash` as `shell`, so they hold in any order. Load this plugin first when you also
run third-party guards keyed on `shell`.

## Options

```jsonc
{
  "plugins": [
    { "package": "github:srobroek/opencode-plugins::path:plugins/agent-efficiency", "options": { "bashAlias": false } }
  ]
}
```

| Option | Default | Effect |
| --- | --- | --- |
| `bashAlias` | `true` | `false` leaves `bash` calls to fail as unknown tools. |
