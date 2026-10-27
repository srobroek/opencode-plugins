import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseSkillFile } from "../plugins/lib/src/skill-files.ts"

const PLUGINS = path.join(import.meta.dir, "..", "plugins")
const ROUTER_ROW = /^\|.*\|\s*`([\w-]+)`\s*\|\s*$/

/** Every shipped skill whose body is a "situation → Load skill" table. */
function routers() {
  const out: { plugin: string; name: string; rows: string[]; text: string }[] = []
  for (const plugin of readdirSync(PLUGINS)) {
    const dir = path.join(PLUGINS, plugin, "skills")
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name, "SKILL.md")
      if (!existsSync(file)) continue
      const text = readFileSync(file, "utf8")
      if (!text.includes("| Load skill |")) continue
      const rows = text.split("\n").flatMap((line) => ROUTER_ROW.exec(line)?.[1] ?? [])
      out.push({ plugin, name, rows, text })
    }
  }
  return out
}

test("router skills exist", () => {
  expect(routers().length).toBeGreaterThan(0)
})

test("each router is listed and routes only to hidden skills of its own plugin", () => {
  for (const router of routers()) {
    const info = parseSkillFile(router.text)
    expect(info.autoinvoke).toBeUndefined()
    expect(info.description?.length ?? 0, `${router.name} description`).toBeLessThanOrEqual(120)
    expect(router.rows.length).toBeGreaterThan(1)
    for (const id of router.rows) {
      const file = path.join(PLUGINS, router.plugin, "skills", id, "SKILL.md")
      expect(existsSync(file), `${router.name} routes to missing ${router.plugin}/${id}`).toBe(true)
      expect(parseSkillFile(readFileSync(file, "utf8")).autoinvoke, `${router.name} member ${id} is still listed`).toBe(false)
    }
  }
})

test("a hidden member uses opencode metadata, so Claude Code and Codex can still invoke it", () => {
  for (const router of routers()) {
    for (const id of router.rows) {
      const text = readFileSync(path.join(PLUGINS, router.plugin, "skills", id, "SKILL.md"), "utf8")
      expect(text, `${id} sets disable-model-invocation`).not.toMatch(/^disable-model-invocation:/m)
    }
  }
})
