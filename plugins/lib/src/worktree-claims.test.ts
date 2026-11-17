import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claimFile,
  claimKey,
  type LandingRecord,
  landingFile,
  landingsFor,
  listLandings,
  ownershipOf,
  parseClaim,
  parseLanding,
  readClaim,
  readLanding,
  removeClaim,
  removeLanding,
  writeClaim,
  writeLanding,
} from "./worktree-claims.ts"

const roots: string[] = []
const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), "claims-"))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const claim = { directory: "/wt/a", branch: "lane-a", sessionID: "ses_c", parentID: "ses_p", createdAt: 5, generation: 5 }
const landing: LandingRecord = { receiptId: "1-abc", worktree: "/wt/a", headRefOid: "h".repeat(40), sessionID: "ses_p", landedAt: 9 }

describe("parsers", () => {
  test("a claim needs every field", () => {
    expect(parseClaim(claim)).toEqual(claim)
    for (const key of Object.keys(claim).filter((name) => name !== "generation")) {
      expect(parseClaim({ ...claim, [key]: undefined })).toBeUndefined()
    }
    expect(parseClaim({ ...claim, generation: undefined })?.generation).toBe(0)
    expect(parseClaim("x")).toBeUndefined()
    expect(parseClaim(null)).toBeUndefined()
  })

  test("a landing keeps a denial and the nudge flag, and drops a malformed denial", () => {
    expect(parseLanding({ ...landing, denied: { at: 3, sessionID: "s" }, nudged: true })).toEqual({
      ...landing,
      denied: { at: 3, sessionID: "s" },
      nudged: true,
    })
    expect(parseLanding({ ...landing, denied: { at: "x" } })).toEqual(landing)
    expect(parseLanding({ ...landing, headRefOid: "" })).toBeUndefined()
  })
})

describe("paths", () => {
  test("the claim key follows the canonical directory, so a symlinked spelling is the same claim", () => {
    const root = scratch()
    mkdirSync(join(root, "real"))
    symlinkSync(join(root, "real"), join(root, "link"))
    expect(claimKey(join(root, "link"))).toBe(claimKey(join(root, "real")))
    expect(claimKey(join(root, "real"))).toMatch(/^[0-9a-f]{40}$/)
    expect(claimFile("/common", "/wt/a")).toContain("/common/opencode/lane-claims/")
  })

  test("an unsafe receipt id cannot name a landing file", () => {
    expect(() => landingFile("/common", "../escape")).toThrow()
  })
})

describe("claims on disk", () => {
  test("write, read, remove", () => {
    const common = scratch()
    expect(readClaim(common, "/wt/a")).toEqual({ kind: "missing" })
    writeClaim(common, claim)
    expect(readClaim(common, "/wt/a")).toEqual({ kind: "present", value: claim })
    removeClaim(common, "/wt/a")
    expect(readClaim(common, "/wt/a")).toEqual({ kind: "missing" })
  })

  test("a corrupt claim file is unreadable, not missing", () => {
    const common = scratch()
    mkdirSync(join(common, "opencode", "lane-claims"), { recursive: true })
    writeFileSync(claimFile(common, "/wt/a"), "{not json")
    expect(readClaim(common, "/wt/a").kind).toBe("unreadable")
    writeFileSync(claimFile(common, "/wt/a"), JSON.stringify({ directory: "/wt/a" }))
    expect(readClaim(common, "/wt/a").kind).toBe("unreadable")
  })

  test("ownership: a claim means the lane, an unreadable claim means nobody, no claim means none", () => {
    expect(ownershipOf({ kind: "present", value: claim }).owner).toBe("lane")
    expect(ownershipOf({ kind: "unreadable", reason: "x" }).owner).toBe("unknown")
    expect(ownershipOf({ kind: "missing" }).owner).toBe("none")
  })
})

describe("landing records on disk", () => {
  test("write, read, list by directory, remove", () => {
    const common = scratch()
    writeLanding(common, landing)
    writeLanding(common, { ...landing, receiptId: "2-def", worktree: "/wt/b" })
    expect(readLanding(common, "1-abc")).toEqual({ kind: "present", value: landing })
    const { records, unreadable } = listLandings(common)
    expect(unreadable).toBe(false)
    expect(landingsFor(records, "/wt/a").map((record) => record.receiptId)).toEqual(["1-abc"])
    removeLanding(common, "1-abc")
    expect(readLanding(common, "1-abc")).toEqual({ kind: "missing" })
  })

  test("a directory with no records lists nothing, and a corrupt record marks the listing unreadable", () => {
    const common = scratch()
    expect(listLandings(common)).toEqual({ records: [], unreadable: false })
    writeLanding(common, landing)
    writeFileSync(landingFile(common, "9-bad"), "garbage")
    const listed = listLandings(common)
    expect(listed.unreadable).toBe(true)
    expect(listed.records.map((record) => record.receiptId)).toEqual(["1-abc"])
  })
})
