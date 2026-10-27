import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseSkillFile } from "../plugins/lib/src/skill-files.ts"

const PLUGINS = path.join(import.meta.dir, "..", "plugins")
const ROUTER_ROW = /^\|.*\|\s*`([\w-]+)`\s*\|\s*$/

const langPlugins = () => readdirSync(PLUGINS).filter((name) => name.startsWith("lang-"))
const skillsOf = (plugin: string) =>
  readdirSync(path.join(PLUGINS, plugin, "skills")).filter((name) =>
    existsSync(path.join(PLUGINS, plugin, "skills", name, "SKILL.md")),
  )

test("every lang-<language> plugin is a srobroek.lang-<language> package", () => {
  expect(langPlugins().length).toBeGreaterThan(0)
  for (const plugin of langPlugins()) {
    const pkg = JSON.parse(readFileSync(path.join(PLUGINS, plugin, "package.json"), "utf8")) as { name: string }
    expect(pkg.name).toBe(`@srobroek/opencode-${plugin}`)
    expect(readFileSync(path.join(PLUGINS, plugin, "src", "index.ts"), "utf8")).toContain(`"srobroek.${plugin}"`)
  }
})

test("every skill in a lang-<language> plugin starts with lang-<language>", () => {
  for (const plugin of langPlugins()) {
    for (const name of skillsOf(plugin)) {
      expect({ plugin, name, prefixed: name === plugin || name.startsWith(`${plugin}-`) }).toEqual({
        plugin,
        name,
        prefixed: true,
      })
      const info = parseSkillFile(readFileSync(path.join(PLUGINS, plugin, "skills", name, "SKILL.md"), "utf8"))
      expect(info.name).toBe(name)
    }
  }
})

test("a language with several skills lists only its lang-<language> router, which routes to every member", () => {
  for (const plugin of langPlugins()) {
    const members = skillsOf(plugin).filter((name) => name !== plugin)
    if (members.length < 2) continue
    const router = readFileSync(path.join(PLUGINS, plugin, "skills", plugin, "SKILL.md"), "utf8")
    const rows = router.split("\n").flatMap((line) => ROUTER_ROW.exec(line)?.[1] ?? [])
    expect({ plugin, rows: [...rows].sort() }).toEqual({ plugin, rows: [...members].sort() })
  }
})
