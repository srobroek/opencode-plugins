/**
 * Outcome ledger for `srobroek.model-roles`: one record per child session a routed spawn
 * created, with what the spawn asked for, what the child used and how it ended. Facts only,
 * no prompt, description, result or command text. The record is the evidence opt-in
 * evaluation-based routing will read; nothing reads it yet. Reducers are pure; the store at
 * the bottom adds persistence.
 */

import type { FailureClass } from "./health.ts"
import type { SpawnRule, SpawnSource } from "./receipt.ts"
import type { TestResult, Verdict } from "./signals.ts"

export const OUTCOME_KEY_PREFIX = "outcome:"
export const LEDGER_MAX_ENTRIES = 1000
export const LEDGER_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** Step events arrive often: their writes wait this long and merge. */
export const LEDGER_DEBOUNCE_MS = 2000

/** Version of the record shape. Without it a record is legacy: it stored 0 for usage the host never reported. */
export const LEDGER_VERSION = 2

export type Outcome = "succeeded" | "interrupted" | `failed:${FailureClass | "other"}`

export type OutcomeRecord = {
  /** Record schema version; absent on legacy records, whose 0 usage is ambiguous. */
  v?: number
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
  // Usage: undefined until a step reports it; a reported 0 is 0.
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  cost?: number
  steps: number
  /** First spawn to last end, ms. */
  ms: number
  // Outcome
  outcome?: Outcome
  /** A failover moved the child to another model. */
  failedOver?: boolean
  // Outcome signals from the child's own session; enums and a boolean, never text.
  verdict?: Verdict
  /** The last test run of the child; `none` when it ran none. */
  tests?: TestResult
  /** Any step edited a test file. */
  touchedTests?: boolean
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

/** `total` plus a reported `value`; `total` itself while nothing is reported. */
const add = (total: number | undefined, value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? (total ?? 0) + value : total

/** A new child. A child already recorded keeps its record. */
export function onSpawn(ledger: Ledger, childID: string, facts: SpawnFacts): Ledger {
  if (ledger[childID] !== undefined) return ledger
  const record: OutcomeRecord = {
    v: LEDGER_VERSION,
    at: facts.at,
    agent: facts.agent,
    model: facts.model,
    parentID: facts.parentID,
    resumes: 0,
    steps: 0,
    ms: 0,
  }
  if (facts.tier !== undefined) record.tier = facts.tier
  if (facts.source !== undefined) record.source = facts.source
  if (facts.rule !== undefined) record.rule = facts.rule
  return { ...ledger, [childID]: record }
}

const USAGE_KEYS = ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost"] as const

/** A legacy record stored 0 for usage the host never reported: drop those zeros and stamp the version, so new reports read as reported. */
const upgrade = (r: OutcomeRecord): OutcomeRecord => {
  if (r.v !== undefined) return r
  const next: OutcomeRecord = { ...r, v: LEDGER_VERSION }
  for (const key of USAGE_KEYS) if (next[key] === 0) delete next[key]
  return next
}

const update = (ledger: Ledger, childID: string, change: (r: OutcomeRecord) => OutcomeRecord): Ledger => {
  const record = ledger[childID]
  return record === undefined ? ledger : { ...ledger, [childID]: change(upgrade(record)) }
}

/** The child was spawned again with its session id: it is running again, so its earlier outcome no longer stands. */
export const onResume = (ledger: Ledger, childID: string): Ledger =>
  update(ledger, childID, (r) => {
    const { outcome: _earlier, ...running } = r
    return { ...running, resumes: r.resumes + 1 }
  })

const addUsage = (r: OutcomeRecord, usage: Usage): OutcomeRecord => ({
  ...r,
  ...fields({
    inputTokens: add(r.inputTokens, usage.tokens?.input),
    outputTokens: add(r.outputTokens, usage.tokens?.output),
    reasoningTokens: add(r.reasoningTokens, usage.tokens?.reasoning),
    cacheReadTokens: add(r.cacheReadTokens, usage.tokens?.cache?.read),
    cacheWriteTokens: add(r.cacheWriteTokens, usage.tokens?.cache?.write),
    cost: add(r.cost, usage.cost),
  }),
})

/** The defined entries only, so an unreported field stays absent from the record. */
const fields = <T extends Record<string, number | undefined>>(values: T): Partial<Record<keyof T, number>> =>
  Object.fromEntries(Object.entries(values).filter(([, v]) => v !== undefined)) as Partial<Record<keyof T, number>>

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

export type Signals = { verdict?: Verdict; tests?: TestResult; touchedTests?: boolean }

/**
 * Outcome signals seen in the child's session. A verdict and a `pass`/`fail` result replace
 * the earlier one (the last wins); `none` and `touchedTests: false` only fill an unset field,
 * and `touchedTests: true` stays.
 */
export function onSignals(ledger: Ledger, childID: string, signals: Signals): Ledger {
  return update(ledger, childID, (r) => {
    const next: OutcomeRecord = { ...r }
    if (signals.verdict !== undefined) next.verdict = signals.verdict
    if (signals.tests === "pass" || signals.tests === "fail" || (signals.tests === "none" && r.tests === undefined)) next.tests = signals.tests
    if (signals.touchedTests === true) next.touchedTests = true
    else if (signals.touchedTests === false && r.touchedTests === undefined) next.touchedTests = false
    return next.verdict === r.verdict && next.tests === r.tests && next.touchedTests === r.touchedTests ? r : next
  })
}

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
  for (const key of ["resumes", "steps", "ms"]) if (typeof value[key] !== "number") return undefined
  for (const key of ["inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens", "cost"])
    if (value[key] !== undefined && typeof value[key] !== "number") return undefined
  return value as OutcomeRecord
}

/** The storage calls the store uses. */
export type LedgerStorage = {
  get(key: string): Promise<unknown>
  set(key: string, value: never): Promise<unknown>
  remove?(key: string): Promise<unknown>
  scan(input: { prefix: string; after?: string }): Promise<{ entries: ReadonlyArray<{ key: string; value: unknown }>; next?: string }>
}

export const LEDGER_DISPOSE_TIMEOUT_MS = 10_000
export const LEDGER_MAX_QUEUED = 50
export const LEDGER_MAX_WRITE_ATTEMPTS = 3

export type LedgerStoreOptions = {
  debounceMs?: number
  now?: () => number
  limits?: PruneLimits
  /** Bound on `dispose`. */
  disposeTimeoutMs?: number
  /** Waiting operations per child before step updates coalesce. */
  maxQueued?: number
  /** Writes of one record tried before giving up. */
  maxWriteAttempts?: number
  warn?: (message: string, extra?: Record<string, unknown>) => void
}

const addUsages = (a: Usage, b: Usage): Usage => ({
  ...fields({ cost: add(a.cost, b.cost) }),
  tokens: {
    ...fields({
      input: add(a.tokens?.input, b.tokens?.input),
      output: add(a.tokens?.output, b.tokens?.output),
      reasoning: add(a.tokens?.reasoning, b.tokens?.reasoning),
    }),
    cache: fields({ read: add(a.tokens?.cache?.read, b.tokens?.cache?.read), write: add(a.tokens?.cache?.write, b.tokens?.cache?.write) }),
  },
})

/**
 * The ledger plus its persistence. Memory holds only the children still running, and the
 * ones whose last write failed; every other record lives in storage, and `index` (id to
 * spawn time) is all that is kept of it. Each child has one queue and every operation on
 * it, read, reduce and write, runs whole in that queue. Writes on end events are immediate,
 * writes during steps are debounced. A failed write keeps the record in memory and dirty
 * until a later write lands or the attempts run out. A child's queue is capped (step updates
 * past it coalesce, nothing else is dropped), and `dispose` is bounded.
 *
 * Ordering: a key's next storage call starts only after the previous one settled, so writes
 * land in issue order; retention deletes through the same queue. There is no per-call deadline,
 * because a call that was given up on cannot be cancelled and could still land after a newer
 * write. The store assumes the host's plugin storage calls settle. After `dispose` begins no
 * new operation is admitted.
 *
 * Design limit: a writer still in flight when `dispose`'s bound runs out can complete after a
 * reload and overwrite the new instance's write for that key. That is accepted: storage is
 * assumed to settle, and the ledger is advisory telemetry, never read for a decision.
 */
export function createLedgerStore(storage: LedgerStorage, options: LedgerStoreOptions = {}) {
  const debounceMs = options.debounceMs ?? LEDGER_DEBOUNCE_MS
  const now = options.now ?? Date.now
  const limits = options.limits ?? { maxEntries: LEDGER_MAX_ENTRIES, maxAgeMs: LEDGER_MAX_AGE_MS }
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
  const keyOf = (id: string) => `${OUTCOME_KEY_PREFIX}${id}`

  /** Queue `task` behind the earlier operations on this child. Refused once the store is closed, except `force` (dispose's retries). */
  const run = (id: string, task: () => Promise<void>, counted = true, force = false): Promise<void> => {
    if (closed && !force) return Promise.resolve()
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
    try {
      await storage.set(keyOf(id), record as never)
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
    const raw = await Promise.resolve(storage.get(keyOf(id))).catch((error) => {
      warn(`outcome ledger: could not read ${id}`, { error: String(error) })
      return undefined
    })
    const stored = readOutcome(raw)
    if (stored === undefined) return undefined
    active.set(id, stored)
    return stored
  }

  /** Write the waiting records. At dispose, records whose write failed wait for the retry pass after the drain. */
  const flush = async (retryFailed = true) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const ids = [...dirty].filter((id) => retryFailed || !failures.has(id))
    for (const id of ids) dirty.delete(id)
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
          try {
            await storage.remove?.(keyOf(id))
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
          const page = await storage.scan(after === undefined ? { prefix: OUTCOME_KEY_PREFIX } : { prefix: OUTCOME_KEY_PREFIX, after })
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
    /**
     * Every record, read-only: stored ones plus the running or unwritten ones in memory,
     * which are newer. A storage failure yields what was read.
     */
    records: async (): Promise<OutcomeRecord[]> => {
      const found = new Map<string, OutcomeRecord>()
      try {
        let after: string | undefined
        do {
          const page = await storage.scan(after === undefined ? { prefix: OUTCOME_KEY_PREFIX } : { prefix: OUTCOME_KEY_PREFIX, after })
          for (const entry of page.entries) {
            const record = readOutcome(entry.value)
            if (record !== undefined) found.set(entry.key.slice(OUTCOME_KEY_PREFIX.length), record)
          }
          after = page.next
        } while (after !== undefined)
      } catch (error) {
        warn("outcome ledger: could not read the records for the report", { error: String(error) })
      }
      // Only what retention keeps; running or unwritten records in memory are newer than the stored ones.
      for (const id of [...found.keys()]) if (!index.has(id)) found.delete(id)
      for (const [id, record] of active) if (index.has(id)) found.set(id, record)
      return [...found.values()].map((record) => ({ ...record }))
    },
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
    signals: (id: string, signals: Signals) => change(id, (l, i) => onSignals(l, i, signals), "debounce"),
    failover: (id: string) => change(id, onFailover, "now"),
    flush,
    /**
     * Admits nothing new, writes what is waiting, drains every child's queue, then retries the
     * records whose write failed through the same queues and drains again. After `timeoutMs` (default `disposeTimeoutMs`)
     * it logs what is left unwritten and returns; nothing is cancelled or reordered.
     */
    async dispose(timeoutMs: number = disposeTimeoutMs) {
      const flushing = flush(false)
      closed = true
      const drain = async () => {
        while (outstanding.size > 0) await Promise.all([...outstanding])
      }
      const unwritten = () => [...active.keys()].filter((id) => dirty.has(id) || failures.has(id) || finished.has(id))
      const drained = (async () => {
        await flushing
        await drain()
        await Promise.all(unwritten().map((id) => run(id, () => save(id), false, true)))
        await drain()
        return "drained" as const
      })()
      let bound: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<"expired">((resolve) => {
        bound = setTimeout(() => resolve("expired"), timeoutMs)
        ;(bound as { unref?: () => void }).unref?.()
      })
      const result = await Promise.race([drained, expired])
      clearTimeout(bound)
      const left = unwritten()
      if (result === "expired") warn(`outcome ledger: dispose gave up after ${timeoutMs}ms with ${outstanding.size} operations unfinished; unwritten: ${left.join(", ") || "none"}`)
      else if (left.length > 0) warn(`outcome ledger: ${left.length} records could not be written: ${left.join(", ")}`)
    },
  }
}
