/**
 * The TASK STATE route of instructions/speckit-workflow.md, run against the real bd CLI:
 * one `bd create --graph specs/<NNN-slug>/tasks.graph.json`, dry-run first, then the
 * identities read back with `bd list --parent <implement-step-id> --json`.
 *
 * beads-ledger's node-field list omits `spec_id`, and bd rejects `--spec-id` with
 * `--graph` ("graph plans supply per-node fields"), so this checks that a node-level
 * `spec_id` persists on every task. CI images without bd skip it.
 */

import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BD_ON_PATH = Bun.which("bd") !== null
const SPEC = "001-x"

test.skipIf(!BD_ON_PATH)(
  "a graph plan's node-level spec_id, acceptance and routing metadata persist on every task",
  () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "speckit-graph-")))
    const env: Record<string, string> = { BD_NON_INTERACTIVE: "1", BD_NO_PAGER: "1" }
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && !key.startsWith("BEADS_") && !key.startsWith("GIT_")) env[key] = value
    const run = (argv: string[]) => {
      const proc = Bun.spawnSync(argv, { cwd: repo, env, stdout: "pipe", stderr: "pipe" })
      if (proc.exitCode !== 0) throw new Error(`${argv.join(" ")}: ${proc.stderr.toString()}`)
      return proc.stdout.toString()
    }
    try {
      run(["git", "init", "-q"])
      run(["bd", "init", "--quiet", "--prefix", "gt"])
      const implement = (JSON.parse(run(["bd", "create", `implement ${SPEC}`, "-t", "task", "--json"])) as { id: string }).id
      const node = (key: string, title: string) => ({
        key,
        parent_id: implement,
        spec_id: SPEC,
        type: "task",
        title,
        acceptance_criteria: `${title} is done`,
        metadata: { execution_agent_type: "implementer" },
      })
      const plan = join("specs", SPEC, "tasks.graph.json")
      mkdirSync(join(repo, "specs", SPEC), { recursive: true })
      writeFileSync(
        join(repo, plan),
        JSON.stringify({
          nodes: [node("a", "T001 a"), node("b", "T002 b")],
          edges: [{ from_key: "b", to_key: "a", type: "blocks" }],
        }),
      )
      expect(run(["bd", "create", "--graph", plan, "--dry-run"])).toContain("2 parent-child link(s)")
      const { a: first, b: second } = (
        JSON.parse(run(["bd", "create", "--graph", plan, "--json"])) as { ids: { a: string; b: string } }
      ).ids
      type Row = {
        id: string
        spec_id?: string
        acceptance_criteria?: string
        metadata?: Record<string, unknown>
        dependencies?: { depends_on_id: string; type: string }[]
      }
      const rows = JSON.parse(run(["bd", "list", "--parent", implement, "--json"])) as Row[]
      expect(rows.map((row) => row.id).sort()).toEqual([first, second].sort())
      for (const row of rows) {
        expect(row.spec_id).toBe(SPEC)
        expect(row.acceptance_criteria).toEndWith("is done")
        expect(row.metadata?.execution_agent_type).toBe("implementer")
      }
      const later = rows.find((row) => row.id === second)
      expect(later?.dependencies?.filter((edge) => edge.type === "blocks").map((edge) => edge.depends_on_id)).toEqual([
        first,
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  },
  180_000,
)
