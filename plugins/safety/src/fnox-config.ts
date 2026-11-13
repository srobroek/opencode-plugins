/**
 * The type of each fnox provider, read from the fnox config files that apply to a directory. fnox
 * loads `fnox.toml`, `.fnox.toml`, their `.local` and profile variants (`fnox.<profile>.toml`) from the
 * directory and each parent up to a file that sets `root = true`, then the global
 * `~/.config/fnox/config.toml`. A provider's name says nothing about what it stores; its `type` does.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { parse } from "smol-toml"
import type { ProviderTypes } from "./op-guard.ts"

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
    let root = false
    let names: string[] = []
    try {
      names = readdirSync(dir).filter((name) => CONFIG_NAME.test(name)).sort()
    } catch {
      // An unreadable directory holds no config we can trust; the walk continues.
    }
    for (const name of names) {
      const config = parse(readFileSync(join(dir, name), "utf8"))
      found.push(config)
      if (config.root === true) root = true
    }
    const parent = dirname(dir)
    if (root || parent === dir) break
    dir = parent
  }
  const global = join(home, ".config", "fnox", "config.toml")
  if (existsSync(global)) found.push(parse(readFileSync(global, "utf8")))
  return found
}

/**
 * Provider types by name for the config that applies to `cwd`. A name resolves only when every
 * definition of it (any file, any profile) has the same type; a missing provider, conflicting
 * definitions or an unreadable config resolve to `undefined`, which the op-guard treats as no value store.
 */
export function readProviderTypes(cwd: string, home: string = homedir()): ProviderTypes {
  let types: Map<string, Set<unknown>>
  try {
    types = new Map()
    for (const config of configs(cwd, home))
      for (const [name, type] of declared(config)) types.set(name, (types.get(name) ?? new Set()).add(type))
  } catch {
    return () => undefined
  }
  return (name) => {
    const set = types.get(name)
    const [only] = set ?? []
    return set?.size === 1 && typeof only === "string" ? only : undefined
  }
}
