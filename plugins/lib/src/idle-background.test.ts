import { describe, expect, test } from "bun:test"
import { childStillWorking, IdleReports } from "./idle-background.ts"

const shell = { kind: "shell", sessionID: "ses_c", shellID: "sh_1", command: "bun test" }

describe("childStillWorking", () => {
  test.each([
    ["a running background shell", { sessionID: "ses_c", background: [shell] }, true],
    ["no background work", { sessionID: "ses_c", background: [] }, false],
    ["a host that sends no background field", { sessionID: "ses_c" }, false],
    ["no report at all", undefined, false],
  ])("%s", (_name, idle, expected) => {
    expect(childStillWorking(idle)).toBe(expected)
  })
})

describe("IdleReports", () => {
  test("the last idle report of a session wins, and taking it forgets it", () => {
    const reports = new IdleReports()
    reports.record({ sessionID: "ses_c", background: [shell] })
    reports.record({ sessionID: "ses_c", background: [] })
    reports.record({ sessionID: "ses_d", background: [shell] })
    expect(reports.take("ses_c")).toBe(false)
    expect(reports.take("ses_d")).toBe(true)
    expect(reports.take("ses_d")).toBe(false)
  })
})
