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
8. Claims and creates without an actor are refused; other unattributed writes get
   an advisory in the tool result.
9. `gh pr create` without a `Bead:`, `Closes-Bead:` or `Bead-Id:` trailer is
   refused in a repository with a live ledger that you can write to.
10. Each `bd` write to an embedded store is rewritten to run under
    `bd-embedded-write-runner`, which holds the store's write lock for exactly the
    life of the `bd` process. The lock files are shared with the omp plugin.
11. In a subagent session, `export BEADS_ACTOR='opencode/<root>/<agent>/<session>'`
    is prefixed, unless the command chooses its own actor.

A refusal is thrown, so the model sees it as the tool error.

`shell.hook("create.before")` sets `BEADS_DIR` (the checkout's `.beads`, or the
primary checkout's from a linked worktree) and clears `BEADS_DOLT_SHARED_SERVER`
in the child environment. An explicitly set `BEADS_DIR` is left alone.

`tool.hook("execute.after")` records successful claims per session in plugin
storage, and appends the contention-retry and stale-import advisories.

`session.hook("context")` adds `bd prime` to the system prompt. The text is read
once and frozen per session, so the prompt stays cacheable. A root session's frozen
text also carries its session-start advisories, once: a binary Git hook that Beads
modified, the verdict a detached `bd dolt push` left in `.beads/last-push.log`
(consumed when read), and an inherited `BEADS_DIR` that points at another
repository's store.

The `subagent` tool also waits for gate admission.

## Session lifecycle

The plugin follows `session.execution.*` events (`ctx.event.subscribe`). Every
message it sends is a `session.synthetic` with `metadata.source: "srobroek.beads"`.

- **Stop nudge.** When a root session's execution succeeds while it holds tracked
  claims, it gets one queued message listing each claim with its guarded release
  command, and resumes. A real user prompt (`session.hook("prompt")`, not one from
  this plugin or `srobroek.goal`) re-arms the nudge. Nothing happens while the goal
  plugin will continue the session (its `Symbol.for("srobroek.goal.continuations")`
  registry), or when the execution failed or was interrupted.
- **Release.** When the nudged session stops again still holding claims, they are
  released in the background (at most 120 s): `bd show`, then
  `bd unclaim <id> --if-assignee <holder>`, then, for a parked claim,
  `bd update <id> --status blocked|deferred --if-status open --if-assignee ''`. A claim
  bd no longer shows as the holder's is forgotten without a write. The session gets a
  message, without resuming, naming what was released and what could not be verified.
- **Subagents.** A subagent's claims are released when it finishes (any end except a
  superseded execution). For a foreground `subagent` call the release runs in the
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

A resumed call (with `sessionID`), a prompt with no ids, a failed or slow `bd`
read, and a location without a store are all allowed. Gate name:
`bead-agent-routing`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/beads'
```
