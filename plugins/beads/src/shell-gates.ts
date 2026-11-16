/**
 * The beads plugin's one `shell` decision: every gate sees the same parse, in a fixed
 * order, and the rewrites compose only after every gate allowed.
 *
 * Order: binary-hook guard, gate admission, parse failure, `bd edit`, update-close,
 * close, unclaim, actor, PR bead link, embedded-write runner rewrite, subagent actor
 * prefix. The store pin is not a command rewrite on OpenCode: `shell.create.before`
 * sets `BEADS_DIR` in the child's environment.
 */

import { type BdInvocation, bdInvocations, decideActorParsed, flagEnabled, globalValue } from "./bd-actor-gate.ts"
import { decideBdCloseParsed } from "./bd-close-gate.ts"
import {
  decideEmbeddedWrite,
  type EmbeddedWriteRunnerLookup,
  embeddedWriteRunner,
  planEmbeddedWrites,
  writeWaitFromOptions,
} from "./bd-embedded-write-lock.ts"
import { decideBdUnclaimParsed } from "./bd-unclaim-gate.ts"
import { decideBdUpdateCloseParsed } from "./bd-update-close-gate.ts"
import { repoIdentity } from "./beads-store.ts"
import { protectBinaryHookCommands } from "./binary-hooks.ts"
import { admitBdMutation, type GateAdmitter } from "./gate-admission.ts"
import { type Gate, gateEnabled, type Options } from "./host.ts"
import { describeLedger, findLedger, ledgerRepoMismatch } from "./ledger-context.ts"
import { decideCommandParsed, type RepositoryControl, repositoryControlFor } from "./pr-bead-link-gate.ts"
import { type ParsedCommand, parse } from "./shell.ts"

/**
 * One budget for the whole call. OpenCode has no hook timeout, but a gate that waits
 * forever stalls the turn, so admission and every gate draw on the same deadline.
 */
export const TOOL_CALL_BUDGET_MS = 25_000

export type ShellDecision =
  | { kind: "block"; gate: string; cause: string; resolution: string }
  | { kind: "allow"; command: string; advisories: string[] }

export type ShellGateDeps = {
  options: Options | undefined
  /** The actor a subagent writes under; `undefined` in a main session. */
  actor: string | undefined
  /** The environment the child shell starts from, with this plugin's store pin applied. */
  env: NodeJS.ProcessEnv
  admitter: GateAdmitter
  callID: string
  deadline: number
  runnerLookup?: () => EmbeddedWriteRunnerLookup
  repositoryControl?: (segment: string, cwd: string) => boolean | RepositoryControl
}

const BINARY_HOOKS_NOTE = "# Beads hooks skipped to keep the existing (binary) Git hooks intact."

function block(gate: Gate | "bash-gates", cause: string, resolution = "inspect the command and retry"): ShellDecision {
  return { kind: "block", gate, cause, resolution }
}

/** `bd edit` opens `$EDITOR` and hangs a non-interactive session. */
export function hasBdEdit(parsed: ParsedCommand): boolean {
  return bdInvocations(parsed.command).some(
    (invocation) => invocation.verb === "edit" && !flagEnabled(invocation.args, ["--help", "-h"]),
  ) || parsed.nested.some(hasBdEdit)
}

type ActorVariable = "BEADS_ACTOR" | "BD_ACTOR"

/** The ways one invocation names its own actor: `--actor`, or either variable. */
function namedVariables(invocation: BdInvocation): Set<string> {
  const names = new Set<string>()
  if (invocation.globals.some((token) => token === "--actor" || token.startsWith("--actor="))) names.add("--actor")
  for (const variable of ["BEADS_ACTOR", "BD_ACTOR"] as const) {
    if (invocation.prefix.some((token) => token.startsWith(`${variable}=`)) || invocation.exported[variable] !== undefined)
      names.add(variable)
  }
  return names
}

