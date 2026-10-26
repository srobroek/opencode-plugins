# goal

Goal mode and loop mode for OpenCode V2, ported from Oh My Pi's `/goal` and
`/loop`.

- `/goal <objective>` sets one objective for the session. After each turn the
  plugin sends a hidden continuation until the model calls `goal_complete` with
  evidence, or a guard stops it.
- `/loop [N|duration] [--while|--until '<cmd>'] [prompt]` re-submits a prompt
  after each turn.

A session runs a goal or a loop, not both.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/goal'
```

## /goal

| Command | Effect |
| --- | --- |
| `/goal <objective>` | Set the goal and start working on it. |
| `/goal set <objective>` | Replace the current goal. |
| `/goal` or `/goal show` | Show the objective, status and usage. |
| `/goal pause` / `/goal resume` | Stop or restart automatic continuation. |
| `/goal drop` | Discard the goal. |
| `/goal budget <N\|$usd\|off>` | Token budget (`200k`, `1.5m`) or cost budget (`$2`). |

Tools for the model: `goal_get` reads the goal, `goal_complete` marks it done
and needs an `evidence` string.

About 800 ms after a turn ends in a top-level session with an active goal, the
plugin sends a synthetic "Goal: continue #n" message. It skips or stops when:

- you press Esc (interrupted by the user). The goal pauses.
- you send a message. A pending continuation is cancelled and the counters reset.
- a continuation turn calls no tools, or repeats the previous turn's tool calls
  and results. Auto-continue stops until you write or run `/goal resume`.
- 25 continuations have run since your last message (`maxContinuations`).
- the token or cost budget is spent. The model gets one wrap-up steer and the
  goal becomes `budget-limited`. Usage includes subagent steps.
- subagents or background shells are still running. It continues when they finish.
- the session uses the `plan` agent.
- a turn fails. The goal pauses.

The goal is stored per session. A goal that was active when OpenCode stopped
comes back paused. The objective goes into the compaction request so summaries
keep it. Nothing is added to the system prompt.

## /loop

```text
/loop 10 run the tests and fix one failure
/loop 30m --until 'bun test' fix the failing tests
/loop --while 'test -f queue.txt' process the next line of queue.txt
/loop
```

Without a prompt, your next message is the one that repeats. The limit counts
repeats after the first turn. A condition runs with `/bin/sh -c` in the session
directory before each repeat, with a 30 s timeout. `--while` continues on exit
0, `--until` continues on exit 1. Any other exit status, a timeout or a spawn
error disables the loop and says why. Esc suspends the loop and your next
message resumes it. `/loop` again disables it.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "github:srobroek/opencode-plugins::path:plugins/goal",
      "options": { "delayMs": 800, "maxContinuations": 25, "conditionTimeoutMs": 30000 },
    },
  ],
}
```

## Other plugins

Every message this plugin sends has `metadata.source` `"srobroek.goal"`. Before
a plugin continues a session itself, it can check whether this plugin is
already driving it:

```ts
const driving = (globalThis as Record<symbol, Map<string, "goal" | "loop"> | undefined>)[
  Symbol.for("srobroek.goal.continuations")
]?.get(sessionID)
```

The entry point exports the same thing as `activeContinuation(sessionID)`,
along with `GOAL_SOURCE` and `isGoalSourced(metadata)`.

## License

Apache-2.0. Parts are ported from Oh My Pi under the MIT License. See
[NOTICE](NOTICE).
