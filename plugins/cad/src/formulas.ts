import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { type FormulaInstallResult, installFormulas as installShipped } from "@srobroek/opencode-lib/formulas"

export const SETUP_TOOL = "cad_setup"

/** The three poured roots, then the `mol-` molecules a root bonds onto its fan-out steps. */
export const FORMULAS = [
  "cad-product",
  "cad-part",
  "cad-touch",
  "mol-cad-analysis",
  "mol-cad-concept",
  "mol-cad-detail",
  "mol-cad-iterate",
  "mol-cad-part",
  "mol-cad-release",
  "mol-cad-sourcing",
  "mol-cad-variant",
] as const

/** The shipped `formulas/` directory: `src/` and the bundled `dist/` both sit one level below it. */
export const FORMULAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "formulas")

export const SETUP_DESCRIPTION =
  "Copy the cad plugin's beads formulas into a beads workspace's .beads/formulas/.\n" +
  "Covers cad-product, cad-part, cad-touch and the mol-cad-* molecules, so bd mol pour and bd mol bond find them. " +
  "Identical copies stay; divergent ones are refused unless force=true; symlinked paths are always refused."

export const SETUP_INPUT = {
  type: "object",
  properties: {
    workspace: { type: "string", description: "Beads workspace root (contains .beads/); default the session directory" },
    force: { type: "boolean", description: "Overwrite cad formulas that differ from the shipped ones" },
  },
  additionalProperties: false,
} as const

const USAGE = [
  "Pour a root with: bd mol pour cad-part --var product=<id> --var scope=hw/ (or cad-product, cad-touch)",
  "Bond a worker molecule onto a fan-out step with: bd mol bond mol-cad-<name> <step-id> --type parallel --ref <unit> --var ...",
]

/** Copy the cad formulas into `<workspace>/.beads/formulas/`; see the shared installer for the refusals. */
export function installFormulas(workspace: string, cwd: string, force = false): FormulaInstallResult {
  const result = installShipped({ workspace, cwd, force, names: FORMULAS, sourceDir: FORMULAS_DIR })
  return result.ok ? { ...result, text: [result.text, ...USAGE].join("\n") } : result
}
