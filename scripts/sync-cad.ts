// Vendors the CAD skills, the lamp-arm example and the worker agents from srobroek/cad-agent
// into plugins/cad at the tag and commit pinned in plugins/cad/cad-agent.json.
//
// plugins/cad/skills/ and plugins/cad/examples/ are cad-agent's trees at the pin, without the
// upstream test suites (cad-agent's CI runs them) and with the SKILL_DESCRIPTIONS overrides.
// plugins/cad/agents/<id>.md is cad-agent's agents/<id>.md prompt under OpenCode frontmatter built
// here from its capabilities, plus an OpenCode section. The plugin owns everything else: src/,
// formulas/, README.md and the pin itself. Never edit the vendored files; change cad-agent, tag
// it, and move the pin.
//
//   bun scripts/sync-cad.ts                 vendor the pinned tag
//   bun scripts/sync-cad.ts --tag v0.2.0    move the pin to that tag, then vendor it
//   bun scripts/sync-cad.ts --check         fail when the vendored files differ from the pinned tag
//   --source <url|path>                     clone from there instead of the pin's repository

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const PLUGIN_DIR = path.join(import.meta.dir, "..", "plugins", "cad")
export const PIN_FILE = "cad-agent.json"
/** The plugin directories this script owns; each is replaced as a whole. */
export const OWNED = ["skills", "examples", "agents"] as const

export type Pin = { repository: string; tag: string; commit: string }
/** A vendored file; `symlink` marks a symbolic link found in the plugin, which is never vendored. */
export type File = { data: Buffer; executable: boolean; symlink?: true }
/** Vendored files by their path relative to plugins/cad, with `/` separators. */
export type Tree = Map<string, File>

export function parsePin(text: string): Pin {
  const pin = JSON.parse(text) as Partial<Pin>
  if (typeof pin.repository !== "string" || pin.repository === "") throw new Error(`${PIN_FILE}: repository must be a URL`)
  if (typeof pin.tag !== "string" || pin.tag === "") throw new Error(`${PIN_FILE}: tag must be a non-empty string`)
  if (typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit))
    throw new Error(`${PIN_FILE}: commit must be a full 40-character commit id`)
  return { repository: pin.repository, tag: pin.tag, commit: pin.commit }
}

export function formatPin(pin: Pin): string {
  return `${JSON.stringify(pin, null, 2)}\n`
}

/** Whether an upstream path is vendored: the skills and examples trees, less tests and caches. */
export function vendored(file: string): boolean {
  const parts = file.split("/")
  if (parts[0] !== "skills" && parts[0] !== "examples") return false
  if (parts.some((part) => part === "tests" || part === "__pycache__")) return false
  const name = parts.at(-1) as string
  return !/^test_.*\.py$/.test(name) && !name.endsWith(".pyc")
}

type Tier = "cheap" | "standard" | "strong" | "reviewer"
/** What the plugin adds to each cad-agent agent: its model-roles tier, step limit and, if needed, a shorter description. */
export type Overlay = { tier: Tier; steps: number; description?: string }

export const AGENTS: Readonly<Record<string, Overlay>> = {
  "cad-analyst": {
    tier: "strong",
    steps: 100,
    description:
      "Runs one L4 analysis case (sweep, FreeCAD assembly, stack-up, FEA, motion) on an integrated CAD version and proposes verification rows.",
  },
  "cad-concept-designer": { tier: "standard", steps: 100 },
  "cad-dfm-reviewer": { tier: "reviewer", steps: 60 },
  "cad-mech-reviewer": { tier: "reviewer", steps: 60 },
  "cad-part-designer": { tier: "strong", steps: 150 },
  "cad-sourcing-researcher": {
    tier: "standard",
    steps: 80,
    description:
      "Researches one purchased-part family with cited designations, datasheets, installation limits and materials. Read-only; spawned at L2 PARTS.",
  },
}

/**
 * Shorter descriptions for the cad-agent skills whose own pass the 160-character limit that
 * `bun run descriptions` enforces, since every request lists each skill's description.
 */
export const SKILL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "cad-design":
    'Grows CAD parts from massing blocks to real products, fidelity F0-F3. Triggers on "make it look real", "detail parts".',
  "cad-fits": 'ISO 286 hole/shaft limits, fit types and worst-case/RSS stack-ups. Triggers on "what fit for", "H7/g6", "stack-up".',
  "cad-motion":
    'Poses, sweeps and renders jointed assemblies for interference and motion. Triggers on "pose the arm", "sweep joints".',
}

