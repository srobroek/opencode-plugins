import { expect, test } from "bun:test"
import { decideMissingStaleJob, decideStaleReminder, forgeFromRemote, staleThresholdHours } from "./session-reminders.ts"

test("stale claims and closed beads require live branches; fresh and malformed claims are silent", () => {
  const now = Date.parse("2026-10-28T00:00:00Z")
  const bead = (id: string, status: string, started_at?: string) => ({ id, status, started_at, metadata: { branch: id } })
  const beads = [bead("old", "in_progress", "2026-10-20T00:00:00Z"), bead("fresh", "in_progress", "2026-10-27T00:00:00Z"), bead("gone", "closed"), bead("closed", "closed"), bead("bad", "in_progress", "bad")]
  const note = decideStaleReminder(beads, ["old", "fresh", "closed", "bad"], now, 48)
  expect(note).toContain("old")
  expect(note).toContain("closed")
  expect(note).not.toContain("fresh")
  expect(note).not.toContain("gone")
  expect(note).not.toContain("bad")
  expect(decideStaleReminder([], [], now, 48)).toBeUndefined()
  expect(decideStaleReminder(null, [], now, 48)).toBeUndefined()
})

test("reminders cap rows and accept only positive integer threshold overrides", () => {
  const beads = Array.from({ length: 8 }, (_, n) => ({ id: `b${n}`, status: "closed", metadata: { branch: `b${n}` } }))
  expect(decideStaleReminder(beads, beads.map((b) => b.id), 0, 48)?.split("\n").filter((row) => row.startsWith("-"))).toHaveLength(5)
  for (const value of [undefined, "0", "-1", "1.5", "foo"]) expect(staleThresholdHours(value)).toBe(48)
  expect(staleThresholdHours("72")).toBe(72)
})

test("known forges need the named CI job; unknown forges stay silent", () => {
  expect(forgeFromRemote("git@github.com:owner/repo.git")).toBe("github")
  expect(forgeFromRemote("https://gitlab.com/owner/repo")).toBe("gitlab")
  expect(forgeFromRemote("https://example.com/repo")).toBeUndefined()
  expect(decideMissingStaleJob("github", [])).toContain("stale-bead-branches")
  expect(decideMissingStaleJob("gitlab", ["jobs:\n  stale-bead-branches:\n    script: true"])).toBeUndefined()
  expect(decideMissingStaleJob(undefined, [])).toBeUndefined()
})
