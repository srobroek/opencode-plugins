/**
 * Copy a plugin's shipped Beads formulas into a workspace's `.beads/formulas/`, where
 * `bd formula list`, `bd mol pour` and `bd mol bond` find them.
 */

import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"

export type FormulaInstall = {
  /** Beads workspace root (the directory holding `.beads/`), absolute or relative to `cwd`. */
  workspace: string
  cwd: string
  /** Formula names; each ships as `<sourceDir>/<name>.formula.toml`. */
  names: readonly string[]
  sourceDir: string
  /** Replace destinations that differ from the shipped file. */
  force?: boolean
}

export type FormulaInstallResult = {
  ok: boolean
  /** The failure, or where the formulas went. */
  text: string
  copied: string[]
  unchanged: string[]
  /** `<workspace>/.beads/formulas`, also on failure once the workspace resolved. */
  destination: string
}

/** The first symlink among `.beads` and `.beads/formulas`, the paths the copy writes through. */
function symlinkBelow(repo: string): string | null {
  for (const path of [join(repo, ".beads"), join(repo, ".beads", "formulas")])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return path
  return null
}

/**
 * Identical copies stay; a divergent destination is refused unless `force`; a symlinked
 * `.beads`, formulas directory or formula file is refused. The workspace must already be a
 * Beads workspace. Nothing is written unless every formula can be.
 */
export function installFormulas(options: FormulaInstall): FormulaInstallResult {
  const { workspace, cwd, names, sourceDir, force = false } = options
  const repo = isAbsolute(workspace) ? workspace : resolve(cwd, workspace)
  const beads = join(repo, ".beads")
  const destination = join(beads, "formulas")
  const fail = (text: string): FormulaInstallResult => ({ ok: false, text, copied: [], unchanged: [], destination })
  const link = symlinkBelow(repo)
  if (link) return fail(`refusing symlinked path: ${link}`)
  if (!lstatSync(beads, { throwIfNoEntry: false })?.isDirectory())
    return fail(`not a beads workspace: ${repo} has no .beads/ (run bd init there first)`)
  const destStat = lstatSync(destination, { throwIfNoEntry: false })
  if (destStat && !destStat.isDirectory()) return fail(`formula destination is not a directory: ${destination}`)
  const copies: { src: string; dest: string; name: string }[] = []
  const unchanged: string[] = []
  const divergent: string[] = []
  for (const name of names) {
    const src = join(sourceDir, `${name}.formula.toml`)
    const dest = join(destination, `${name}.formula.toml`)
    const srcStat = lstatSync(src, { throwIfNoEntry: false })
    if (!srcStat?.isFile() || srcStat.isSymbolicLink()) return fail(`shipped formula missing or unsafe: ${src}`)
    const st = lstatSync(dest, { throwIfNoEntry: false })
    if (st && (st.isSymbolicLink() || !st.isFile())) return fail(`refusing non-file formula destination: ${dest}`)
    if (st && readFileSync(src).equals(readFileSync(dest))) {
      unchanged.push(name)
      continue
    }
    if (st) divergent.push(dest)
    copies.push({ src, dest, name })
  }
  if (divergent.length > 0 && !force)
    return fail(`refusing to overwrite divergent formulas (pass force=true to replace them): ${divergent.join(", ")}`)
  mkdirSync(destination, { recursive: true })
  for (const { src, dest } of copies) copyFileSync(src, dest)
  const copied = copies.map(({ name }) => name)
  const text = copied.length > 0 ? `copied ${copied.join(", ")} into ${destination}` : `every formula already in ${destination}`
  return { ok: true, text, copied, unchanged, destination }
}
