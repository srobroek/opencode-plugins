# quality

Code design and review guidance, a short code-quality policy, performance profiling, throwaway logic
prototypes, and a read-only `adversarial-challenger` subagent.

| Skill | When |
| --- | --- |
| `quality-code-policy` | The short policy: SOLID and invariants over YAGNI, DRY for knowledge that changes together, research first and compare with the library standards before building, middleware for cross-cutting concerns, Powertools on Lambda, OpenTelemetry by default, planning scaled by risk, a type check after multi-file or signature edits, refactors scoped to the change. It requires `quality-code-design` only for new behavior, refactors, hard bugs and reviews |
| `quality-code-design` | Code design, investigation, implementation, refactoring, review, debugging or test-first work in any language. Picks IMPLEMENT, INVESTIGATE or REVIEW and loads only the references the task needs from `references/`, including `middleware.md` (handlers versus middleware, stack order, one error mapper) and `telemetry.md` (OpenTelemetry setup and rules) |
| `quality-profiling` | Slow or memory-heavy code, endpoints, builds or CLIs: set a target, reproduce with a fixed workload, baseline with variance, pick the profiler, change one thing, re-measure, report before/after. hyperfine, Linux perf and macOS Instruments live in `references/`; language tooling is the `lang-<language>-profiling` skills in the `lang-<language>` plugins |
| `quality-testing` | What to test and at which level, test doubles, flaky tests, test data, property-based tests, coverage; points to `lang-<language>-testing` skills for tooling |
| `prototype-logic` | A throwaway single-file HTML demo over a pure reducer or state machine, to test a state model before building it |

Other plugins point at these: `architecture` and the `architect` agent load
`quality-code-design` references, and `toolchain` defers language design guidance
to it.

## Engineering standards in the system prompt

Every primary session and every `general` subagent gets one static block at the end of
its system prompt: the `standards` part of the shared coding core
(`plugins/lib/src/coding-core.md`). It tells the agent to research current best practice
and compare its plan with the `lang-<language>-libraries`, `toolchain-api`, `aws-guidance`
and `toolchain-languages` standards before it writes its own code, to report each
departure, to put cross-cutting concerns in middleware, to keep Lambda handlers thin on
Powertools for AWS Lambda, and to use OpenTelemetry. The `coder`, `implementer`,
`implementer-high` and `ui-implementer` agents carry the same part in their composed
prompts, so they are not given it twice. The block is under 1000 characters and never
changes between requests, so the provider's prompt cache holds.

| Option | Default | Effect |
| --- | --- | --- |
| `standards` | `true` | `false` turns the block off |
| `standardsSubagents` | `["general"]` | Subagent ids whose child sessions also get the block; primary sessions always do |

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/quality",
    "options": { "standardsSubagents": ["general", "my-writer"] }
  }]
}
```

## Always-on policy

On omp `quality-code-design` was also an always-applied rule. OpenCode has no
always-on skill, so the rule ships as the `quality-code-policy` skill, loaded when
its description matches; the standards block above covers its research and library
rules in every session. To make the whole policy always on, copy its body into your
global `AGENTS.md` or into a file listed under `instructions` in your config.

## Agent

`adversarial-challenger` (mode `subagent`, steps 60) stress-tests a claim, plan, design or
decision from a brief of observable facts and returns evidence-backed
counter-arguments and alternatives, starting with `VERDICT: HOLDS|WEAKENED|REFUTED`.
It belongs to the [`agent-reviewer`](../agent-reviewer/README.md) plugin, which
documents its permissions and the shared review core. Quality ships an identical
fallback copy, composed from `agents.src/adversarial-challenger.md`, and skips it when
`plugin.list` reports `srobroek.agent-reviewer` or an earlier plugin already registered
the id; if the copy loads first, agent-reviewer replaces it.

It pins no model and declares the `reviewer` tier through the
`x-opencode-model-role` request header; without model-roles it inherits the caller's
model. Set `agent.adversarial-challenger.model` to pin one.

## Not ported

- `watchdog-files` and `advisor-resample`: they author and audit the omp advisor
  (`WATCHDOG.yml`) and its transcripts, which OpenCode does not have.
- `tests/code-design-eval`: development cases for tuning the steering, not shipped
  content.

## Text changes from omp

References to other skills name the skill (`toolchain-languages`, `sniff`,
`tune-model-prompt`, `design-prototype`); reference links inside a skill are
relative paths; "Scouts" became read-only explore subagents; the review mode
reports in the format the role or brief defines instead of an omp output schema.
These are the authoritative copies; earlier ones under `~/.claude/skills` are gone.

## Attribution

Parts of this plugin derive from [mattpocock/skills](https://github.com/mattpocock/skills)
1.2.3 under the MIT licence. `skills/prototype-logic` is vendored with its own
LICENSE and NOTICE. Content folded into `quality-code-design` references is listed
in `skills/quality-code-design/NOTICE`, with the licence text in
`skills/quality-code-design/LICENSE-mattpocock-skills`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/quality'
```

Claude Code and Codex install the skills, not the agent, from this repository's
marketplace:

```sh
claude plugin marketplace add srobroek/opencode-plugins
claude plugin install quality@srobroek-opencode

codex plugin marketplace add srobroek/opencode-plugins
codex plugin add quality@srobroek-opencode
```