/**
 * The actor to export and the variable to export it through, unless every `bd` invocation in
 * the command already chooses its own. An invocation's own prefix beats the export by shell
 * rules, so one actorless invocation is enough to inject. The injection never overrides an
 * explicit actor: it uses the lower-precedence BD_ACTOR whenever any invocation chose one.
 */
export function actorInjection(
  command: string,
  actor: string | undefined,
): { actor: string; variable: ActorVariable } | undefined {
  if (actor === undefined) return undefined
  const invocations = bdInvocations(command)
  if (invocations.length === 0) return undefined
  const named = invocations.map(namedVariables)
  if (named.every((names) => names.size > 0)) return undefined
  // `bd` reads BEADS_ACTOR before BD_ACTOR, so an injected BEADS_ACTOR would override an
  // invocation that chose its actor through BD_ACTOR. The injected BD_ACTOR loses to every
  // explicit choice instead: a BEADS_ACTOR, a --actor, or the invocation's own BD_ACTOR.
  // An export that may or may not run is injected around, not trusted: BD_ACTOR loses to every
  // explicit choice, and to the conditional export itself when that export runs.
  const choosesBdActor = named.some((names) => names.has("BD_ACTOR")) || invocations.some((i) => i.conditional.length > 0)
  return { actor, variable: choosesBdActor ? "BD_ACTOR" : "BEADS_ACTOR" }
}

/** The actor to export, unless the command already chooses its own. */
export function actorForCommand(command: string, actor: string | undefined): string | undefined {
  return actorInjection(command, actor)?.actor
}

export function withActorPrefix(command: string, actor: string, variable: ActorVariable = "BEADS_ACTOR"): string {
  return `export ${variable}='${actor.replaceAll("'", "'\\''")}'; ${command}`
}

/** Global flags that name the store themselves; the advisory does not follow them. */
const TARGET_SELECTORS = ["-C", "--directory", "--db", "--database"]

/**
 * Warns when a `bd create` in the command writes to a ledger of another git repository.
 *
 * Targets come from the write planner, so the advisory sees the same `cd`, `export`,
 * `unset` and command-local `BEADS_DIR` state as the lock. A command the planner cannot
 * place stays silent here; the lock refuses it.
 */
export function createLedgerWarning(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  identity: (dir: string) => string | undefined = repoIdentity,
): string | undefined {
  let warning: string | undefined
  planEmbeddedWrites(command, cwd, env, {
    classify: false,
    observe: ({ invocation, store, cwd: dir }) => {
      if (warning !== undefined || invocation.verb !== "create") return
      if (flagEnabled(invocation.globals, ["--global"])) return
      if (TARGET_SELECTORS.some((name) => globalValue(invocation.globals, [name]) !== undefined)) return
      const target = store ?? findLedger(dir)?.store
      if (target !== undefined) warning = ledgerRepoMismatch({ store: target, cwd: dir, identity })
    },
  })
  return warning
}

/** Decide one `shell` call. Never throws: an unexpected error is a parse refusal. */
export async function decideShell(command: string, cwd: string, deps: ShellGateDeps): Promise<ShellDecision> {
  try {
    return await decide(command, cwd, deps)
  } catch (error) {
    return block(
      "bash-gates",
      `command could not be parsed (${error instanceof Error ? error.message : String(error)})`,
      "split the command or run the mutation as a plain single command",
    )
  }
}

