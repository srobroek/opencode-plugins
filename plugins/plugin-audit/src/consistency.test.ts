import { describe, expect, test } from "bun:test"
import { checkConsistency } from "./consistency.ts"
import { plugin, repo } from "./test-fixtures.ts"

describe("checkConsistency", () => {
  test("a plugin without an opencode-plugins scope is an error", () => {
    const findings = checkConsistency(repo({ plugins: [plugin("demo", {})] }))
    expect(findings).toEqual([expect.objectContaining({ plugin: "demo", severity: "error", code: "scope-missing" })])
  })

  test("a valid scope is clean", () => {
    expect(checkConsistency(repo({ plugins: [plugin("demo", { "opencode-plugins": { scope: "project" } })] }))).toEqual([])
  })

  test("an internal package is not released, so it needs no changelog", () => {
    const lib = plugin("lib", { "opencode-plugins": { scope: "internal" } }, { hasChangelog: false })
    expect(checkConsistency(repo({ plugins: [lib] }))).toEqual([])
  })

  test("missing README, CHANGELOG or tests are each a warning", () => {
    const findings = checkConsistency(
      repo({
        plugins: [plugin("demo", { "opencode-plugins": { scope: "global" } }, { hasReadme: false, hasChangelog: false, tests: [] })],
      }),
    )
    expect(findings.map((f) => f.code).sort()).toEqual(["changelog-missing", "readme-missing", "tests-missing"])
    expect(findings.every((f) => f.severity === "warn")).toBe(true)
  })

  test("differing @opencode/plugin peer ranges are one warning listing the variants", () => {
    const peer = (range: string) => ({ "opencode-plugins": { scope: "global" }, peerDependencies: { "@opencode/plugin": range } })
    const findings = checkConsistency(repo({ plugins: [plugin("a", peer("^2.1.4")), plugin("b", peer("^2.3.0"))] }))
    const peers = findings.filter((f) => f.code === "peer-range")
    expect(peers).toEqual([expect.objectContaining({ severity: "warn" })])
    expect(peers[0]?.message).toContain("^2.1.4 (a)")
    expect(peers[0]?.message).toContain("^2.3.0 (b)")
  })

  test("a devDependency pinned differently across plugins or against the root is a warning", () => {
    const dev = (version: string) => ({ "opencode-plugins": { scope: "global" }, devDependencies: { "smol-toml": version } })
    const findings = checkConsistency(
      repo({ root: { devDependencies: { "smol-toml": "1.9.1" } }, plugins: [plugin("a", dev("1.9.1")), plugin("b", dev("1.8.0"))] }),
    )
    expect(findings).toEqual([expect.objectContaining({ code: "dev-dependency", severity: "warn" })])
  })

  test("workspace devDependencies are not compared", () => {
    const dev = { "opencode-plugins": { scope: "global" }, devDependencies: { "@srobroek/opencode-lib": "workspace:*" } }
    expect(checkConsistency(repo({ plugins: [plugin("a", dev), plugin("b", dev)] }))).toEqual([])
  })
})