/** A `SKILL.md` with its frontmatter `description` replaced by `description`. */
export function withDescription(file: string, text: string, description: string): string {
  const pattern = /^(---\n(?:.*\n)*?)description: .*\n((?:.*\n)*?---\n)/
  if (!pattern.test(text)) throw new Error(`${file}: no one-line frontmatter description to replace`)
  const scalar = /^[A-Za-z]/.test(description) && !/: | #/.test(description) ? description : `'${description.replaceAll("'", "''")}'`
  const replaced = text.replace(pattern, (_, head: string, tail: string) => `${head}description: ${scalar}\n${tail}`)
  const front = /^---\n([\s\S]*?)\n---\n/.exec(replaced)?.[1] ?? ""
  if ((Bun.YAML.parse(front) as { description?: unknown }).description !== description)
    throw new Error(`${file}: the replaced description does not parse back`)
  return replaced
}

const CAPABILITIES = ["read", "write-scratch", "shell-uv", "web"] as const
type Capability = (typeof CAPABILITIES)[number]
type Rule = [action: string, resource: string, effect: "allow" | "deny" | "ask"]

const READ: Rule[] = [
  ["*", "*", "deny"],
  ["read", "*", "allow"],
  ["read", "*.env", "ask"],
  ["read", "*.env.*", "ask"],
  ["read", "*.env.example", "allow"],
  ["grep", "*", "allow"],
  ["glob", "*", "allow"],
  ["skill", "cad-*", "allow"],
  ["external_directory", "*", "ask"],
]
/**
 * cad-agent's `shell-uv` grants a `uv *` shell prefix, which runs any program. Here the agent gets
 * `cad_run` instead, which starts only a script under the plugin's skills/ through `run.py`.
 */
const GRANTS: Record<Exclude<Capability, "read">, Rule[]> = {
  "write-scratch": [["edit", ".cad-work/*", "allow"]],
  "shell-uv": [
    ["execute", "*", "allow"],
    ["cad_run", "*", "allow"],
  ],
  web: [
    ["webfetch", "*", "allow"],
    ["websearch", "*", "allow"],
  ],
}

/** For an agent with `shell-uv`, whose cad-agent prompt runs its scripts in a shell. */
export const CAD_RUN_NOTE = [
  "You have no shell here. Run each documented",
  '`uv run --script "$CAD_SKILLS/cad-flow/scripts/run.py" <skill>/scripts/<script>.py <args...>` command as one `cad_run`',
  "call: `script` is `<skill>/scripts/<script>.py` and `args` holds the remaining arguments, one per item. It runs from the",
  "project root in the same environment.",
].join("\n")

/**
 * The section appended to every agent's prompt: OpenCode has no field that preloads skills, so the
 * agent loads cad-agent's `skills` list itself, and a `shell-uv` agent gets `CAD_RUN_NOTE`.
 */