async function decide(original: string, cwd: string, deps: ShellGateDeps): Promise<ShellDecision> {
  const { options, deadline } = deps
  const on = (gate: Gate): boolean => gateEnabled(options, gate)
  const advisories: string[] = []
  let command = original
  let hooksSkipped = false

  if (on("binary-git-hooks")) {
    const hookGuard = protectBinaryHookCommands({ command }, command, cwd)
    if (hookGuard?.kind === "block") return block("binary-git-hooks", hookGuard.reason)
    if (hookGuard?.kind === "rewrite" && typeof hookGuard.input.command === "string") {
      command = hookGuard.input.command
      hooksSkipped = true
    }
  }

  if (on("beads-gate-admission")) {
    const admission = await admitBdMutation(command, cwd, deps.env, deps.admitter, deadline)
    if (admission?.block === true)
      return block(
        "beads-gate-admission",
        admission.reason,
        "retry the command; verification continues and the next attempt waits on the same read",
      )
    if (admission?.notice !== undefined) advisories.push(admission.notice)
  }

  const parsed = parse(command)
  if (parsed.unknown)
    return block(
      "bash-gates",
      "command could not be parsed",
      "split the command or run the mutation as a plain single command",
    )

  if (on("bd-editor-gate") && hasBdEdit(parsed))
    return block(
      "bd-editor-gate",
      "`bd edit` opens $EDITOR and hangs a non-interactive session",
      'set the field directly with `bd update ID --<field> ...`, or add prose with `bd comment ID "TEXT"`; never export EDITOR=true, which records nothing',
    )

  if (on("bd-update-close-gate")) {
    const updateClose = decideBdUpdateCloseParsed(parsed)
    if (updateClose !== undefined) return block("bd-update-close-gate", updateClose.reason)
  }

  if (on("bd-close-gate")) {
    try {
      const close = await decideBdCloseParsed(parsed, cwd, deadline, deps.env)
      if (close !== undefined)
        return block(
          "bd-close-gate",
          close.reason,
          "resolve the gate with `bd gate check` or `bd gate resolve <gate-id>`, then retry",
        )
    } catch (error) {
      return block(
        "bd-close-gate",
        error instanceof Error ? error.message : String(error),
        "retry after the Beads lookup is available; the close was refused without gate proof",
      )
    }
  }

  if (on("bd-unclaim-gate")) {
    const unclaim = decideBdUnclaimParsed(parsed)
    if (unclaim !== undefined)
      return block("bd-unclaim-gate", unclaim.reason, "retry with `bd unclaim <id> --if-assignee <your actor>`")
  }

  const injection = actorInjection(command, deps.actor)
  if (on("bd-actor-gate")) {
    const env = injection === undefined ? deps.env : { ...deps.env, [injection.variable]: injection.actor }
    const decision = decideActorParsed(parsed, env)
    // The plugin injects an actor into every session's `bd` calls, so reaching a refusal here
    // means injection was not possible. This gate guards against forgetting attribution, not
    // against deliberate evasion (an agent can always set a wrong actor), so it only warns.
    if (decision.kind === "block") advisories.push(decision.reason)
    else if (decision.kind === "advisory") advisories.push(decision.text)
  }

  const crossRepo = on("bd-embedded-write-lock") ? createLedgerWarning(command, cwd, deps.env) : undefined
  if (crossRepo !== undefined) advisories.push(crossRepo)

  if (on("pr-bead-link-gate")) {
    const control = deps.repositoryControl ?? repositoryControlFor
    const decision = decideCommandParsed(
      parsed,
      (segment) => control(segment, cwd),
      () => {
        const ledger = findLedger(cwd)
        return ledger === undefined ? undefined : describeLedger(ledger)
      },
    )
    if (decision) return block("pr-bead-link-gate", decision.reason, "add the bead trailer to the PR body and retry")
  }

  if (on("bd-embedded-write-lock")) {
    const embedded = await decideEmbeddedWrite(
      parsed,
      cwd,
      deps.env,
      deps.callID,
      deadline,
      deps.runnerLookup ?? embeddedWriteRunner,
      writeWaitFromOptions(options),
    )
    if (embedded?.kind === "block") return block("bd-embedded-write-lock", embedded.reason)
    if (embedded?.kind === "rewrite") command = embedded.command
  }

  // The actor prefix goes on after the runner rewrite so the executed command keeps it.
  if (injection !== undefined) command = withActorPrefix(command, injection.actor, injection.variable)
  if (hooksSkipped && command !== original) {
    command = `${BINARY_HOOKS_NOTE}\n${command}`
    advisories.push("Hooks were skipped to keep the existing (binary) Git hooks intact.")
  }
  return { kind: "allow", command, advisories }
}
