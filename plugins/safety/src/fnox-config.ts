/**
 * The type of each fnox provider, read from every fnox config file that could apply to a directory:
 * `fnox.toml`, `.fnox.toml`, their `.local` and profile variants (`fnox.<profile>.toml`) in the
 * directory and each parent up to the filesystem root (a `root = true` does not end the search, and no
 * profile is skipped), then the global `~/.config/fnox/config.toml`. Reading more than fnox does is
 * deliberate: the guard cannot know which profile or file wins, so a provider is a value store only when
 * every definition of it says so. A provider's name says nothing about what it stores; its `type` does.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "smol-toml"
import { type ProviderTypes, VALUE_STORE_TYPES } from "./op-guard.ts"

const CONFIG_NAME = /^\.?fnox(?:\.[^/]+)?\.toml$/

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Every `[providers.<name>]` and `[profiles.<profile>.providers.<name>]` entry in `config`, as name and type. */
function declared(config: Record<string, unknown>): [string, unknown][] {
  const tables: unknown[] = [config.providers]
  if (isTable(config.profiles)) for (const profile of Object.values(config.profiles)) if (isTable(profile)) tables.push(profile.providers)
  return tables.filter(isTable).flatMap((table) => Object.entries(table).map(([name, entry]): [string, unknown] => [name, isTable(entry) ? entry.type : undefined]))
}

/** The fnox config files that apply to `cwd`, nearest first, global last. Throws when one does not parse. */
function configs(cwd: string, home: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  let dir = cwd
  for (;;) {
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((name) => CONFIG_NAME.test(name)).sort()
    } catch {
      // An unreadable directory holds no config we can trust; the walk continues.
    }
    for (const name of names) {
      const config = parse(readFileSync(join(dir, name), "utf8"))
      // An import pulls in files this reader does not follow.
      if ("import" in config) throw new Error("fnox config with import")
      found.push(config)
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const global = join(home, ".config", "fnox", "config.toml")
  if (existsSync(global)) found.push(parse(readFileSync(global, "utf8")))
  return found
}

/**
 * Provider types by name for the configs that apply to `cwd`. When every definition of a name is a
 * value-store type the answer is one of them; if any definition is another type the answer is that
 * type. A missing provider, a definition without a type or an unreadable config give `undefined`,
 * which the op-guard treats as no value store.
 */
export function readProviderTypes(cwd: string, home: string = homedir()): ProviderTypes {
  let types: Map<string, unknown[]>
  try {
    types = new Map()
    for (const config of configs(cwd, home))
      for (const [name, type] of declared(config)) types.set(name, [...(types.get(name) ?? []), type])
  } catch {
    return () => undefined
  }
  return (name) => {
    const all = types.get(name)
    if (all === undefined || all.length === 0 || all.some((type) => typeof type !== "string")) return undefined
    const names = all as string[]
    return names.find((type) => !VALUE_STORE_TYPES.has(type)) ?? names[0]
  }
}