export function openCodeNote(skills: readonly string[], shell: boolean): string {
  const names = skills.map((skill) => `\`${skill}\``)
  const list = names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`
  const load = `Load the ${list} skill${skills.length > 1 ? "s" : ""} first.`
  return ["## OpenCode", "", load, ...(shell ? ["", CAD_RUN_NOTE] : []), ""].join("\n")
}

const quote = (value: string) => (/^[\w.-]+$/.test(value) ? value : JSON.stringify(value))

/** The OpenCode agent file for one cad-agent `agents/<id>.md`, pinned at `tag`. */
export function composeAgent(id: string, text: string, overlay: Overlay, tag: string): string {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`agents/${id}.md: expected YAML frontmatter followed by the prompt`)
  const fields = Bun.YAML.parse(match[1] as string) as Record<string, unknown>
  if (fields.name !== id) throw new Error(`agents/${id}.md: name ${String(fields.name)} does not match the file name`)
  const capabilities = fields.capabilities
  if (!Array.isArray(capabilities) || !capabilities.includes("read") || capabilities.some((c) => !CAPABILITIES.includes(c)))
    throw new Error(`agents/${id}.md: capabilities must include read and come from ${CAPABILITIES.join(", ")}`)
  const skills = fields.skills
  if (!Array.isArray(skills) || skills.length === 0 || skills.some((skill) => typeof skill !== "string" || !/^cad-[a-z0-9-]+$/.test(skill)))
    throw new Error(`agents/${id}.md: skills must list cad-* skill names`)
  const description = overlay.description ?? fields.description
  if (typeof description !== "string" || description === "") throw new Error(`agents/${id}.md: no description`)
  const rules = [
    ...READ,
    ...CAPABILITIES.flatMap((capability) => (capability !== "read" && capabilities.includes(capability) ? GRANTS[capability] : [])),
    ["subagent", "*", "deny"] satisfies Rule,
  ]
  const front = [
    `# Generated by scripts/sync-cad.ts from cad-agent ${tag} agents/${id}.md. Do not edit.`,
    `description: ${JSON.stringify(description)}`,
    "mode: subagent",
    `steps: ${overlay.steps}`,
    "request:",
    "  headers:",
    `    x-opencode-model-role: ${overlay.tier}`,
    "permissions:",
    ...rules.flatMap(([action, resource, effect]) => [
      `  - action: ${quote(action)}`,
      `    resource: ${JSON.stringify(resource)}`,
      `    effect: ${effect}`,
    ]),
  ]
  const body = (match[2] as string).trimEnd()
  return `---\n${front.join("\n")}\n---\n${body}\n\n${openCodeNote(skills, capabilities.includes("shell-uv"))}`
}

/** Every vendored file of a cad-agent checkout, from its tracked files (`git ls-files -s` lines). */
export function collect(
  checkout: string,
  index: string,
  tag: string,
  overlays: Readonly<Record<string, Overlay>> = AGENTS,
  descriptions: Readonly<Record<string, string>> = SKILL_DESCRIPTIONS,
): Tree {
  const tree: Tree = new Map()
  const agents = new Set<string>()
  const described = new Set<string>()
  for (const line of index.split("\0")) {
    if (line === "") continue
    const tab = line.indexOf("\t")
    const [mode] = line.slice(0, tab).split(" ")
    const file = line.slice(tab + 1)
    const agent = /^agents\/(cad-[\w-]+)\.md$/.exec(file)?.[1]
    if (agent === undefined && !vendored(file)) continue
    if (mode !== "100644" && mode !== "100755") throw new Error(`${file}: mode ${mode} is not a regular file`)
    const data = readFileSync(path.join(checkout, file))
    if (agent === undefined) {
      const skill = /^skills\/(cad-[\w-]+)\/SKILL\.md$/.exec(file)?.[1]
      const description = skill === undefined ? undefined : descriptions[skill]
      if (description === undefined) tree.set(file, { data, executable: mode === "100755" })
      else {
        described.add(skill as string)
        const text = withDescription(file, data.toString("utf8"), description)
        tree.set(file, { data: Buffer.from(text), executable: mode === "100755" })
      }
      continue
    }
    const overlay = overlays[agent]
    if (overlay === undefined) throw new Error(`cad-agent ${tag} adds agents/${agent}.md: give it an entry in AGENTS`)
    agents.add(agent)
    tree.set(file, { data: Buffer.from(composeAgent(agent, data.toString("utf8"), overlay, tag)), executable: false })
  }
  const missing = Object.keys(overlays).filter((id) => !agents.has(id))
  if (missing.length > 0) throw new Error(`cad-agent ${tag} has no agents/${missing.join(".md, agents/")}.md: drop it from AGENTS`)
  const stale = Object.keys(descriptions).filter((skill) => !described.has(skill))
  if (stale.length > 0) throw new Error(`cad-agent ${tag} has no skill ${stale.join(", ")}: drop it from SKILL_DESCRIPTIONS`)
  return tree
}

/**
 * The files under the plugin's owned directories, ignoring Python caches and Finder metadata.
 * Symbolic links, an owned directory's own included, are never followed: each is recorded as a
 * `symlink` entry, so `drift` reports it even when its target holds the expected bytes.
 */
