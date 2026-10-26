/**
 * Advisory, never a gate: when a shell call adds or installs a named package, the
 * vetting instruction is appended to that call's result, once per package per session.
 * Ported from omp-plugins (`safety/extensions/package-investigate.ts`); package
 * managers are recognised in command position only, so a quoted mention stays data.
 */

import { base, walkShell } from "./shell.ts"

/** Verbs that add or change a dependency. Read-only lookups are the investigation this asks for. */
const PACKAGE_COMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["pnpm", new Set(["add", "i", "install"])],
  ["npm", new Set(["add", "i", "install"])],
  ["bun", new Set(["add", "i", "install"])],
  ["yarn", new Set(["add", "i", "install"])],
  ["uv", new Set(["add"])],
  ["pip", new Set(["install"])],
  ["pip3", new Set(["install"])],
  ["poetry", new Set(["add"])],
  ["cargo", new Set(["add"])],
  ["go", new Set(["get"])],
  ["composer", new Set(["require"])],
])

const PACKAGE = /^(?!-)[A-Za-z@./_~][^;|&<>()`$]*$/

export const INVESTIGATE_NOTICE =
  "Before adding or changing a dependency, investigate the package (registry, maintainer, release, and downloads) and confirm it is not a typo-squat or abandoned. Prefer the package-manager CLI over manifest edits, and pin per the repo convention. If it fails that check, revert the change."

/** Literal package operands of add/install commands in real shell command positions. */
export function packagesToInvestigate(command: string): string[] {
  const packages: string[] = []
  for (const item of walkShell(command).commands) {
    const verbs = PACKAGE_COMMANDS.get(base(item.argv[0]))
    if (verbs === undefined || item.argv[0]?.includes("/")) continue
    if (!verbs.has(item.argv[1] ?? "")) continue
    for (let i = 2; i < item.argv.length; i++) {
      const value = item.argv[i] as string
      if (item.words?.[i]?.expands && /[$`]/.test(value)) continue
      if (PACKAGE.test(value)) packages.push(value)
    }
  }
  return packages
}

export function shouldInvestigate(command: string): boolean {
  return packagesToInvestigate(command).length > 0
}

export type PackageAdvisor = {
  /** The notice for packages `command` names that this session has not named yet, or undefined. */
  notice(sessionID: string, command: string): string | undefined
}

export function createPackageAdvisor(): PackageAdvisor {
  const noticed = new Map<string, Set<string>>()
  return {
    notice(sessionID, command) {
      const seen = noticed.get(sessionID) ?? new Set<string>()
      const fresh = [...new Set(packagesToInvestigate(command))].filter((name) => !seen.has(name))
      if (fresh.length === 0) return undefined
      for (const name of fresh) seen.add(name)
      noticed.set(sessionID, seen)
      return `${INVESTIGATE_NOTICE} Packages: ${fresh.join(", ")}.`
    },
  }
}
