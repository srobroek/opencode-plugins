import { describe, expect, test } from "bun:test"
import { checkBumps, releaseTag } from "./bumps.ts"
import { plugin, repo } from "./test-fixtures.ts"

const config = { packages: { "plugins/demo": {}, "plugins/lib": {} } }

describe("checkBumps", () => {
  test("the release tag joins name and version with release-please's separator", () => {
    expect(releaseTag("worktrunk", "0.4.1")).toBe("worktrunk--v0.4.1")
  })

  test("package.json and the release manifest must agree", () => {
    const findings = checkBumps(
      repo({
        plugins: [plugin("demo", { version: "0.3.0" })],
        releaseConfig: config,
        releaseManifest: { "plugins/demo": "0.2.0" },
      }),
      new Map(),
    )
    expect(findings).toEqual([expect.objectContaining({ severity: "error", code: "version-mismatch" })])
  })

  test("a plugin missing from the manifest or the config is an error", () => {
    const missingManifest = checkBumps(
      repo({ plugins: [plugin("demo", { version: "0.1.0" })], releaseConfig: config, releaseManifest: {} }),
      new Map(),
    )
    expect(missingManifest.map((f) => f.code)).toEqual(["release-manifest"])
    const missingConfig = checkBumps(
      repo({
        plugins: [plugin("demo", { version: "0.1.0" })],
        releaseConfig: { packages: {} },
        releaseManifest: { "plugins/demo": "0.1.0" },
      }),
      new Map(),
    )
    expect(missingConfig.map((f) => f.code)).toEqual(["release-config"])
  })

  test("lib is not released, so it is exempt from the bookkeeping", () => {
    const findings = checkBumps(repo({ plugins: [plugin("lib", { version: "0.0.0" })], releaseConfig: { packages: {} }, releaseManifest: {} }), new Map())
    expect(findings).toEqual([])
  })

  test("commits since the tag are info; zero commits are silent", () => {
    const releaseManifest = { "plugins/demo": "0.2.0" }
    const base = { plugins: [plugin("demo", { version: "0.2.0" })], releaseConfig: config, releaseManifest }
    const ahead = checkBumps(repo(base), new Map([["demo", 3]]))
    expect(ahead).toEqual([expect.objectContaining({ severity: "info", code: "unreleased", message: expect.stringContaining("3 unreleased") })])
    expect(checkBumps(repo(base), new Map([["demo", 0]]))).toEqual([])
  })

  test("a missing release tag is info, and an uncounted plugin is skipped", () => {
    const releaseManifest = { "plugins/demo": "0.2.0" }
    const base = { plugins: [plugin("demo", { version: "0.2.0" })], releaseConfig: config, releaseManifest }
    expect(checkBumps(repo(base), new Map([["demo", null]]))).toEqual([
      expect.objectContaining({ severity: "info", code: "tag-missing", message: expect.stringContaining("demo--v0.2.0") }),
    ])
    expect(checkBumps(repo(base), new Map())).toEqual([])
  })
})
