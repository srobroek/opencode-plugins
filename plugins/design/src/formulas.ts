import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type FormulaInstallResult, installFormulas as installShipped } from "@srobroek/opencode-lib/formulas"

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

const USAGE = [
  "Pour a tier with: bd mol pour design-touch --var surface=<route> --var scope=<paths>",
  "Bond a sub-process with: bd mol bond mol-design-<name> <step-id> --var surface=<route> --var node=<step-id>",
]

/** Copy the design formulas into `<workspace>/.beads/formulas/`; see the shared installer for the refusals. */
export function installFormulas(workspace: string, cwd: string, force = false): FormulaInstallResult {
  const result = installShipped({ workspace, cwd, force, names: FORMULAS, sourceDir: FORMULAS_DIR })
  return result.ok ? { ...result, text: [result.text, ...USAGE].join("\n") } : result
}
