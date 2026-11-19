# beads

[Beads](https://github.com/steveyegge/beads) (`bd`) issue tracking for OpenCode V2.
Ported from the Oh My Pi `beads` plugin in
[omp-plugins](https://github.com/srobroek/omp-plugins).

## What it does

On every `shell` call (`tool.hook("execute.before")`), in this order, with one
25-second budget for the whole call:

1. Binary Git hooks: `bd hooks install` is refused and `bd init` gains
   `--skip-hooks` when an existing hook is a binary executable.
2. Gate admission: a mutating `bd` command waits for its store's automatic gates
   to be verified (`bd gate list`, plus `bd gate check` when one could resolve).
3. An unparseable command is refused.
4. `bd edit` is refused: it opens `$EDITOR` and hangs the session.
5. `bd update --status closed|done` is refused in favour of `bd close --reason`.
6. `bd close` on a gate bead is refused (looked up with `bd show`).
7. `bd unclaim` without `--if-assignee` is refused.
8. Writes without an actor get an advisory in the tool result, since the plugin
   gives a subagent one (see item 11).
9. `gh pr create` without a `Bead:`, `Closes-Bead:` or `Bead-Id:` trailer is
   refused in a repository with a live ledger that you can write to.
10. Each `bd` write to an embedded store is rewritten to run under
    `bd-embedded-write-runner`, which holds the store's write lock for exactly the
    life of the `bd` process. The lock files are shared with the omp plugin.
11. Every shell call of a subagent session starts with
    `unset BEADS_ACTOR; export BD_ACTOR='opencode/<root-session>/<agent>/<session>'`.
    A main session gets no prefix. The prefix is fixed text, not a parse of the command:
    anything the command sets later wins through shell order and bd's precedence
    (`--actor`, then `BEADS_ACTOR`, then `BD_ACTOR`). The actor gate only warns when a
    command ends with no actor. Claim tooling should match an actor on its final
    `/`-separated segment, the session id; the root session and agent name are context.

A refusal is thrown, so the model sees it as the tool error.

`shell.hook("create.before")` sets `BEADS_DIR` (the checkout's `.beads`, or the
primary checkout's from a linked worktree) and clears `BEADS_DOLT_SHARED_SERVER`
in the child environment. An explicitly set `BEADS_DIR` is left alone, and it is the default ledger for
claim tracking: a plain claim is tracked under that store (see Claim tracking).

`tool.hook("execute.after")` records successful claims per session in plugin
storage, confirming each claim from the claim command's own `--json` output (a claim
bd does not confirm that way is not tracked, with a warning), and
appends the contention-retry and stale-import advisories.

`session.hook("context")` adds `bd prime` to the system prompt. The text is read
once and frozen per session, so the prompt stays cacheable. A root session's frozen
text also carries its session-start advisories, once: a binary Git hook that Beads
modified, the verdict a detached `bd dolt push` left in `.beads/last-push.log`
(consumed when read), and an inherited `BEADS_DIR` that points at another
repository's store.

Only mutating `bd` commands wait for gate admission. A `subagent` spawn, a shell command
that writes no bd store, and every read or edit pass without waiting on the ledger.

## Session lifecycle

The plugin follows `session.execution.*` events (`ctx.event.subscribe`). Every
message it sends is a `session.synthetic` with `metadata.source: "srobroek.beads"`.

- **Claim tracking.** The plugin tracks a claim only when it knows the ledger and the outcome.
  A ledger the plugin's own process environment chooses is certain: the session pin, or any of
  `BEADS_DIR`, `BEADS_DB`, `BD_DB`, `BD_SOCKET` and the `BEADS_DOLT_*`/`BEADS_PROXIED_SERVER_*`
  variables set there. A command that overrides it is not tracked: a ledger selector anywhere
  in it (a word starting `-C`, `--db`, `--database`, `--directory`, `--global` or `--dolt-`),
  or a `BEADS_*`/`BD_*` assignment other than the actor. The one exception is an inline
  assignment of a ledger variable to the plugin's own value, compared as canonical paths
  (symlinks resolved, trailing slash ignored). The invocation must be one plain `bd` command (no
  `;`, `&&`, `||`, pipe, subshell, substitution, wrapper, embedded-write runner, quoted
  assignment, background job or shell-computed word), and bd's own `--json` output must show the
  claimed bead `in_progress` under an actor that invocation could have used. The plugin adds
  `--json` to such a claim itself and says so, so the result is bd's JSON rather than a status
  line. Any other claim is not tracked: no stop nudge, no release, no heartbeat, and the result
  carries a one-line warning (variable names only, never values). Run the claim as its own simple
  command to have it tracked. A missed heartbeat is the safe failure; a release of the wrong
  ledger or actor is not. An assignment (`bd assign`, `--assignee`) never starts tracking a claim.
- **Stop nudge.** When a root session's execution succeeds while it holds tracked
  claims, it gets one queued message listing each claim with its guarded release
  command, and resumes. A real user prompt (`session.hook("prompt")`, not one from
  this plugin or OpenCode's built-in goal) re-arms the nudge. Nothing happens when the
  execution failed or was interrupted. While the built-in goal is active (the
  `opencode.goal` RPC's `get`) the stop is deferred: the nudge runs when the goal ends
  (`rpc.opencode.goal.changed`), unless a new execution starts first.
- **Release.** When the nudged session stops again still holding claims, they are
  released in the background (at most 120 s): `bd show`, then
  `bd unclaim <id> --if-assignee <holder>`, then, for a parked claim,
  `bd update <id> --status blocked|deferred --if-status open --if-assignee ''`. A claim
  bd no longer shows as the holder's is forgotten without a write. The session gets a
  message, without resuming, naming what was released and what could not be verified.
- **Subagents.** A subagent's claims are released when it ends successfully or its
  session is deleted. A failed or interrupted subagent keeps them so it can be resumed.
  For a foreground `subagent` call the release runs in the
  parent's `execute.after` (at most 25 s) and its report is appended to the tool
  result. For a background call the child's end triggers the release, and the parent
  gets the report as a message that does not wake it.
- **Lease heartbeat.** Each tracked claim with a known actor and store is renewed with
  `bd heartbeat <id> --json` every 60 s while its session executes, under the
  embedded write lock. Timers pause when an execution ends and resume (renewing at
  once) when the next starts, so an idle session lets its leases lapse. A close, an
  unclaim, a status other than `in_progress`, or `session.deleted` ends the lease. A
  failed heartbeat ends it and tells the session once. Leases live in plugin storage
  (`leases/<sessionID>`); timers are process-wide, so two plugin instances never renew
  one lease twice, and each instance clears its own on cleanup.
- **Fork notice.** On OpenCode 2.3.0 and later, the experimental `session.fork` hook
  tells a forked session which beads the original holds (at most 10, then "and N more"),
  so it does not assume them. The fork inherits no claims; the original's claims and
  leases are left alone. With no claims nothing is sent, and a host without the hook is
  unaffected. Gated by `beads-session-advisories`.

## Skills

Only `beads-guide` is listed to the model in OpenCode: it is a router whose body maps each
situation to the other beads skills, which set `opencode/autoinvoke: false` and load by id. One listing
entry instead of one per skill keeps the per-request skills listing short.

Registered through `ctx.skill.transform` from `skills/` (a user skill of the same
name wins): `beads-ledger`, `beads-evidence`, `beads-setup`,
`beads-contention-retry` and `beads-preflight` (a read-only `preflight.py`). They are
not exported to the Claude Code and Codex marketplaces, because they describe this
plugin's write lock and prime context.

## Options

Every gate is on by default. Switch one off in the plugin options:

```json
{ "gates": { "pr-bead-link-gate": { "enabled": false } } }
```

Gates: `beads-gate-admission`, `binary-git-hooks`, `bd-update-close-gate`,
`bd-close-gate`, `bd-unclaim-gate`, `bd-actor-gate`, `pr-bead-link-gate`,
`bd-embedded-write-lock`, `bd-editor-gate`, `beads-dir-pin`, `beads-prime`,
`beads-claim-tracking`, `beads-stop-nudge` (also the root-session release that
follows it), `beads-claim-release`, `bd-lease-heartbeat`, `beads-session-advisories`,
`beads-skills`. The lifecycle and the heartbeat read the claims that
`beads-claim-tracking` records.

### Busy-ledger wait

An embedded-store write that finds the write lock held waits for its turn, polling
with exponential backoff and jitter, for `embeddedWriteWaitMs` (default `30000`)
before it is refused. The refusal says the ledger is busy and to retry the command
as its own simple command; it only advises removing the lock when the holder is gone.

```json
{ "embeddedWriteWaitMs": 60000 }
```

## Process-global state

Some state lives on `globalThis` so every instance of the plugin in one process shares
it: the lifecycle (`srobroek.beads.lifecycle`), the heartbeat timers
(`srobroek.beads.heartbeats`) and the embedded write lock
(`com.srobroek.beads.embedded-write-lock.v1`). After a plugin update an older instance
can still be loaded, and it may have created that object before the new version
existed. The rules:

- The object must stay compatible across plugin versions in one process. Read it
  as possibly old-shaped.
- A new field needs a backfill (`state.field ??= ...`) in the accessor, on the
  existing object. Never replace the object, and never assume it has the new field.
- A new field needs a test that pre-seeds `globalThis` with the old shape, runs the
  new code and checks that nothing throws.
- A lock key never changes and is never versioned. Two versions that used two keys
  would each hold the same store, and embedded-store writes would stop being serialised.

## Permissions

OpenCode evaluates shell permissions on the rewritten command. A write that runs
under the lock runner starts with `BEADS_DOLT_SHARED_SERVER= BEADS_DIR=... '<bun>'
'<plugin>/dist/bd-embedded-write-runner.js' ... -- bd ...`, so a rule that allows
`bd *` does not cover it. Add a rule for the runner if your shell permission is
not `allow`.

## Requirements

`bd` and `bun` on `PATH` (or `BUN_INSTALL`, or mise). The runner is a Bun script.

## Subagent routing (FO-5)

When the location has a store, a second `execute.before` hook checks each new
`subagent` call against delivery rule FO-5:

1. It finds bead ids in the prompt. Ids that start with the ledger prefix (the
   name of the store's repository directory) win. If there are none, a token
   counts when its hash part contains a digit or it has a `.N` child suffix.
   At most 8 ids are read.
2. It reads them in one `bd show <ids> --json`, with a 3-second limit.
3. If a named bead sets `metadata.execution_agent_type` and the spawn's agent
   matches none of them, the call is refused. The refusal names each bead's agent
   and its `execution_reasoning_effort`. A namespaced agent (`delivery:implementer`)
   matches `implementer`.
4. A spawn to `implementer-high` that no named bead asks for goes ahead, with an
   advisory appended to the result: use `implementer` unless the brief states an
   implementer-high criterion.

Orchestrator spawns are exempt, because an orchestrator names the many beads it
will delegate: a spawn to the `general` agent, or with tier `orchestrate` (or the
legacy `role: "orchestrate"`), skips the check and the bead lookup. Every other
spawn is judged as above. To switch the gate off for all spawns, set
`{ "gates": { "bead-agent-routing": { "enabled": false } } }`.

A resumed call (with `sessionID`), a prompt with no ids, a failed or slow `bd`
read, and a location without a store are all allowed. Gate name:
`bead-agent-routing`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/beads'
```

## Claude Code

The plugin is also in this repository's Claude Code marketplace. Install it with these
two commands:

```text
/plugin marketplace add srobroek/opencode-plugins
/plugin install beads@srobroek-opencode
```

It ships the skills and the two hooks in `hooks/claude-hooks.json`. Both hooks run
`bun dist/claude-hook.js`:

- `SessionStart` adds `bd prime` and the session-start advisories as context, within
  Claude Code's 10,000-character limit. It runs on startup, resume, clear and compact.
  It also writes the store pin to `CLAUDE_ENV_FILE`: `BEADS_DIR`, and an empty
  `BEADS_DOLT_SHARED_SERVER`.
- `PreToolUse` on `Bash` runs the shell gates above, with every gate on. It skips a
  command that names none of `bd`, `git` and `gh`. A refusal denies the call. A rewrite replaces
  `command`. An advisory becomes context. Every Bash command of a subagent, gated or not,
  starts with
  `unset BEADS_ACTOR; export BD_ACTOR='claude/<session>/<agent type>/<agent id>';`, so a script
  it runs writes under that actor. A main session gets no injected actor and writes under the
  actor its own environment or command chooses.

These parts stay OpenCode-only:

- claim tracking and lease heartbeats
- the stop nudge and guarded claim release
- subagent routing
- plugin options

Without `bun`, session start falls back to `bd prime` and no gate runs. A hook that fails
exits 0, so Claude Code carries on without it.

# Project ledger store

Set `options.store` when the project's ledger lives outside its checkout:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@srobroek/opencode-beads",
      "options": { "store": "/absolute/path/to/ledger/.beads" }
    }
  ]
}
```

Relative store paths resolve from OpenCode's project root
(`location.project.directory`), not from the config file or a shell call's
working directory. The plugin resolves symlinks and requires a directory with
`metadata.json` or `embeddeddolt/`. For invalid values the plugin installs refusal
hooks that block shell tools, shell creation, dispatch and session context with
an `Invalid beads store option` error. It runs no internal `bd` commands.
Fix the config before running ledger writes.

For ordinary `bd` calls, precedence is a literal command-local `BEADS_DIR=`,
then `options.store`, then the server's `BEADS_DIR`, then checkout discovery.
Explicit database/directory CLI flags retain their existing semantics.
The configured store supplies `BEADS_DIR` to shell children and every internal
`bd` command, including admission checks and `bd prime`. This explicit selection
also applies when the automatic `beads-dir-pin` gate is disabled. The write
runner uses the canonical store path, so projects and worktrees sharing a ledger
use its same `omp-embedded-write.lock` file.

OpenCode V2 searches project config through all ancestors, including above a Git
root. Either `opencode.json` or `.opencode/opencode.json` works; all discovered
`.opencode` configs take precedence over direct configs. Plugin arrays are
processed from lower to higher precedence. In the current V2 implementation,
a later entry with the **same package target** replaces its earlier options;
it does not deep-merge them. Repeat any global gate options you want to retain,
and match the global target exactly, including its version or Git specification.
Different targets exporting the same plugin ID can be reported as duplicates,
with the first instance retained. Use the package target, not `srobroek.beads`,
to supply options: an ID entry only enables the plugin.

Sources: [V2 config](https://opencode.ai/v2/docs/config),
[V2 plugins](https://opencode.ai/v2/docs/plugins), and
[`PluginSupervisor.resolve`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/supervisor.ts)
with [`PluginModule.load`](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/plugin/module.ts).
