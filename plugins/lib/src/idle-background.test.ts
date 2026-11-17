import { describe, expect, test } from "bun:test"
import { childStillWorking, IdleReports, MAX_IDLE_REPORTS } from "./idle-background.ts"

const shell = (owner: string) => ({ kind: "shell", sessionID: owner, shellID: "sh_1", command: "bun test" })

describe("childStillWorking", () => {
  test.each([
    ["a background shell it owns", { sessionID: "ses_c", background: [shell("ses_c")] }, true],
    ["a background subagent it started", { sessionID: "ses_c", background: [{ kind: "subagent", sessionID: "ses_c", childSessionID: "ses_g" }] }, true],
    ["only a descendant's shell, which wakes the descendant instead", { sessionID: "ses_c", background: [shell("ses_g")] }, false],
    ["no background work", { sessionID: "ses_c", background: [] }, false],
    ["a host that sends no background field", { sessionID: "ses_c" }, false],
    ["no report at all", undefined, false],
  ])("%s", (_name, idle, expected) => {
    expect(childStillWorking(idle)).toBe(expected)
  })
})

describe("IdleReports", () => {
  const at = (times: number[]) => {
    const clock = [...times]
    return new IdleReports(() => clock.shift() ?? Number.NaN)
  }

  test("each execution end reads the reports made before it, even when the ends are read late", () => {
    // Idle at 100 with work, end at 200; idle at 300 without work, end at 400; both ends read after both idles.
    const reports = at([100, 300])
    reports.record({ sessionID: "ses_c", background: [shell("ses_c")] })
    reports.record({ sessionID: "ses_c", background: [] })
    expect(reports.take("ses_c", 200)).toBe("working")
    expect(reports.take("ses_c", 400)).toBe("done")
  })

  test("the last report before an end wins, and an end with no report of its own reads none", () => {
    const reports = at([100, 150])
    reports.record({ sessionID: "ses_c", background: [] })
    reports.record({ sessionID: "ses_c", background: [shell("ses_c")] })
    expect(reports.take("ses_c", 200)).toBe("working")
    expect(reports.take("ses_c", 300)).toBe("done")
  })

  test("an end without a time reads every report so far", () => {
    const reports = at([100])
    reports.record({ sessionID: "ses_c", background: [shell("ses_c")] })
    expect(reports.take("ses_c")).toBe("working")
    expect(reports.take("ses_c")).toBe("done")
  })

  test("past MAX_IDLE_REPORTS, an end whose report was dropped reads unknown; the next end reads its own", () => {
    // Reports at 1..17, none with work; the one at 1 is dropped. Ends at 1 and 2.
    const reports = at(Array.from({ length: MAX_IDLE_REPORTS + 1 }, (_, i) => i + 1))
    for (let i = 0; i <= MAX_IDLE_REPORTS; i++) reports.record({ sessionID: "ses_c", background: [] })
    expect(reports.take("ses_c", 1)).toBe("unknown")
    expect(reports.take("ses_c", 2)).toBe("done")
  })

  test("an end after the dropped reports that reads a kept one is not unknown", () => {
    // Reports at 1..17; the one at 1 is dropped. One end at 17 reads the kept report at 17.
    const reports = at(Array.from({ length: MAX_IDLE_REPORTS + 1 }, (_, i) => i + 1))
    for (let i = 0; i <= MAX_IDLE_REPORTS; i++) reports.record({ sessionID: "ses_c", background: [] })
    expect(reports.take("ses_c", 17)).toBe("done")
  })

  test("forgetting a session drops its reports", () => {
    const reports = at([100])
    reports.record({ sessionID: "ses_c", background: [shell("ses_c")] })
    reports.forget("ses_c")
    expect(reports.take("ses_c", 200)).toBe("done")
  })
})
