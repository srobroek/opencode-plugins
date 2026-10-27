import { expect, test } from "bun:test"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

const PLUGINS = path.join(import.meta.dir, "..", "plugins")

/** The id prefixes of a plugin's skills, when they are not the plugin name. */
const FAMILIES: Readonly<Record<string, readonly string[]>> = {
  "agent-reviewer": ["review"],
  journeys: ["journey", "journeys"],
}

/**
 * Skills outside their plugin's family, with the reason. An agent allowlist names each one
 * by id next to the family pattern, so keep this list short and add no new entries.
 */
const EXCEPTIONS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  debate: {
    grilling: "debate and to-questionnaire name it by id",
    "to-questionnaire": "grilling hands off to it by id",
  },
  design: {
    "accessibility-audit": "design-guide routes to it by id",
    "motion-design": "design-guide routes to it by id",
    "ui-microcopy": "design-guide routes to it by id",
    "ui-review": "design-guide and the design agents load it by id",
    wireloom: "named after the upstream Wireloom tool; design-guide routes to it",
  },
  project: { "license-picker": "users invoke it by name; docs/adoption.md lists it" },
  quality: { "prototype-logic": "quality-code-design and design-prototype route to it by id" },
  session: { "resume-session": "users invoke it by name" },
  toolchain: {
    "backend-background-jobs": "a listed skill under its original id; coding agents allow it by id",
    "ci-github-actions": "toolchain-guide routes to it by id",
    "coexistence-worktree": "a listed skill under its original id; coding agents allow it by id",
    "infrastructure-tfstate-guard": "a listed skill under its original id; coding agents allow it by id",
    "ops-no-global-cargo-target": "toolchain-guide routes to it by id",
    "ops-toolchain-cache-policy": "toolchain-guide routes to it by id",
    "shell-language": "a listed skill under its original id; coding agents allow it by id",
    "terraform-language": "a listed skill under its original id; coding agents allow it by id",
  },
}

const skillsOf = (plugin: string) => {
  const dir = path.join(PLUGINS, plugin, "skills")
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((name) => existsSync(path.join(dir, name, "SKILL.md")))
}

const inFamily = (id: string, families: readonly string[]) =>
  families.some((family) => id === family || id.startsWith(`${family}-`))

test("every skill id starts with its plugin's family prefix, so a family pattern covers new skills", () => {
  const plugins = readdirSync(PLUGINS).filter((plugin) => skillsOf(plugin).length > 0)
  expect(plugins.length).toBeGreaterThan(10)
  for (const plugin of plugins) {
    const families = FAMILIES[plugin] ?? [plugin]
    for (const id of skillsOf(plugin)) {
      const covered = inFamily(id, families) || EXCEPTIONS[plugin]?.[id] !== undefined
      expect({ plugin, id, covered }).toEqual({ plugin, id, covered: true })
    }
  }
})

test("every exception still ships and still sits outside its family", () => {
  for (const [plugin, ids] of Object.entries(EXCEPTIONS)) {
    for (const id of Object.keys(ids)) {
      expect({ plugin, id, ships: skillsOf(plugin).includes(id) }).toEqual({ plugin, id, ships: true })
      expect({ plugin, id, outside: !inFamily(id, FAMILIES[plugin] ?? [plugin]) }).toEqual({ plugin, id, outside: true })
    }
  }
})

test("family overrides name plugins that ship skills", () => {
  for (const plugin of Object.keys(FAMILIES)) expect(skillsOf(plugin).length).toBeGreaterThan(0)
})