export function readTree(dir: string): Tree {
  const tree: Tree = new Map()
  const link: File = { data: Buffer.alloc(0), executable: false, symlink: true }
  const walk = (relative: string) => {
    const full = path.join(dir, relative)
    const stat = lstatSync(full, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (stat.isSymbolicLink()) return void tree.set(relative, link)
    if (stat.isDirectory()) {
      for (const name of readdirSync(full)) {
        if (name === "__pycache__" || name === ".DS_Store" || name.endsWith(".pyc")) continue
        walk(`${relative}/${name}`)
      }
      return
    }
    tree.set(relative, { data: readFileSync(full), executable: (stat.mode & 0o111) !== 0 })
  }
  for (const owned of OWNED) walk(owned)
  return tree
}

/** How `actual` differs from `expected`, one line per path, sorted. */
export function drift(expected: Tree, actual: Tree): string[] {
  const problems: string[] = []
  for (const [file, have] of actual) if (have.symlink) problems.push(`symlink  ${file} must be a regular file or directory`)
  for (const [file, want] of expected) {
    const have = actual.get(file)
    if (have?.symlink) continue
    if (have === undefined) problems.push(`missing  ${file}`)
    else if (!have.data.equals(want.data)) problems.push(`changed  ${file}`)
    else if (have.executable !== want.executable) problems.push(`mode     ${file} should${want.executable ? "" : " not"} be executable`)
  }
  for (const [file, have] of actual) if (!have.symlink && !expected.has(file)) problems.push(`extra    ${file}`)
  return problems.sort((a, b) => a.slice(9).localeCompare(b.slice(9)))
}

/** Replace the owned directories of `dir` with `tree`. */
export function writeTree(dir: string, tree: Tree): void {
  for (const owned of OWNED) rmSync(path.join(dir, owned), { recursive: true, force: true })
  for (const [file, { data, executable }] of tree) {
    const full = path.join(dir, file)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, data)
    chmodSync(full, executable ? 0o755 : 0o644)
  }
}

function git(args: string[], cwd?: string): string {
  const run = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString().trim()}`)
  return run.stdout.toString()
}

/** Clone `tag` from `source` into `checkout` and return the commit it names. */
function fetch(source: string, tag: string, checkout: string): string {
  git(["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", tag, source, checkout])
  return git(["rev-parse", "HEAD^{commit}"], checkout).trim()
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`)
  return value
}

export type Io = { log: (line: string) => void; error: (line: string) => void }

/**
 * The command line: vendor the pinned tag, move the pin with `--tag`, or `--check` for drift.
 * Returns the exit status. Nothing is written when the pinned tag no longer names the pinned
 * commit, and the scratch clone is always removed.
 */
export function sync(argv: readonly string[], pluginDir = PLUGIN_DIR, io: Io = { log: console.log, error: console.error }): number {
  const check = argv.includes("--check")
  const tag = option(argv, "--tag")
  if (check && tag !== undefined) throw new Error("--check verifies the pinned tag; it takes no --tag")
  const pinFile = path.join(pluginDir, PIN_FILE)
  const pinned = parsePin(readFileSync(pinFile, "utf8"))
  const wanted = tag ?? pinned.tag
  const checkout = mkdtempSync(path.join(os.tmpdir(), "sync-cad-"))
  try {
    const commit = fetch(option(argv, "--source") ?? pinned.repository, wanted, checkout)
    if (tag === undefined && commit !== pinned.commit) {
      io.error(`cad-agent ${wanted} is ${commit}, but ${PIN_FILE} pins ${pinned.commit}: a moved tag needs review`)
      return 1
    }
    const tree = collect(checkout, git(["ls-files", "-s", "-z"], checkout), wanted)
    if (check) {
      const problems = drift(tree, readTree(pluginDir))
      if (problems.length === 0) {
        io.log(`plugins/cad matches cad-agent ${wanted} (${commit})`)
        return 0
      }
      io.error(`plugins/cad differs from cad-agent ${wanted}. Run \`bun run cad:sync\` and commit the result:`)
      for (const problem of problems) io.error(`  ${problem}`)
      return 1
    }
    writeTree(pluginDir, tree)
    writeFileSync(pinFile, formatPin({ ...pinned, tag: wanted, commit }))
    io.log(`vendored ${tree.size} files from cad-agent ${wanted} (${commit}) into plugins/cad`)
    return 0
  } finally {
    rmSync(checkout, { recursive: true, force: true })
  }
}

if (import.meta.main) process.exitCode = sync(process.argv.slice(2))
