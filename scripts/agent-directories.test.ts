import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { shippedAgents } from "./check-agent-roles.ts"

type Rule = { action: string; resource: string; effect: string }

/** Folders OpenCode itself fills for subagents: worktree lanes, and repomix packs in the temp folder (Linux, macOS). */
const OPENCODE_FOLDERS = [
  "~/.local/share/opencode/worktree/*",
  "/tmp/opencode/*",
  "/private/var/folders/*/T/opencode/*",
  "/var/folders/*/T/opencode/*",
]

function rules(file: string): Rule[] {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(file, "utf8"))
  const data = Bun.YAML.parse(match?.[1] ?? "") as { permissions?: Rule[] } | null
  return Array.isArray(data?.permissions) ? data.permissions : []
}

describe("shipped agents with an external_directory ask rule", () => {
  const root = path.resolve(import.meta.dir, "..", "plugins")
  const asking = shippedAgents(root).filter((file) =>
    rules(file).some((rule) => rule.action === "external_directory" && rule.resource === "*" && rule.effect === "ask"),
  )

  test("the set is not empty", () => {
    expect(asking.length).toBeGreaterThan(0)
  })

  for (const file of asking)
    test(`${path.relative(root, file)} allows the OpenCode folders after the ask`, () => {
      const list = rules(file)
      const ask = list.findIndex((rule) => rule.action === "external_directory" && rule.resource === "*" && rule.effect === "ask")
      for (const folder of OPENCODE_FOLDERS) {
        const allow = list.findLastIndex(
          (rule) => rule.action === "external_directory" && rule.resource === folder && rule.effect === "allow",
        )
        expect(allow).toBeGreaterThan(ask)
      }
    })
})
