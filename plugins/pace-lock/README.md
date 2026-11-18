# pace-lock

Binds each OpenCode root session to at most one PACE customer and blocks every tool call that
touches another customer. A red banner above the composer shows the binding.

The plugin holds no policy. The shared `pace-lock` checker decides what counts as customer
access and keeps the binding state. The plugin binds sessions, calls the checker before tools run,
and draws the banner.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/pace-lock'
```

The banner is a TUI plugin. Add the same package to `~/.config/opencode/cli.json`:

```json
{ "plugins": ["github:srobroek/opencode-plugins#main::path:plugins/pace-lock"] }
```

Needs the `pace-lock` binary at `$PACE_LOCK_BIN`, or at `~/.local/bin/pace-lock`.

## Bind a session

| Way | Effect |
| --- | --- |
| `/pace <customer>` | Binds the current session's root. A refusal from the checker (unknown customer, a different customer already bound, closed) appears in the session as written. |
| `/pace off` | Closes the root's binding. |
| `/pace` | Shows the binding state. |
| `PACE_LOCK=<customer>` at server launch | Binds every new root session on that server. |

Subagent and other child sessions use the root's binding. The plugin walks `parentID` up to ten
levels and caches the result. When it cannot find the root, it blocks every call that matches the
prefilter.

## Gate

The `execute.before` hook runs for every tool except the read-only ones (`read`, `grep`, `glob`,
`list`). It also runs for calls made inside Code Mode and for subagents.

1. The plugin reads the checker's `prefilter` regex once. If that fails, every call counts as a match.
2. It tests the regex against the JSON of the tool arguments. No match, no check.
3. On a match it runs `pace-lock check --harness opencode --root <root> --tool <name>` with the
   arguments on stdin and a five second timeout.
4. Exit 0 allows the call. Exit 2 blocks it and returns the checker's reason as the tool error. Any other
   result blocks it:
   - a timeout
   - a crash
   - a missing binary

## Banner

The TUI entry appends a bold white-on-red row, `⚠ PACE: <customer> (<account>) ⚠`, to the
`session.composer.top` slot. It reads `~/.local/state/pace-lock/opencode-<root>.json` once a second and
shows nothing unless the state is `bound`. A toast appears when a session becomes bound. The TUI
finds the root through `parentID` in its synced session data, so child sessions show their root's banner.

## Files

| Path | Role |
| --- | --- |
| `src/index.ts` | Server plugin: command, gate, root resolution, auto-bind. |
| `src/checker.ts` | Runs the CLI without a shell and maps its exit code to a verdict. |
| `src/tui.tsx` | Banner and toast. |
| `src/state.ts` | State file location and banner text. |
