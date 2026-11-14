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

/** Several step updates folded into one: `steps` of them, `usage` summed. */
export const onSteps = (ledger: Ledger, childID: string, usage: Usage, steps: number): Ledger =>
  update(ledger, childID, (r) => ({ ...addUsage(r, usage), steps: r.steps + steps }))

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

export const LEDGER_STORAGE_TIMEOUT_MS = 5000
export const LEDGER_DISPOSE_TIMEOUT_MS = 10_000
export const LEDGER_MAX_QUEUED = 50
export const LEDGER_MAX_WRITE_ATTEMPTS = 3

export type LedgerStoreOptions = {
  debounceMs?: number
  now?: () => number
  limits?: PruneLimits
  /** Deadline for each storage call. */
  storageTimeoutMs?: number
  /** Bound on `dispose`. */
  disposeTimeoutMs?: number
  /** Waiting operations per child before step updates coalesce. */
  maxQueued?: number
  /** Writes of one record tried before giving up. */
  maxWriteAttempts?: number
  warn?: (message: string, extra?: Record<string, unknown>) => void
}

const addUsages = (a: Usage, b: Usage): Usage => ({
  cost: num(a.cost) + num(b.cost),
  tokens: {
    input: num(a.tokens?.input) + num(b.tokens?.input),
    output: num(a.tokens?.output) + num(b.tokens?.output),
    reasoning: num(a.tokens?.reasoning) + num(b.tokens?.reasoning),
    cache: { read: num(a.tokens?.cache?.read) + num(b.tokens?.cache?.read), write: num(a.tokens?.cache?.write) + num(b.tokens?.cache?.write) },
  },
})

/**
 * The ledger plus its persistence. Memory holds only the children still running, and the
 * ones whose last write failed; every other record lives in storage, and `index` (id to
 * spawn time) is all that is kept of it. Each child has one queue and every operation on
 * it, read, reduce and write, runs whole in that queue. Writes on end events are immediate,
 * writes during steps are debounced. A failed write keeps the record in memory and dirty
 * until a later write lands or the attempts run out. Every storage call has a deadline, a
 * child's queue is capped (step updates past it coalesce, nothing else is dropped), and
 * `dispose` is bounded. Retention removes a record through the same queue. After `dispose`
 * no operation runs.
 */
