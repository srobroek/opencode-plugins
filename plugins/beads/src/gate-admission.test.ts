import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type BdRun,
  envelopeData,
  formatGateAdvisory,
  GateAdmitter,
  gatesCanResolve,
  lifecycleBdEnvironment,
  parseTrailingJson,
  readCheckOutcome,
  readGateList,
  readGates,
  runBdResult,
  staleSkipNotice,
  verifyGates,
} from "./gate-admission.ts"

/** `bd gate list --json` under BD_JSON_ENVELOPE=1, verbatim shape from bd 1.1.2. */
const GATE_LIST = JSON.stringify({
  data: [
    {
      id: "bd-probe-23d",
      title: "Gate: human",
      description: "Ad-hoc gate blocking bd-probe-2m7\n\nReason: needs design review",
      status: "open",
      issue_type: "gate",
      await_type: "human",
    },
    {
      id: "bd-probe-toz",
      title: "Gate: timer",
      description: "Ad-hoc gate blocking bd-probe-2m7",
      status: "open",
      issue_type: "gate",
      await_type: "timer",
    },
  ],
  schema_version: 1,
})

/** `bd gate check --json`: human progress lines, then the envelope. */
const GATE_CHECK = [
  "○ bd-probe-toz: pending - expires in 47h59m53s",
  "",
  "Checked 1 gates: 0 resolved, 0 escalated, 0 errors",
  JSON.stringify({ data: { checked: 1, dry_run: false, errors: 0, escalated: 0, resolved: 0 }, schema_version: 1 }),
].join("\n")

describe("parseTrailingJson / envelopeData", () => {
  test("finds the envelope after bd's human summary", () => {
    expect(readCheckOutcome(GATE_CHECK)).toEqual({ resolved: 0, escalated: 0, errors: 0 })
  })
  test("plain text alone yields nothing", () => {
    expect(parseTrailingJson("No open gates found.")).toBeUndefined()
    expect(parseTrailingJson("   ")).toBeUndefined()
  })
  test("bare --json output passes through unwrapping", () => {
    expect(envelopeData([{ id: "a" }])).toEqual([{ id: "a" }])
    expect(envelopeData({ data: null, schema_version: 1 })).toBeNull()
  })
  test("counts read from a resolved check", () => {
    const out = readCheckOutcome(`Checked 2 gates\n${JSON.stringify({ data: { resolved: 1, escalated: 1, errors: 0 }, schema_version: 1 })}`)
    expect(out).toEqual({ resolved: 1, escalated: 1, errors: 0 })
    expect(readCheckOutcome("Checked 1 gates without JSON")).toBeUndefined()
  })
})

describe("readGates", () => {
  test("reads type, blocked issue and reason", () => {
    const gates = readGates(GATE_LIST)
    expect(gates).toHaveLength(2)
    expect(gates[0]).toEqual({ id: "bd-probe-23d", awaitType: "human", blocks: "bd-probe-2m7", reason: "needs design review" })
    expect(gates[1]?.reason).toBeUndefined()
  })
  test("an empty database yields no gates", () => {
    expect(readGates(JSON.stringify({ data: null, schema_version: 1 }))).toEqual([])
    expect(readGates("No open gates found.")).toEqual([])
  })
  test("accepts bd's null empty-list contract but rejects malformed rows", () => {
    expect(readGateList("null")).toEqual([])
    expect(readGateList(JSON.stringify({ data: null, schema_version: 1 }))).toEqual([])
    expect(readGateList(JSON.stringify({ data: null, error: null, schema_version: 1 }))).toEqual([])
    expect(readGateList(JSON.stringify({ data: null, error: "database unavailable", schema_version: 1 }))).toBeUndefined()
    expect(readGateList(JSON.stringify({ data: [{ id: "g1" }], schema_version: 1 }))).toBeUndefined()
    expect(readGateList(JSON.stringify({ error: "database unavailable" }))).toBeUndefined()
  })
  test("closed rows are not open gates", () => {
    expect(readGates(JSON.stringify({ data: [{ id: "g1", status: "closed", await_type: "timer" }], schema_version: 1 }))).toEqual([])
  })
})

