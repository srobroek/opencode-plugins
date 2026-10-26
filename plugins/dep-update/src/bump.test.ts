import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  classify,
  compareVersions,
  isPrerelease,
  normalizeVersion,
  parseRequirement,
  parseVersion,
  pickStable,
  queryRegistry,
  researchProject,
} from "./bump.ts"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "dep-scan-"))
}

describe("unit: versions", () => {
  test("normalizeVersion", () => {
    expect(normalizeVersion("1.2.3")).toEqual([1, 2, 3])
    expect(normalizeVersion("v1.2.3")).toEqual([1, 2, 3])
    expect(normalizeVersion("1.2")).toBeNull()
    expect(normalizeVersion("1.2", "pypi")).toEqual([1, 2, 0])
    expect(normalizeVersion("==1.2", "pypi")).toEqual([1, 2, 0])
    expect(normalizeVersion("not-a-version")).toBeNull()
  })

  test("parseVersion names every part of an exact version", () => {
    expect(parseVersion("v1.2.3-rc.1+build.5")).toEqual({ release: [1, 2, 3], parts: { pre: "rc.1" } })
    expect(parseVersion("1.0rc2.post3.dev4", "pypi")).toEqual({
      release: [1, 0, 0],
      parts: { phase: "rc", phaseNumber: "2", post: "post", postNumber: "3", dev: "dev", devNumber: "4" },
    })
    expect(parseVersion("2.1", "pypi")).toEqual({ release: [2, 1, 0], parts: {} })
    expect(parseVersion("1.x")).toBeNull()
    expect(parseVersion(42)).toBeNull()
  })

  test("classify", () => {
    expect(classify("1.2.3", "1.2.4")).toBe("PATCH-SAFE")
    expect(classify("1.2.3", "1.3.0")).toBe("MINOR-CHECK")
    expect(classify("1.2.3", "2.0.0")).toBe("MAJOR-ADVISORY")
    expect(classify("1.2.3", "1.2.3")).toBe("CURRENT")
    expect(classify("not-a-version", "1.2.3")).toBe("UNRESOLVABLE")
  })

  test("same-triple pre- and post-releases are upgrades, not CURRENT", () => {
    expect(classify("1.0.0-rc.1", "1.0.0")).toBe("PATCH-SAFE")
    expect(classify("1.0.0-alpha.2", "1.0.0-alpha.10")).toBe("PATCH-SAFE")
    expect(classify("1.0.0-alpha", "1.0.0-alpha.1")).toBe("PATCH-SAFE")
    expect(classify("1.0.0-beta", "1.0.0-alpha.1")).toBe("CURRENT")
    expect(classify("1.0.0", "1.0.0-rc.1")).toBe("CURRENT")
    expect(classify("1.0.0", "1.0.0.post1", "pypi")).toBe("PATCH-SAFE")
    expect(classify("1.0rc1", "1.0", "pypi")).toBe("PATCH-SAFE")
    expect(classify("1.0a1", "1.0b1", "pypi")).toBe("PATCH-SAFE")
    expect(classify("1.0.dev1", "1.0a1", "pypi")).toBe("PATCH-SAFE")
    expect(classify("1.0a1.dev1", "1.0a1", "pypi")).toBe("PATCH-SAFE")
    expect(classify("1.0.post1", "1.0", "pypi")).toBe("CURRENT")
    expect(classify("1.0.post1.dev1", "1.0.post1", "pypi")).toBe("PATCH-SAFE")
    expect(compareVersions("1.0", "1.0.post1.dev1", "pypi")).toBe(-1)
    expect(compareVersions("1.0+local", "1.0", "pypi")).toBe(0)
    expect(pickStable("2.0rc1", "1.0", ["1.1", "1.1.post1", "2.0rc1"], "pypi")).toBe("1.1.post1")
  })

  test.each([
    "1.x",
    "1.X",
    "1.*",
    "1.2.x",
    "1",
    "1.2",
    "1.2.3.4",
    "1.2.3 || 2.0.0",
    "1.2.3 <2.0.0",
    "1.2.3, <2.0.0",
    "1.2.3 - 2.0.0",
    "1.2.3garbage",
    "1.2.3\n",
    "==1.2.3",
    "01.2.3",
    "1.2.3-01",
    "1.2.3-",
    "1.2.3+",
  ])("rejects the complete unresolved Node input %j on either side", (version) => {
    expect(normalizeVersion(version)).toBeNull()
    expect(classify(version, "2.0.0")).toBe("UNRESOLVABLE")
    expect(classify("1.0.0", version)).toBe("UNRESOLVABLE")
  })

  test("exact prereleases and build metadata remain parseable, not ranges", () => {
    expect(normalizeVersion("1.2.3-beta.1+build.5")).toEqual([1, 2, 3])
    expect(normalizeVersion("1.2.3-2.0.0")).toEqual([1, 2, 3])
    expect(normalizeVersion("==1.2rc1", "pypi")).toEqual([1, 2, 0])
    expect(isPrerelease("1.2.3-preview")).toBe(true)
    expect(isPrerelease("1.2.3+beta.1")).toBe(false)
    expect(isPrerelease("1.2rc1", "pypi")).toBe(true)
    expect(isPrerelease("1.2.dev1", "pypi")).toBe(true)
    expect(isPrerelease("1.2.post1", "pypi")).toBe(false)
    expect(pickStable("2.0.0-preview", "1.0.0", ["2.x", "1.1.0", "2.0.0-preview"])).toBe("1.1.0")
    expect(pickStable("2.0.0-preview", "1.0.0-beta.1", ["1.1.0", "2.0.0-preview"])).toBe("2.0.0-preview")
    expect(pickStable("2.0rc1", "1.0", ["2.*", "1.1", "2.0rc1"], "pypi")).toBe("1.1")
  })

  test("parseRequirement extras", () => {
    expect(parseRequirement('requests[socks]>=2.31.0; python_version < "3.12"')).toEqual(["requests", ">=2.31.0"])
  })
})

