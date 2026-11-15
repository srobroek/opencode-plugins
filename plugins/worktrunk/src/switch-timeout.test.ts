import { describe, expect, test } from "bun:test"
import { SWITCH_TIMEOUT_MS, withSwitchTimeout } from "./switch-timeout.ts"

const switchCommand = "wt switch -y --create --no-cd --base abc --format json feat"

describe("withSwitchTimeout", () => {
  test("adds the long timeout to a wt switch call with none", () => {
    expect(withSwitchTimeout("shell", { command: switchCommand, workdir: "/r" })).toEqual({
      command: switchCommand,
      workdir: "/r",
      timeout: SWITCH_TIMEOUT_MS,
    })
  })
  test("raises a shorter timeout, also behind -C and in a chain", () => {
    expect(withSwitchTimeout("shell", { command: "wt -C /r switch -y x", timeout: 120000 })?.timeout).toBe(SWITCH_TIMEOUT_MS)
    expect(withSwitchTimeout("shell", { command: "mkdir -p d && wt switch -y x" })?.timeout).toBe(SWITCH_TIMEOUT_MS)
    expect(withSwitchTimeout("bash", "wt switch -y x")).toBeUndefined()
    expect(withSwitchTimeout("bash", JSON.stringify({ command: "wt switch -y x" }))).toBeUndefined()
  })
  test.each([
    ["a longer timeout", { command: switchCommand, timeout: 900000 }],
    ["no timeout (0)", { command: switchCommand, timeout: 0 }],
    ["a background call", { command: switchCommand, background: true }],
    ["another wt subcommand", { command: "wt list --format json" }],
    ["switch help", { command: "wt switch --help" }],
    ["git switch", { command: "git switch main" }],
    ["text that only mentions it", { command: "echo wt switch" }],
  ])("leaves %s alone", (_name, input) => {
    expect(withSwitchTimeout("shell", input)).toBeUndefined()
  })
  test("ignores other tools", () => {
    expect(withSwitchTimeout("read", { command: switchCommand })).toBeUndefined()
  })
})
