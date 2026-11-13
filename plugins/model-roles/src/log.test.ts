import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import { hostWarn } from "./log.ts"

describe("hostWarn", () => {
  test("warnings logged after setup's awaits still go to the logger of the fiber that ran setup", async () => {
    const lines: Array<{ level: string; message: unknown }> = []
    const capture = Logger.make(({ logLevel, message }) => {
      lines.push({ level: logLevel, message })
    })
    // Stands in for the host: setup runs in a fiber that carries the host's logger.
    const warn = await Effect.runPromise(Effect.sync(() => hostWarn("src")).pipe(Effect.provide(Logger.layer([capture]))))
    await new Promise((resolve) => setTimeout(resolve, 5))
    warn("tier cheap: a/b is not available now", { tier: "cheap" })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(lines).toEqual([{ level: "Warn", message: ["src: tier cheap: a/b is not available now", { tier: "cheap" }] }])
  })
})
