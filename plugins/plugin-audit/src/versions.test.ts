import { describe, expect, test } from "bun:test"
import type { BumpRecord } from "../../dep-update/src/bump.ts"
import { plugin, repo } from "./test-fixtures.ts"
import { checkVersions, type Lookup } from "./versions.ts"

/** A lookup that answers from a table; unknown names come back as a network failure. */
function table(answers: Record<string, Partial<BumpRecord>>): Lookup {
  return async (name, installed) => ({
    ecosystem: "npm",
    name,
    installed,
    status: "UNRESOLVABLE",
    ...answers[name],
  })
}

describe("checkVersions", () => {
  test("a dependency one major behind is a warning naming the latest", async () => {
    const findings = await checkVersions(
      repo({ plugins: [plugin("a", { dependencies: { zod: "^3.0.0" } })] }),
      table({ zod: { class: "MAJOR-ADVISORY", latest: "4.1.0", status: "OK" } }),
    )
    expect(findings).toEqual([
      expect.objectContaining({ category: "versions", plugin: "a", severity: "warn", code: "outdated-major" }),
    ])
    expect(findings[0]?.message).toContain("zod ^3.0.0 -> 4.1.0")
  })

  test("minor and patch gaps are info", async () => {
    const findings = await checkVersions(
      repo({ plugins: [plugin("a", { devDependencies: { x: "1.0.0", y: "1.0.0" } })] }),
      table({
        x: { class: "MINOR-CHECK", latest: "1.2.0", status: "OK" },
        y: { class: "PATCH-SAFE", latest: "1.0.3", status: "OK" },
      }),
    )
    expect(findings.map((f) => [f.code, f.severity])).toEqual([
      ["outdated-minor", "info"],
      ["outdated-patch", "info"],
    ])
  })

  test("a current dependency has no finding", async () => {
    const findings = await checkVersions(
      repo({ plugins: [plugin("a", { dependencies: { x: "1.2.0" } })] }),
      table({ x: { class: "CURRENT", latest: "1.2.0", status: "CURRENT" } }),
    )
    expect(findings).toEqual([])
  })

  test("workspace ranges are never looked up", async () => {
    const seen: string[] = []
    await checkVersions(
      repo({ plugins: [plugin("a", { devDependencies: { "@srobroek/opencode-lib": "workspace:*" } })] }),
      async (name, installed) => {
        seen.push(name)
        return { ecosystem: "npm", name, installed, status: "CURRENT", class: "CURRENT" }
      },
    )
    expect(seen).toEqual([])
  })

  test("a root host module behind its latest is a warning", async () => {
    const findings = await checkVersions(
      repo({ root: { devDependencies: { "@opencode/plugin": "2.2.0" } } }),
      table({ "@opencode/plugin": { class: "MINOR-CHECK", latest: "2.3.0", status: "OK" } }),
    )
    expect(findings).toEqual([
      expect.objectContaining({ plugin: "(root)", severity: "warn", code: "host-behind" }),
    ])
  })

  test("a root host module one major behind is info asking for a manual decision", async () => {
    const findings = await checkVersions(
      repo({ root: { devDependencies: { "solid-js": "1.9.0" } } }),
      table({ "solid-js": { class: "MAJOR-ADVISORY", latest: "2.0.0", status: "OK" } }),
    )
    expect(findings).toEqual([expect.objectContaining({ severity: "info", code: "host-major" })])
    expect(findings[0]?.message).toContain("decide manually")
  })

  test("a host module that a plugin (not the root) depends on is judged like any other", async () => {
    const findings = await checkVersions(
      repo({ plugins: [plugin("a", { dependencies: { "solid-js": "1.9.0" } })] }),
      table({ "solid-js": { class: "MINOR-CHECK", latest: "1.9.5", status: "OK" } }),
    )
    expect(findings.map((f) => f.code)).toEqual(["outdated-minor"])
  })

  test("a registry failure is reported as not-queried info, not as a gap", async () => {
    const findings = await checkVersions(
      repo({ plugins: [plugin("a", { dependencies: { x: "1.0.0" } })] }),
      table({ x: { status: "UNRESOLVABLE", reason: "network error: offline" } }),
    )
    expect(findings).toEqual([expect.objectContaining({ severity: "info", code: "not-queried" })])
  })
})
