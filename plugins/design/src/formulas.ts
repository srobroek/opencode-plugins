import { copyFileSync, lstatSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const SETUP_TOOL = "design_setup"

/** The three poured tiers, then the `mol-` sub-processes a tier bonds onto one of its steps. */
export const FORMULAS = [
  "design-touch",
  "design-surface",
  "design-system",
  "mol-design-a11y",
  "mol-design-component",
  "mol-design-iterate",
  "mol-design-motion",
  "mol-design-responsive",
  "mol-design-tokens",
] as const

/** The shipped `formulas/` directory: `src/` and the bundled `dist/` both sit one level below it. */
export const FORMULAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "formulas")

export type InstallResult = { ok: boolean; text: string; copied: string[]; unchanged: string[] }

/** The first symlink among `.beads` and `.beads/formulas`, the paths the copy writes through. */
function symlinkBelow(repo: string): string | null {
  for (const path of [join(repo, ".beads"), join(repo, ".beads", "formulas")])
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return path
  return null
}

/**
 * Copy the shipped formulas into `<workspace>/.beads/formulas/`, where `bd formula list`
 * finds them. The workspace must already be a beads workspace. Identical copies stay; a
 * divergent destination is refused unless `force`; a symlinked `.beads`, formulas
 * directory or formula file is refused.
 */
export function installFormulas(
  workspace: string,
  cwd: string,
  force = false,
  sourceDir = FORMULAS_DIR,
): InstallResult {
  const repo = isAbsolute(workspace) ? workspace : resolve(cwd, workspace)
  const fail = (text: string): InstallResult => ({ ok: false, text, copied: [], unchanged: [] })
  const beads = join(repo, ".beads")
  const destDir = join(beads, "formulas")
  const link = symlinkBelow(repo)
  if (link) return fail(`refusing symlinked path: ${link}`)
  if (!lstatSync(beads, { throwIfNoEntry: false })?.isDirectory())
    return fail(`not a beads workspace: ${repo} has no .beads/ (run bd init there first)`)
  const destStat = lstatSync(destDir, { throwIfNoEntry: false })
  if (destStat && !destStat.isDirectory()) return fail(`formula destination is not a directory: ${destDir}`)
  const copies: { src: string; dest: string; name: string }[] = []
  const unchanged: string[] = []
  const divergent: string[] = []
  for (const name of FORMULAS) {
    const src = join(sourceDir, `${name}.formula.toml`)
    const dest = join(destDir, `${name}.formula.toml`)
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
  mkdirSync(destDir, { recursive: true })
  for (const { src, dest } of copies) copyFileSync(src, dest)
  const copied = copies.map(({ name }) => name)
  const lines = [
    copied.length > 0 ? `copied ${copied.join(", ")} into ${destDir}` : `every design formula already in ${destDir}`,
    "Pour a tier with: bd mol pour design-touch --var surface=<route> --var scope=<paths>",
    "Bond a sub-process with: bd mol bond mol-design-<name> <step-id> --var surface=<route> --var node=<step-id>",
  ]
  return { ok: true, text: lines.join("\n"), copied, unchanged }
}
