/**
 * Outcome ledger for `srobroek.model-roles`: one record per child session a routed spawn
 * created, with what the spawn asked for, what the child used and how it ended. Facts only,
 * no prompt, description, result or command text. The record is the evidence opt-in
 * evaluation-based routing will read; nothing reads it yet. Reducers are pure; the store at
 * the bottom adds persistence.
 */

import type { FailureClass } from "./health.ts"
import type { SpawnRule, SpawnSource } from "./receipt.ts"

export const OUTCOME_KEY_PREFIX = "outcome:"
export const LEDGER_MAX_ENTRIES = 1000
export const LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** Step events arrive often: their writes wait this long and merge. */
export const LEDGER_DEBOUNCE_MS = 2000

export type Outcome = "succeeded" | "interrupted" | `failed:${FailureClass | "other"}`

export type OutcomeRecord = {
  // Spawn
  at: number
  agent: string
  tier?: string
  /** `provider/model#variant`. */
  model: string
  source?: SpawnSource
  rule?: SpawnRule
  parentID: string
  /** How many times the child was resumed after its first run. */
  resumes: number
  // Usage
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  steps: number
  /** First spawn to last end, ms. */
  ms: number
  // Outcome
  outcome?: Outcome
  /** A failover moved the child to another model. */
  failedOver?: boolean
  // Reserved for evaluation-based routing; unset until it exists.
  policy?: string
  eligible?: boolean
  arm?: string
  p?: number
}

export type Ledger = Readonly<Record<string, OutcomeRecord>>

export type SpawnFacts = Pick<OutcomeRecord, "at" | "agent" | "model" | "parentID"> &
  Partial<Pick<OutcomeRecord, "tier" | "source" | "rule">>

export type Usage = {
  cost?: number
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}

export const newLedger = (): Ledger => ({})

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

/** A new child. A child already recorded keeps its record. */
export function onSpawn(ledger: Ledger, childID: string, facts: SpawnFacts): Ledger {
  if (ledger[childID] !== undefined) return ledger
  const record: OutcomeRecord = {
    at: facts.at,
    agent: facts.agent,
    model: facts.model,
    parentID: facts.parentID,
    resumes: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    steps: 0,
    ms: 0,
  }
  if (facts.tier !== undefined) record.tier = facts.tier
  if (facts.source !== undefined) record.source = facts.source
  if (facts.rule !== undefined) record.rule = facts.rule
  return { ...ledger, [childID]: record }
}

const update = (ledger: Ledger, childID: string, change: (r: OutcomeRecord) => OutcomeRecord): Ledger => {
  const record = ledger[childID]
  return record === undefined ? ledger : { ...ledger, [childID]: change(record) }
}

/** The child was spawned again with its session id. */
export const onResume = (ledger: Ledger, childID: string): Ledger => update(ledger, childID, (r) => ({ ...r, resumes: r.resumes + 1 }))

const addUsage = (r: OutcomeRecord, usage: Usage): OutcomeRecord => ({
  ...r,
  inputTokens: r.inputTokens + num(usage.tokens?.input),
  outputTokens: r.outputTokens + num(usage.tokens?.output),
  reasoningTokens: r.reasoningTokens + num(usage.tokens?.reasoning),
  cacheReadTokens: r.cacheReadTokens + num(usage.tokens?.cache?.read),
  cacheWriteTokens: r.cacheWriteTokens + num(usage.tokens?.cache?.write),
  cost: r.cost + num(usage.cost),
})

/** A model step ended. */
export const onStep = (ledger: Ledger, childID: string, usage: Usage): Ledger =>
  update(ledger, childID, (r) => ({ ...addUsage(r, usage), steps: r.steps + 1 }))

/** A compaction ended: its cost and tokens count, it is not a step. */
export const onCompaction = (ledger: Ledger, childID: string, usage: Usage): Ledger => update(ledger, childID, (r) => addUsage(r, usage))

/** The child's run ended at `at`; a later run of a resumed child overwrites the outcome. */
export const onEnd = (ledger: Ledger, childID: string, outcome: Outcome, at: number): Ledger =>
  update(ledger, childID, (r) => ({ ...r, outcome, ms: Math.max(0, at - r.at) }))

export const onFailover = (ledger: Ledger, childID: string): Ledger => update(ledger, childID, (r) => (r.failedOver ? r : { ...r, failedOver: true }))

export type PruneLimits = { maxEntries: number; maxAgeMs: number }

/** Drops records older than `maxAgeMs`, then all but the newest `maxEntries`. */
export function prune<T extends { at: number }>(
  ledger: Readonly<Record<string, T>>,
  now: number,
  limits: PruneLimits = { maxEntries: LEDGER_MAX_ENTRIES, maxAgeMs: LEDGER_MAX_AGE_MS },
): Readonly<Record<string, T>> {
  const kept = Object.entries(ledger)
    .filter(([, r]) => now - r.at <= limits.maxAgeMs)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, limits.maxEntries)
  return kept.length === Object.keys(ledger).length ? ledger : Object.fromEntries(kept)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** A stored record, or undefined when it is malformed. */
export function readOutcome(value: unknown): OutcomeRecord | undefined {
  if (!isRecord(value)) return undefined
  const { at, agent, model, parentID } = value
  if (typeof at !== "number" || typeof agent !== "string" || typeof model !== "string" || typeof parentID !== "string") return undefined
  for (const key of ["resumes", "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost", "steps", "ms"])
    if (typeof value[key] !== "number") return undefined
  return value as OutcomeRecord
}

/** The storage calls the store uses. */
export type LedgerStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<unknown>
  remove?(key: string): Promise<unknown>
  scan(input: { prefix: string; after?: string }): Promise<{ entries: ReadonlyArray<{ key: string; value: unknown }>; next?: string }>
}