describe("gatesCanResolve and formatGateAdvisory", () => {
  test("a human gate alone never earns a check; timer, github and bead gates do", () => {
    expect(gatesCanResolve([{ id: "g", awaitType: "human" }])).toBe(false)
    expect(gatesCanResolve([{ id: "g", awaitType: "human" }, { id: "t", awaitType: "timer" }])).toBe(true)
    expect(gatesCanResolve([{ id: "r", awaitType: "gh:run" }])).toBe(true)
    expect(gatesCanResolve([{ id: "b", awaitType: "bead" }])).toBe(true)
  })
  test("names every gate and the check outcome", () => {
    const text = formatGateAdvisory(readGates(GATE_LIST), readCheckOutcome(GATE_CHECK)) ?? ""
    expect(text).toContain("bd-probe-23d (human) blocks bd-probe-2m7 -- needs design review")
    expect(text).toContain("bd-probe-toz (timer)")
    expect(text).toContain("0 resolved")
    expect(text).toContain("bd gate resolve")
  })
  test("no gates, no advisory; a long list is capped; no check, no outcome", () => {
    expect(formatGateAdvisory([], undefined)).toBeUndefined()
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `g${i}`, awaitType: "human" }))
    const text = formatGateAdvisory(many, undefined) ?? ""
    expect(text).toContain("12 open beads gate(s)")
    expect(text).toContain("...and 4 more")
    expect(formatGateAdvisory([{ id: "g", awaitType: "human" }], undefined)).not.toContain("bd gate check")
  })
})

describe("staleSkipNotice", () => {
  test("ids from the json envelope", () => {
    const output = JSON.stringify({
      data: { source: ".beads/issues.jsonl", created: 4, skipped: 1, stale_skipped_ids: ["bd-probe-2m7"] },
      schema_version: 1,
    })
    const notice = staleSkipNotice(output) ?? ""
    expect(notice).toContain("bd-probe-2m7")
    expect(notice).toContain("BEHIND this database")
    expect(notice).toContain("BEFORE pulling peer changes")
  })
  test("bd's plain-text form counts too", () => {
    expect(staleSkipNotice("Imported 3 issues from .beads/issues.jsonl (2 stale skipped; use --allow-stale to restore older rows)")).toContain(
      "2 row(s)",
    )
  })
  test("a clean import is silent", () => {
    expect(staleSkipNotice(JSON.stringify({ data: { created: 5, skipped: 0 }, schema_version: 1 }))).toBeUndefined()
    expect(staleSkipNotice("Imported 5 issues from .beads/issues.jsonl")).toBeUndefined()
    expect(staleSkipNotice("Imported 5 issues (0 stale skipped)")).toBeUndefined()
  })
})

