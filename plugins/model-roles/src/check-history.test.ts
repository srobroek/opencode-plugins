import { describe, expect, test } from "bun:test"
import { formatHealthHistory, HEALTH_HISTORY_LIMIT, type HealthEvent, recordCooldown, recordRecovery } from "./check.ts"

const at = (time: string) => Date.parse(`2026-11-15T${time}Z`)
const model = (when: string, cooldownMs = 60_000, subject = "p/a"): Omit<HealthEvent, "recoveredAt"> => ({
  at: at(when),
  subject,
  scope: "model",
  kind: "rate-limit",
  cooldownMs,
})

describe("recordCooldown", () => {
  test("keeps the newest events, bounded", () => {
    let history: HealthEvent[] = []
    for (let i = 0; i < HEALTH_HISTORY_LIMIT + 3; i++) history = recordCooldown(history, model("10:00:00", 1, `p/m${i}`))
    expect(history).toHaveLength(HEALTH_HISTORY_LIMIT)
    expect(history[0]?.subject).toBe(`p/m${HEALTH_HISTORY_LIMIT + 2}`)
    expect(history.at(-1)?.subject).toBe("p/m3")
  })

  test("a cooldown that extends an open one updates it", () => {
    let history = recordCooldown([], model("10:00:00", 60_000))
    history = recordCooldown(history, model("10:00:30", 120_000))
    expect(history).toHaveLength(1)
    expect(history[0]?.cooldownMs).toBe(150_000)
  })

  test("a cooldown after the last one ended is a new event", () => {
    let history = recordCooldown([], model("10:00:00", 60_000))
    history = recordCooldown(history, model("10:05:00", 120_000))
    expect(history.map((e) => e.cooldownMs)).toEqual([120_000, 60_000])
  })
})

describe("recordRecovery", () => {
  test("ends the open cooldowns of the provider only", () => {
    let history = recordCooldown([], model("10:00:00", 600_000, "p/a"))
    history = recordCooldown(history, model("10:00:00", 600_000, "q/b"))
    history = recordCooldown(history, { ...model("10:00:00", 600_000, "p/*"), scope: "provider" })
    history = recordRecovery(history, "p", at("10:02:00"))
    expect(history.map((e) => [e.subject, e.recoveredAt])).toEqual([
      ["p/*", at("10:02:00")],
      ["q/b", undefined],
      ["p/a", at("10:02:00")],
    ])
  })

  test("a success from before the cooldown started does not recover it", () => {
    const history = recordCooldown([], model("10:00:00", 600_000))
    expect(recordRecovery(history, "p", at("09:59:59"))[0]?.recoveredAt).toBeUndefined()
    expect(recordRecovery(history, "p", at("10:00:00"))[0]?.recoveredAt).toBeUndefined()
    expect(recordRecovery(history, "p", at("10:00:01"))[0]?.recoveredAt).toBe(at("10:00:01"))
  })

  test("does not move a recovery already recorded or a cooldown that ended earlier", () => {
    let history = recordCooldown([], model("10:00:00", 60_000))
    history = recordRecovery(history, "p", at("10:05:00"))
    expect(history[0]?.recoveredAt).toBeUndefined()
    const open = recordCooldown([], model("10:00:00", 600_000))
    const once = recordRecovery(open, "p", at("10:01:00"))
    expect(recordRecovery(once, "p", at("10:02:00"))[0]?.recoveredAt).toBe(at("10:01:00"))
  })
})

describe("formatHealthHistory", () => {
  test("shows nothing when empty", () => {
    expect(formatHealthHistory([], Date.now())).toEqual([])
  })

  test("lists time, subject, class, cooldown and recovery, newest first", () => {
    let history = recordCooldown([], model("10:00:00", 60_000))
    history = recordCooldown(history, { ...model("10:30:00", 6 * 3_600_000, "p/*"), scope: "provider", kind: "quota" })
    history = recordCooldown(history, model("10:40:00", 120_000, "q/b"))
    history = recordRecovery(history, "q", at("10:41:00"))
    expect(formatHealthHistory(history, at("10:45:00"))).toEqual([
      "",
      "Recent health (newest first):",
      "  - 10:40:00 model q/b: rate-limit, cooldown 2 min, recovered 10:41:00",
      "  - 10:30:00 provider p: quota, cooldown 6 h, still out",
      "  - 10:00:00 model p/a: rate-limit, cooldown 1 min, recovered 10:01:00",
    ])
  })
})
