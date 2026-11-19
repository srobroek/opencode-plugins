/**
 * Claims a subagent holds that the claim tracker never saw.
 *
 * The tracker records only what bd's own `--json` confirms from a plain command, so a claim made
 * inside a shell function, a script or a pipeline is invisible to it. A subagent writes under its
 * run-scoped actor (`agentActor`), so when it ends the ledger can answer directly: what does bd
 * list as in progress under that actor? That list is merged with the tracked claims and released
 * through the same guarded path.
 */

import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { planEmbeddedWrites } from "./bd-embedded-write-lock.ts"
import type { TrackedClaim } from "./claims.ts"
import { type BdRun, bdStoreDir, bdStoreForInvocation, envelopeData, parseTrailingJson } from "./gate-admission.ts"
import { claimEnvironment } from "./release.ts"

/** Most records of unfinished subagents kept at once; the oldest go first. */
export const MAX_RETAINED_SCOPES = 64

/**
 * The stores a command's `bd` writes land in, as the write planner resolves them (the same plan
 * admission and the write lock use), plus the store the call starts in.
 */
export function plannedStores(command: string, cwd: string, env: NodeJS.ProcessEnv): string[] {
  const stores = new Set<string>()
  const ambient = bdStoreDir(cwd, env)
  if (ambient !== undefined) stores.add(ambient)
  planEmbeddedWrites(command, cwd, env, {
    classify: false,
    observe: ({ invocation, store, cwd: writeCwd, beadsDir }) => {
      const named = store ?? bdStoreForInvocation(invocation, writeCwd, { ...env, BEADS_DIR: beadsDir })
      if (named !== undefined && existsSync(named)) stores.add(named)
    },
  })
  return [...stores]
}

/** The actor a subagent wrote under and the stores its shell calls ran against. */
export type ReconcileScope = { actor: string; stores: string[] }

/** Read a stored scope back, dropping anything malformed. */
export function readReconcileScope(value: unknown): ReconcileScope | undefined {
  const record = value as { actor?: unknown; stores?: unknown } | null | undefined
  if (typeof record?.actor !== "string" || record.actor === "" || !Array.isArray(record.stores)) return undefined
  return { actor: record.actor, stores: record.stores.filter((store): store is string => typeof store === "string" && store !== "") }
}

/** `scope` widened by `stores`, or `scope` itself when they add nothing. */
export function withStores(scope: ReconcileScope | undefined, actor: string, stores: readonly string[]): ReconcileScope {
  const known = scope?.actor === actor ? scope.stores : []
  const added = stores.filter((store, index) => !known.includes(store) && stores.indexOf(store) === index)
  return added.length === 0 && scope?.actor === actor ? scope : { actor, stores: [...known, ...added] }
}

/** The bd call that lists what `actor` holds in progress. */
export const listHeldArgs = (actor: string): string[] => ["list", "--assignee", actor, "--status", "in_progress", "--limit", "0", "--json"]

export type Reconciled = {
  /** In-progress claims bd lists under the actor, keyed like the tracker keys them. */
  claims: Record<string, TrackedClaim>
  /** Stores whose list could not be read, and why. */
  failures: Array<{ store: string; failure: string }>
}

/** Ask bd, store by store, which beads `scope.actor` holds in progress. */
export async function reconcileHeld(scope: ReconcileScope, run: BdRun, deadline: number, base: NodeJS.ProcessEnv): Promise<Reconciled> {
  const result: Reconciled = { claims: {}, failures: [] }
  for (const store of scope.stores) {
    try {
      const env = claimEnvironment({ actor: scope.actor, store }, base)
      const listed = await run(dirname(store), listHeldArgs(scope.actor), deadline, env)
      if (!("output" in listed)) {
        result.failures.push({ store, failure: listed.failure })
        continue
      }
      const rows = envelopeData(parseTrailingJson(listed.output))
      if (!Array.isArray(rows)) {
        result.failures.push({ store, failure: "bd list returned malformed data" })
        continue
      }
      for (const row of rows as Array<Record<string, unknown> | null>) {
        if (row === null || typeof row !== "object" || typeof row.id !== "string") continue
        if (row.assignee !== scope.actor || row.status !== "in_progress") continue
        result.claims[`${store}\0${row.id}`] = { id: row.id, actor: scope.actor, store }
      }
    } catch (error) {
      result.failures.push({ store, failure: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}

/** `tracked` plus `found`; a found claim replaces a tracked one for the same bead in the same store. */
export function mergeClaims(tracked: Record<string, TrackedClaim>, found: Record<string, TrackedClaim>): Record<string, TrackedClaim> {
  const merged = { ...tracked }
  for (const [key, claim] of Object.entries(found)) {
    for (const [other, existing] of Object.entries(merged)) if (existing.id === claim.id && existing.store === claim.store) delete merged[other]
    merged[key] = claim
  }
  return merged
}