describe("gate verification", () => {
  const scripted =
    (answers: Record<string, () => Awaited<ReturnType<BdRun>>>): BdRun & { calls: string[] } => {
      const calls: string[] = []
      const run = (async (_cwd: string, args: string[]) => {
        const key = args.slice(0, 2).join(" ")
        calls.push(key)
        return answers[key]?.() ?? { failure: `unexpected ${key}` }
      }) as unknown as BdRun & { calls: string[] }
      run.calls = calls
      return run
    }

  test("an empty list is verified without a check", async () => {
    const run = scripted({ "gate list": () => ({ output: "null" }) })
    expect(await verifyGates("/repo", {}, run)).toEqual({ verified: true })
    expect(run.calls).toEqual(["gate list"])
  })
  test("unresolved human gates are verified and listed", async () => {
    const human = JSON.stringify({ data: [JSON.parse(GATE_LIST).data[0]], schema_version: 1 })
    const run = scripted({ "gate list": () => ({ output: human }) })
    const verdict = await verifyGates("/repo", {}, run)
    expect(verdict.verified).toBe(true)
    expect(verdict.notice).toContain("bd-probe-23d (human)")
  })
  test("a failed, malformed or erroring check is not verified", async () => {
    const list = () => ({ output: GATE_LIST })
    expect((await verifyGates("/repo", {}, scripted({ "gate list": list, "gate check": () => ({ failure: "boom" }) }))).verified).toBe(false)
    const malformed = await verifyGates("/repo", {}, scripted({ "gate list": list, "gate check": () => ({ output: "nope" }) }))
    expect(malformed.notice).toContain("malformed")
    const errors = await verifyGates(
      "/repo",
      {},
      scripted({ "gate list": list, "gate check": () => ({ output: JSON.stringify({ data: { resolved: 0, escalated: 0, errors: 2 }, schema_version: 1 }) }) }),
    )
    expect(errors).toEqual({ notice: "Beads gate check reported 2 error(s); unresolved gates remain unverified.", verified: false })
  })
  test("a malformed list is not verified", async () => {
    const verdict = await verifyGates("/repo", {}, scripted({ "gate list": () => ({ output: '{"data":[{"id":"g"}],"schema_version":1}' }) }))
    expect(verdict).toEqual({ notice: "Beads gate list returned malformed data; unresolved gates remain unverified.", verified: false })
  })
  test("a later admission retries a settled failed verification", async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-admit-"))
    mkdirSync(join(root, ".beads"))
    let fail = true
    const admitter = new GateAdmitter(async () => (fail ? { failure: "store unavailable" } : { output: "null" }))
    try {
      const first = await admitter.admit(root, {}, true, Date.now() + 2_000)
      expect(first).toMatchObject({ block: true })
      fail = false
      expect(await admitter.admit(root, {}, true, Date.now() + 2_000)).toEqual({ block: false, notice: undefined })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("admission waits only for the caller's deadline and reports the real wait", async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-admit-slow-"))
    mkdirSync(join(root, ".beads"))
    const admitter = new GateAdmitter(() => new Promise(() => {}))
    try {
      const started = Date.now()
      const admission = await admitter.admit(root, {}, true, Date.now() + 300)
      expect(admission).toMatchObject({ block: true })
      expect((admission as { reason: string }).reason).toContain("still being verified")
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("lifecycleBdEnvironment", () => {
  test("sets embedded-store safety flags and clears shared-server mode", () => {
    const env = lifecycleBdEnvironment("/nowhere", { BEADS_DOLT_SHARED_SERVER: "1", PATH: "/bin" })
    expect(env).toMatchObject({ BEADS_DOLT_SHARED_SERVER: "", BD_NO_PAGER: "1", BD_NON_INTERACTIVE: "1", BD_DOLT_AUTO_START: "false", NO_COLOR: "1" })
    expect(lifecycleBdEnvironment("/nowhere", { BEADS_DIR: "/explicit" }).BEADS_DIR).toBe("/explicit")
  })
})

describe("runBdResult", () => {
  test("keeps nonzero stderr bounded in the failure result", async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-run-fail-"))
    const script = join(root, "bd")
    writeFileSync(script, "#!/bin/sh\nprintf '%s' 'permission denied by the embedded ledger' >&2\nexit 7\n")
    chmodSync(script, 0o755)
    try {
      const result = await runBdResult(root, ["list"], Date.now() + 5_000, { ...process.env, PATH: root })
      expect(result).toEqual({ failure: "bd exited with code 7: permission denied by the embedded ledger" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  test("distinguishes a timed-out bd process", async () => {
    const root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-run-timeout-"))
    const script = join(root, "bd")
    writeFileSync(script, "#!/bin/sh\nexec /bin/sleep 1\n")
    chmodSync(script, 0o755)
    try {
      expect(await runBdResult(root, ["list"], Date.now() + 30, { ...process.env, PATH: root })).toEqual({ failure: "bd command timed out" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
