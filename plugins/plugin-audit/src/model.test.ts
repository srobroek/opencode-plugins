import { describe, expect, test } from "bun:test"
import { isHostModule, plainVersion } from "./model.ts"

describe("plainVersion", () => {
  test("reads an exact version and a caret, tilde or equals range", () => {
    expect(plainVersion("1.2.3")).toBe("1.2.3")
    expect(plainVersion("^2.1.4")).toBe("2.1.4")
    expect(plainVersion("~0.9.0")).toBe("0.9.0")
    expect(plainVersion("=3.0.0-rc.1")).toBe("3.0.0-rc.1")
  })

  test("returns undefined for workspace, path, git and compound specs", () => {
    expect(plainVersion("workspace:*")).toBeUndefined()
    expect(plainVersion("file:../x")).toBeUndefined()
    expect(plainVersion("github:a/b")).toBeUndefined()
    expect(plainVersion(">=1.0.0 <2.0.0")).toBeUndefined()
    expect(plainVersion("latest")).toBeUndefined()
    expect(plainVersion(3)).toBeUndefined()
  })
})

describe("isHostModule", () => {
  test("matches the pinned host modules and their subpaths", () => {
    expect(isHostModule("@opencode/plugin")).toBe(true)
    expect(isHostModule("@opentui/core")).toBe(true)
    expect(isHostModule("solid-js")).toBe(true)
  })

  test("does not match other packages, including effect which is not pinned", () => {
    expect(isHostModule("@opencode/plugin-extra")).toBe(false)
    expect(isHostModule("effect")).toBe(false)
    expect(isHostModule("smol-toml")).toBe(false)
  })
})