describe("unit: research", () => {
  test("research queries declared rows only, never transitive lock entries", async () => {
    const dir = tmp()
    const fixtures = tmp()
    try {
      writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "app"\ndependencies = ["httpx==0.27.0"]\n')
      writeFileSync(
        join(dir, "uv.lock"),
        '[[package]]\nname = "httpx"\nversion = "0.27.0"\n[[package]]\nname = "anyio"\nversion = "4.0.0"\n',
      )
      for (const name of ["httpx", "anyio"]) {
        writeFileSync(
          join(fixtures, `pypi_${name}.json`),
          JSON.stringify({ info: { version: "9.0.0" }, releases: { "9.0.0": [{ yanked: false }] } }),
        )
      }
      const result = await researchProject(dir, fixtures)
      expect(result.records.map((r) => r.name)).toEqual(["httpx"])
      expect(result.stderr).toContain("transitive (not queried): 1")
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(fixtures, { recursive: true, force: true })
    }
  })
})

describe("unit: fixture registry", () => {
  test("pypi patch-safe via fixture", async () => {
    const fixtures = tmp()
    writeFileSync(
      join(fixtures, "pypi_requests.json"),
      JSON.stringify({ info: { version: "2.32.3" }, releases: { "2.32.3": [{ yanked: false }] } }),
    )
    const record = await queryRegistry("pypi", "requests", "2.32.0", fixtures)
    expect(record.status).toBe("OK")
    expect(record.class).toBe("PATCH-SAFE")
    expect(record.latest).toBe("2.32.3")
  })

  test("a same-triple post-release from the registry is recommended, not dropped as CURRENT", async () => {
    const fixtures = tmp()
    try {
      writeFileSync(
        join(fixtures, "pypi_example.json"),
        JSON.stringify({ info: { version: "1.0.0.post1" }, releases: { "1.0.0.post1": [{ yanked: false }] } }),
      )
      const record = await queryRegistry("pypi", "example", "1.0.0", fixtures)
      expect(record.status).toBe("OK")
      expect(record.class).toBe("PATCH-SAFE")
    } finally {
      rmSync(fixtures, { recursive: true, force: true })
    }
  })

  test.each([
    ["pypi", "==1.0.0", "MAJOR-ADVISORY"],
    ["npm", "=1.0.0", "MAJOR-ADVISORY"],
    ["pypi", "==2.0.0", "CURRENT"],
    ["pypi", "=1.0.0", "MAJOR-ADVISORY"],
    ["pypi", "==1.0", "MAJOR-ADVISORY"],
    ["pypi", "1", "MAJOR-ADVISORY"],
    ["pypi", "==1.0rc1", "MAJOR-ADVISORY"],
    ["npm", "==1.0.0", "UNRESOLVABLE"],
    ["npm", "1.0rc1", "UNRESOLVABLE"],
    ["pypi", "1.x", "UNRESOLVABLE"],
    ["pypi", "1.0 - 2.0", "UNRESOLVABLE"],
    ["pypi", "==1.0,!=1.0.1", "UNRESOLVABLE"],
    ["pypi", "1.0garbage", "UNRESOLVABLE"],
    ["pypi", "==1.*", "UNRESOLVABLE"],
    ["pypi", ">=1.0.0", "UNRESOLVABLE"],
  ])("%s classifies %s without treating ranges as resolved versions", async (ecosystem, installed, expected) => {
    const fixtures = tmp()
    try {
      const response =
        ecosystem === "pypi"
          ? { info: { version: "2.0.0" }, releases: { "2.0.0": [{ yanked: false }] } }
          : { "dist-tags": { latest: "2.0.0" }, versions: { "2.0.0": {} } }
      writeFileSync(join(fixtures, `${ecosystem}_example.json`), JSON.stringify(response))
      const record = await queryRegistry(ecosystem, "example", installed, fixtures)
      expect(record.class).toBe(expected)
      expect(record.status).toBe(expected === "UNRESOLVABLE" || expected === "CURRENT" ? expected : "OK")
    } finally {
      rmSync(fixtures, { recursive: true, force: true })
    }
  })

  test.each(["npm", "node"])("%s unresolved declarations cannot become recommended OK upgrades", async (ecosystem) => {
    const fixtures = tmp()
    try {
      writeFileSync(
        join(fixtures, `${ecosystem}_example.json`),
        JSON.stringify({
          "dist-tags": { latest: "1.1.0" },
          versions: { "1.1.0": {} },
        }),
      )
      for (const installed of ["1.x", "1.*", "1", "1.0", "1.0.0 || 2.0.0", "1.0.0 - 2.0.0"]) {
        const record = await queryRegistry(ecosystem, "example", installed, fixtures)
        expect(record.status).toBe("UNRESOLVABLE")
        expect(record.class).toBe("UNRESOLVABLE")
        expect(record.reason).toContain("Exact versions are required")
      }
      const exact = await queryRegistry(ecosystem, "example", "1.0.0", fixtures)
      expect(exact.status).toBe("OK")
      expect(exact.class).toBe("MINOR-CHECK")
    } finally {
      rmSync(fixtures, { recursive: true, force: true })
    }
  })

  test("yanked is disconfirmed", async () => {
    const fixtures = tmp()
    writeFileSync(
      join(fixtures, "pypi_requests.json"),
      JSON.stringify({ info: { version: "2.32.3" }, releases: { "2.32.3": [{ yanked: true }] } }),
    )
    const record = await queryRegistry("pypi", "requests", "2.31.0", fixtures)
    expect(record.status).toBe("DISCONFIRMED")
  })

  test("missing fixture is unresolvable", async () => {
    const fixtures = tmp()
    const record = await queryRegistry("pypi", "absent", "1.0.0", fixtures)
    expect(record.status).toBe("UNRESOLVABLE")
    expect(record.reason ?? "").toContain("network error")
  })
})