/**
 * The ledger plus its persistence. Memory holds only the children still running; every
 * record lives in storage, and `index` (id to spawn time) is all that is kept of the rest.
 * Each child has one queue and every operation on it, read, reduce and write, runs whole in
 * that queue. Writes on end events are immediate, writes during steps are debounced.
 * Retention removes a record through the same queue. After `dispose` no operation runs.
 */
export function createLedgerStore(storage: LedgerStorage, options: { debounceMs?: number; now?: () => number; limits?: PruneLimits } = {}) {
  const debounceMs = options.debounceMs ?? LEDGER_DEBOUNCE_MS
  const now = options.now ?? Date.now
  const limits = options.limits ?? { maxEntries: LEDGER_MAX_ENTRIES, maxAgeMs: LEDGER_MAX_AGE_MS }
  const index = new Map<string, number>()
  const active = new Map<string, OutcomeRecord>()
  const dirty = new Set<string>()
  const queues = new Map<string, Promise<void>>()
  const outstanding = new Set<Promise<void>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const keyOf = (id: string) => `${OUTCOME_KEY_PREFIX}${id}`

  /** Queue `task` behind the earlier operations on this child. Refused once the store is closed. */
  const run = (id: string, task: () => Promise<void>): Promise<void> => {
    if (closed) return Promise.resolve()
    const queued: Promise<void> = (queues.get(id) ?? Promise.resolve()).then(task).catch(() => {})
    queues.set(id, queued)
    outstanding.add(queued)
    void queued.then(() => {
      outstanding.delete(queued)
      if (queues.get(id) === queued) queues.delete(id)
    })
    return queued
  }

  /** Inside the child's queue: save the record as it stands. A pruned or absent record is not written. */
  const write = async (id: string) => {
    const record = active.get(id)
    if (record === undefined || !index.has(id)) return
    try {
      await storage.set(keyOf(id), record as never)
    } catch {
      // The in-memory record still counts.
    }
  }

  /** Inside the child's queue: the record in memory, read back from storage when a finished child runs again. */
  const load1 = async (id: string): Promise<OutcomeRecord | undefined> => {
    if (!index.has(id)) return undefined
    const known = active.get(id)
    if (known !== undefined) return known
    const stored = readOutcome(await storage.get(keyOf(id)).catch(() => undefined))
    if (stored === undefined) return undefined
    active.set(id, stored)
    return stored
  }

  const flush = async () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const ids = [...dirty]
    dirty.clear()
    await Promise.all(ids.map((id) => run(id, () => write(id))))
  }
  const later = (id: string) => {
    dirty.add(id)
    if (timer !== undefined) return
    timer = setTimeout(() => void flush(), debounceMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  /** Remove what retention drops, each through its own queue. Never called from inside a queue. */
  const retain = async () => {
    const kept = prune(Object.fromEntries([...index].map(([id, at]) => [id, { at }])), now(), limits)
    const gone = [...index.keys()].filter((id) => kept[id] === undefined)
    await Promise.all(
      gone.map((id) =>
        run(id, async () => {
          index.delete(id)
          active.delete(id)
          dirty.delete(id)
          try {
            await storage.remove?.(keyOf(id))
          } catch {
            // It prunes again at the next start.
          }
        }),
      ),
    )
  }

  const change = async (id: string, reduce: (ledger: Ledger, id: string) => Ledger, how: "debounce" | "now" | "end") => {
    await run(id, async () => {
      const record = await load1(id)
      if (record === undefined) return
      const next = reduce({ [id]: record }, id)[id]
      if (next === undefined || next === record) return
      active.set(id, next)
      if (how === "debounce" && !closed) return later(id)
      dirty.delete(id)
      await write(id)
      if (how === "end" && !dirty.has(id)) active.delete(id)
    })
    if (how === "end") await retain()
  }

  return {
    /** Indexes the stored records, every page of them, and prunes. */
    async load() {
      try {
        let after: string | undefined
        do {
          const page = await storage.scan(after === undefined ? { prefix: OUTCOME_KEY_PREFIX } : { prefix: OUTCOME_KEY_PREFIX, after })
          for (const entry of page.entries) {
            const record = readOutcome(entry.value)
            if (record !== undefined) index.set(entry.key.slice(OUTCOME_KEY_PREFIX.length), record.at)
          }
          after = page.next
        } while (after !== undefined)
        await retain()
      } catch {
        // Start with what was read; new spawns still record.
      }
    },
    size: () => index.size,
    /** Records held in memory. */
    active: () => active.size,
    spawn: async (id: string, facts: SpawnFacts) => {
      await run(id, async () => {
        if (index.has(id)) return
        const record = onSpawn(newLedger(), id, facts)[id]
        if (record === undefined) return
        index.set(id, record.at)
        active.set(id, record)
        await write(id)
      })
      await retain()
    },
    resume: (id: string) => change(id, onResume, "now"),
    step: (id: string, usage: Usage) => change(id, (l, i) => onStep(l, i, usage), "debounce"),
    compaction: (id: string, usage: Usage) => change(id, (l, i) => onCompaction(l, i, usage), "debounce"),
    end: (id: string, outcome: Outcome, at: number) => change(id, (l, i) => onEnd(l, i, outcome, at), "end"),
    failover: (id: string) => change(id, onFailover, "now"),
    flush,
    /** Queues the waiting writes, refuses new operations, then waits for every queued one, reads included. */
    async dispose() {
      const flushing = flush()
      closed = true
      await flushing
      while (outstanding.size > 0) await Promise.all([...outstanding])
    },
  }
}