export function createLedgerStore(storage: LedgerStorage, options: LedgerStoreOptions = {}) {
  const debounceMs = options.debounceMs ?? LEDGER_DEBOUNCE_MS
  const now = options.now ?? Date.now
  const limits = options.limits ?? { maxEntries: LEDGER_MAX_ENTRIES, maxAgeMs: LEDGER_MAX_AGE_MS }
  const storageTimeoutMs = options.storageTimeoutMs ?? LEDGER_STORAGE_TIMEOUT_MS
  const disposeTimeoutMs = options.disposeTimeoutMs ?? LEDGER_DISPOSE_TIMEOUT_MS
  const maxQueued = options.maxQueued ?? LEDGER_MAX_QUEUED
  const maxWriteAttempts = options.maxWriteAttempts ?? LEDGER_MAX_WRITE_ATTEMPTS
  const warn = options.warn ?? (() => {})
  const index = new Map<string, number>()
  const active = new Map<string, OutcomeRecord>()
  const dirty = new Set<string>()
  /** Records that ended and are written; they leave memory once a write lands. */
  const finished = new Set<string>()
  const failures = new Map<string, number>()
  const spill = new Map<string, { usage: Usage; steps: number }>()
  const depth = new Map<string, number>()
  const queues = new Map<string, Promise<void>>()
  const outstanding = new Set<Promise<void>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let abandoned = false
  const keyOf = (id: string) => `${OUTCOME_KEY_PREFIX}${id}`

  /** A storage call with a deadline; a call that never settles rejects with a timeout. */
  const within = <T>(call: () => Promise<T>, what: string): Promise<T> => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${what} timed out after ${storageTimeoutMs}ms`)), storageTimeoutMs)
      ;(timeout as { unref?: () => void }).unref?.()
    })
    return Promise.race([Promise.resolve().then(call), deadline]).finally(() => clearTimeout(timeout))
  }

  /** Queue `task` behind the earlier operations on this child. Refused once the store is closed. */
  const run = (id: string, task: () => Promise<void>, counted = true): Promise<void> => {
    if (closed) return Promise.resolve()
    if (counted) depth.set(id, (depth.get(id) ?? 0) + 1)
    const queued: Promise<void> = (queues.get(id) ?? Promise.resolve()).then(task).catch(() => {})
    queues.set(id, queued)
    outstanding.add(queued)
    void queued.then(() => {
      outstanding.delete(queued)
      if (counted) depth.set(id, (depth.get(id) ?? 1) - 1)
      if (depth.get(id) === 0) depth.delete(id)
      if (queues.get(id) === queued) queues.delete(id)
    })
    return queued
  }

  /** Inside the child's queue: save the record as it stands. True when it is in storage; a pruned record needs no write. */
  const write = async (id: string): Promise<boolean> => {
    const record = active.get(id)
    if (record === undefined || !index.has(id)) return true
    if (abandoned) return false
    try {
      await within(() => storage.set(keyOf(id), record as never), `writing ${id}`)
      failures.delete(id)
      dirty.delete(id)
      return true
    } catch (error) {
      const attempts = (failures.get(id) ?? 0) + 1
      failures.set(id, attempts)
      if (attempts >= maxWriteAttempts) {
        warn(`outcome ledger: giving up writing ${id} after ${attempts} attempts`, { error: String(error) })
        dirty.delete(id)
        if (finished.delete(id)) active.delete(id)
        failures.delete(id)
      } else {
        warn(`outcome ledger: could not write ${id} (attempt ${attempts}); it stays in memory`, { error: String(error) })
        later(id)
      }
      return false
    }
  }

  /** Inside the child's queue: a write whose success lets a finished record leave memory. */
  const save = async (id: string) => {
    const ok = await write(id)
    if (ok && finished.has(id) && !dirty.has(id)) {
      active.delete(id)
      finished.delete(id)
    }
  }

  /** Inside the child's queue: the record in memory, read back from storage when a finished child runs again. */
  const load1 = async (id: string): Promise<OutcomeRecord | undefined> => {
    if (!index.has(id)) return undefined
    const known = active.get(id)
    if (known !== undefined) return known
    if (abandoned) return undefined
    const stored = readOutcome(await within(() => storage.get(keyOf(id)), `reading ${id}`).catch((error) => (warn(`outcome ledger: could not read ${id}`, { error: String(error) }), undefined)))
    if (stored === undefined) return undefined
    active.set(id, stored)
    return stored
  }

  const flush = async () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const ids = [...dirty]
    dirty.clear()
    await Promise.all(ids.map((id) => run(id, () => save(id).then(() => undefined), false)))
  }
  function later(id: string) {
    dirty.add(id)
    if (timer !== undefined || closed) return
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
          finished.delete(id)
          failures.delete(id)
          spill.delete(id)
          if (abandoned) return
          try {
            await within(async () => storage.remove?.(keyOf(id)), `removing ${id}`)
          } catch {
            // It prunes again at the next start.
          }
        }),
      ),
    )
  }

  /** Inside the child's queue: fold coalesced step updates into the record. */
  const applySpill = (id: string, record: OutcomeRecord): OutcomeRecord => {
    const pending = spill.get(id)
    if (pending === undefined) return record
    spill.delete(id)
    return onSteps({ [id]: record }, id, pending.usage, pending.steps)[id] ?? record
  }

  const change = async (id: string, reduce: (ledger: Ledger, id: string) => Ledger, how: "debounce" | "now" | "end") => {
    await run(id, async () => {
      const loaded = await load1(id)
      if (loaded === undefined) return
      const record = applySpill(id, loaded)
      const next = reduce({ [id]: record }, id)[id]
      if (next === undefined) return
      if (next === record && record === loaded && !dirty.has(id)) return
      active.set(id, next)
      if (how === "end") finished.add(id)
      if (how === "debounce" && !closed) return later(id)
      dirty.delete(id)
      await save(id)
    })
    if (how === "end") await retain()
  }

  /** A step update past the queue cap folds into a small sum that the next operation applies. */
  const coalescing = (id: string, usage: Usage, steps: number): boolean => {
    if ((depth.get(id) ?? 0) < maxQueued || !index.has(id)) return false
    const pending = spill.get(id)
    spill.set(id, { usage: addUsages(pending?.usage ?? {}, usage), steps: (pending?.steps ?? 0) + steps })
    if (pending === undefined)
      void run(
        id,
        async () => {
          const record = active.get(id) ?? (await load1(id))
          if (record === undefined || !spill.has(id)) return
          active.set(id, applySpill(id, record))
          later(id)
        },
        false,
      )
    return true
  }

  return {
    /** Indexes the stored records, every page of them, and prunes. */
    async load() {
      try {
        let after: string | undefined
        do {
          const page = await within(
            () => storage.scan(after === undefined ? { prefix: OUTCOME_KEY_PREFIX } : { prefix: OUTCOME_KEY_PREFIX, after }),
            "scanning",
          )
          for (const entry of page.entries) {
            const record = readOutcome(entry.value)
            if (record !== undefined) index.set(entry.key.slice(OUTCOME_KEY_PREFIX.length), record.at)
          }
          after = page.next
        } while (after !== undefined)
        await retain()
      } catch (error) {
        warn("outcome ledger: could not read the stored records; starting with what was read", { error: String(error) })
      }
    },
    size: () => index.size,
    /** Records held in memory. */
    active: () => active.size,
    /** Counted operations waiting on this child. */
    queued: (id: string) => depth.get(id) ?? 0,
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
    step: async (id: string, usage: Usage) => {
      if (coalescing(id, usage, 1)) return
      await change(id, (l, i) => onStep(l, i, usage), "debounce")
    },
    compaction: async (id: string, usage: Usage) => {
      if (coalescing(id, usage, 0)) return
      await change(id, (l, i) => onCompaction(l, i, usage), "debounce")
    },
    end: (id: string, outcome: Outcome, at: number) => change(id, (l, i) => onEnd(l, i, outcome, at), "end"),
    failover: (id: string) => change(id, onFailover, "now"),
    flush,
    /**
     * Queues the waiting writes, refuses new operations, then waits for every queued one,
     * reads included, and one more try for records whose write failed. After `disposeTimeoutMs`
     * it logs and returns, and what is still queued does nothing.
     */
    async dispose() {
      const flushing = flush()
      closed = true
      let bound: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<"expired">((resolve) => {
        bound = setTimeout(() => resolve("expired"), disposeTimeoutMs)
        ;(bound as { unref?: () => void }).unref?.()
      })
      const drained = (async () => {
        await flushing
        // Failed writes get one more try: `closed` stops `run`, so write them in place.
        for (const id of [...active.keys()]) if (finished.has(id) || failures.has(id)) await write(id)
        while (outstanding.size > 0) await Promise.all([...outstanding])
        return "drained" as const
      })()
      const result = await Promise.race([drained, expired])
      clearTimeout(bound)
      if (result === "expired") {
        abandoned = true
        warn(`outcome ledger: dispose gave up after ${disposeTimeoutMs}ms with ${outstanding.size} operations unfinished`)
      }
    },
  }
}
