import { describe, expect, test } from "bun:test"
import { checkDocs } from "./docs.ts"
import { plugin, repo } from "./test-fixtures.ts"

describe("checkDocs", () => {
  test("a pinned @opencode/plugin behind npm latest points at its release notes", () => {
    const findings = checkDocs(repo({ root: { devDependencies: { "@opencode/plugin": "2.3.0" } } }), "2.4.1")
    expect(findings).toEqual([expect.objectContaining({ plugin: "(root)", severity: "info", code: "opencode-api-release" })])
    expect(findings[0]?.message).toContain("release notes")
  })

  test("no hint when the pin is current or the registry was not consulted", () => {
    const root = { devDependencies: { "@opencode/plugin": "2.4.1" } }
    expect(checkDocs(repo({ root }), "2.4.1")).toEqual([])
    expect(checkDocs(repo({ root: { devDependencies: { "@opencode/plugin": "2.3.0" } } }), undefined)).toEqual([])
  })

  test("a biome $schema naming another version than installed is a warning", () => {
    const findings = checkDocs(
      repo({
        root: { devDependencies: { "@biomejs/biome": "2.6.8" } },
        biome: '{ "$schema": "https://biomejs.dev/schemas/2.6.2/schema.json" }',
      }),
    )
    expect(findings).toEqual([
      expect.objectContaining({ plugin: "(root)", severity: "warn", code: "schema-version", file: "biome.json" }),
    ])
  })

  test("a matching biome $schema is clean", () => {
    const findings = checkDocs(
      repo({
        root: { devDependencies: { "@biomejs/biome": "2.6.2" } },
        biome: '{ "$schema": "https://biomejs.dev/schemas/2.6.2/schema.json" }',
      }),
    )
    expect(findings).toEqual([])
  })

  test("a skill's biome $schema drift is attributed to its plugin", () => {
    const findings = checkDocs(
      repo({
        root: { devDependencies: { "@biomejs/biome": "2.6.8" } },
        plugins: [
          plugin("lang-x", {}, {
            skills: [{ path: "plugins/lang-x/skills/s/SKILL.md", text: "schema https://biomejs.dev/schemas/2.5.0/x.json" }],
          }),
        ],
      }),
    )
    expect(findings).toEqual([expect.objectContaining({ plugin: "lang-x", code: "schema-version" })])
  })

  test("a source importing the V1 API is an error; the V2 package is not", () => {
    const v1 = plugin("old", {}, { src: [{ path: "plugins/old/src/index.ts", text: 'import { Plugin } from "@opencode-ai/plugin"' }] })
    const v2 = plugin("new", {}, { src: [{ path: "plugins/new/src/index.ts", text: 'import { Plugin } from "@opencode/plugin"' }] })
    const findings = checkDocs(repo({ plugins: [v1, v2] }))
    expect(findings).toEqual([expect.objectContaining({ plugin: "old", severity: "error", code: "v1-api" })])
  })
})
