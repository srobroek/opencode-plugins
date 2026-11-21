import { devNull } from "node:os"

/** Config git applies before any repository, user or system config (`-c` outranks them). */
type ConfigPair = readonly [key: string, value: string]

/**
 * `core.fsmonitor` is a program `git status` executes and `core.hooksPath` selects
 * hooks, so a hostile checkout's own config could run code.
 */
const SAFE_GIT_CONFIG: readonly ConfigPair[] = [
  ["core.fsmonitor", "false"],
  ["core.hooksPath", devNull],
]

/**
 * Git's global options for every command that runs inside a checkout this tool does
 * not control (a landed worktree, or another repository's checkout).
 *
 * Command-line `-c` outranks repository config. `--no-optional-locks` keeps a read from
 * writing the index.
 */
export const SAFE_GIT_ARGS = [...SAFE_GIT_CONFIG.flatMap(([key, value]) => ["-c", `${key}=${value}`]), "--no-optional-locks"] as const

/**
 * Everything in `SAFE_GIT_CONFIG`, plus the programs git runs while it reads history:
 * a global attributes file, and the signature verifiers that `log.showSignature` (also
 * `stash list`) starts for a signed commit.
 */
const HARDENED_GIT_CONFIG: readonly ConfigPair[] = [
  ...SAFE_GIT_CONFIG,
  ["core.attributesFile", devNull],
  ["log.showSignature", "false"],
  ["gpg.program", devNull],
  ["gpg.ssh.program", devNull],
  ["gpg.x509.program", devNull],
  // `wt merge` commits and rebases: signing would run gpg.ssh.defaultKeyCommand.
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["gpg.ssh.defaultKeyCommand", ""],
  // A lazy fetch (git before 2.45 ignores GIT_NO_LAZY_FETCH) runs these.
  ["core.sshCommand", ""],
  ["credential.helper", ""],
  // An empty command makes git fail instead of running one, so a hostile diff.external cannot execute.
  ["diff.external", ""],
]

/** The empty tree: as the attribute source, no path selects a `filter=`, `diff=` or `merge=` driver. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/** The oldest git with `GIT_ATTR_SOURCE`, which the hardening needs. */
export const GIT_MIN_VERSION = [2, 41, 0] as const

/** The `git config` regexp that lists every key that can name a command-running driver. */
export const DRIVER_KEY_PATTERN = "^(filter|diff|merge)\\."

/** `[major, minor, patch]` from `git --version` output, or undefined when it does not parse. */
export function parseGitVersion(text: string): [number, number, number] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (!match) return undefined
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** Why `git --version` output is not usable for hardened runs, or undefined when it is. An unreadable version fails closed. */
export function gitVersionProblem(text: string): string | undefined {
  const version = parseGitVersion(text)
  const need = GIT_MIN_VERSION.join(".")
  if (!version) return `cannot read the git version from ${JSON.stringify(text.trim())}; git ${need} or newer is required`
  for (const [index, minimum] of GIT_MIN_VERSION.entries()) {
    const have = version[index] ?? 0
    if (have > minimum) return undefined
    if (have < minimum) return `git ${version.join(".")} is older than ${need}, which this plugin needs to run git without executing repository-selected commands`
  }
  return undefined
}

/**
 * Blanking overrides for each configured driver that runs a command: clean, smudge, process, textconv
 * and merge drivers, plus `diff.<driver>.command`. `required=false` keeps git from failing a blanked filter.
 * A blanked diff command makes git fail ("cannot run") instead of running anything.
 */
export function driverOverrides(keys: readonly string[]): ConfigPair[] {
  const pairs: ConfigPair[] = []
  for (const key of keys) {
    const filter = /^(filter\..+)\.(clean|smudge|process)$/i.exec(key)
    if (filter) pairs.push([key, ""], [`${filter[1]}.required`, "false"])
    else if (/^diff\..+\.(textconv|command)$/i.test(key) || /^merge\..+\.driver$/i.test(key)) pairs.push([key, ""])
  }
  return pairs
}

/**
 * The environment for a child that runs git, directly or through `wt` or `gh`. It carries the hardening as
 * `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (command scope, like `-c`), so a child's own git calls inherit it.
 * `driverKeys` are the configured `filter|diff|merge` keys of the checkout, from `git config --name-only
 * --get-regexp DRIVER_KEY_PATTERN`; `GIT_ATTR_SOURCE` covers worktree `.gitattributes`, the overrides cover
 * `$GIT_DIR/info/attributes`, which it does not.
 */
export function hardenedGitEnv(base: Readonly<Record<string, string | undefined>>, driverKeys: readonly string[] = []): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined) env[key] = value
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10)
  let count = Number.isInteger(existing) && existing > 0 ? existing : 0
  for (const [key, value] of [...HARDENED_GIT_CONFIG, ...driverOverrides(driverKeys)]) {
    env[`GIT_CONFIG_KEY_${count}`] = key
    env[`GIT_CONFIG_VALUE_${count}`] = value
    count += 1
  }
  env.GIT_CONFIG_COUNT = String(count)
  env.GIT_ATTR_SOURCE = EMPTY_TREE
  env.GIT_OPTIONAL_LOCKS = "0"
  env.GIT_NO_LAZY_FETCH = "1"
  delete env.GIT_EXTERNAL_DIFF
  return env
}
