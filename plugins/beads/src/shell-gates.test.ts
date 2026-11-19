import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { writeExecutable } from "@srobroek/opencode-lib/executable-fixture"
import { setBdShowRunForTests } from "./bd-close-gate.ts"
import { GateAdmitter } from "./gate-admission.ts"
import { parse } from "./shell.ts"
import { createLedgerWarning, decideShell, hasBdEdit, withActorPrefix } from "./shell-gates.ts"
import { gateDeps } from "./test-support.ts"

// Real child processes; 30 s leaves headroom for a loaded machine (AGENTS.md, Testing).
setDefaultTimeout(30_000)

describe("decideShell", () => {
  let root = ""
  let store = ""
  beforeAll(() => {
    root = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-shell-gates-"))
    store = join(root, ".beads")
    mkdirSync(store)
    writeFileSync(join(store, "metadata.json"), "{}")
    setBdShowRunForTests((argv) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        argv
          .filter((word) => /^proj-/.test(word))
          .map((id) => ({ id, issue_type: id === "proj-gate" ? "gate" : "task" })),
      ),
    }))
  })
  afterAll(() => {
    setBdShowRunForTests(null)
    rmSync(root, { recursive: true, force: true })
  })

  const deps = (overrides: Parameters<typeof gateDeps>[0] = {}) =>
    gateDeps({ env: { PATH: process.env.PATH, BEADS_DIR: store }, ...overrides })

  test("refuses an unparseable command", async () => {
    expect(await decideShell("echo 'unterminated", root, deps())).toMatchObject({ kind: "block", gate: "bash-gates" })
    expect(await decideShell("bd close 'proj-1", root, deps())).toMatchObject({ kind: "block" })
  })

  test("update-close is refused before the close lookup runs", async () => {
    const decision = await decideShell("bd update proj-gate --status closed", root, deps())
    expect(decision).toMatchObject({ kind: "block", gate: "bd-update-close-gate" })
  })

  test("refuses closing a gate bead", async () => {
    const decision = await decideShell('bd close proj-gate --reason "x"', root, deps({ actor: "a/b/c" }))
    expect(decision).toMatchObject({ kind: "block", gate: "bd-close-gate" })
  })

  test("refuses an unguarded unclaim", async () => {
    expect(await decideShell("bd unclaim proj-1", root, deps())).toMatchObject({ gate: "bd-unclaim-gate" })
  })

  test("an apostrophe in a double-quoted default does not stop an ordinary command", async () => {
    for (const command of [
      `echo "\${X:-can't}"`,
      `echo "\${X:-it's} and \${Y:-isn't}"`,
      `echo "\${X:-{}"`,
      `echo "\${X:-$(printf '{"a":1}')}"`,
    ]) {
      expect(await decideShell(command, root, deps())).toMatchObject({ kind: "allow" })
    }
  })

  test("warns, without refusing, a main-session create that names no actor", async () => {
    const decision = await decideShell("bd create --title t", root, deps())
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") expect(decision.advisories.join("\n")).toContain("BEADS_ACTOR")
  })

  test.each([
    [undefined, 30000],
    [45000, 45000],
    [0, 0],
  ])("forwards embeddedWriteWaitMs %p to the runner as %p ms", async (configured, expected) => {
    const options = configured === undefined ? {} : { embeddedWriteWaitMs: configured }
    const decision = await decideShell("bd update proj-1 --claim", root, deps({ actor: "a/b/c", options }))
    if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
    expect(decision.command).toContain(`--beads-wait-ms ${expected} -- bd update`)
  })

  test.each([
    ['BEADS_ACTOR=opencode/o/t bd comments add proj-1 "fix in progress; say retry; bd create x"'],
    ['bd comments add proj-1 "fix in progress; say retry; bd create x"'],
    ['bd comments add proj-1 "bd create foo"'],
    ["FOO=1 BEADS_ACTOR=x bd create --title t"],
  ])("does not refuse %s", async (command) => {
    expect(await decideShell(command, root, deps())).not.toMatchObject({ gate: "bd-actor-gate" })
  })

  test("warns about a real create after quoted text mentioning an actor", async () => {
    const decision = await decideShell('echo "BEADS_ACTOR=x"; bd create --title t', root, deps())
    expect(decision.kind).toBe("allow")
    if (decision.kind === "allow") expect(decision.advisories.join("\n")).toContain("BEADS_ACTOR")
  })

  test("refuses a PR without a bead trailer when the repository is controlled", async () => {
    const decision = await decideShell(
      'gh pr create --title t --body "no trailer here"',
      root,
      deps({ repositoryControl: () => ({ kind: "controlled" }) }),
    )
    expect(decision).toMatchObject({ kind: "block", gate: "pr-bead-link-gate" })
    const linked = await decideShell(
      'gh pr create --title t --body "Bead: proj-1 fixes it"',
      root,
      deps({ repositoryControl: () => ({ kind: "controlled" }) }),
    )
    expect(linked.kind).toBe("allow")
  })

  describe("ledger context wiring", () => {
    let repoA = ""
    let repoB = ""
    beforeAll(() => {
      repoA = join(root, "repo-a")
      repoB = join(root, "repo-b")
      for (const repo of [repoA, repoB]) {
        mkdirSync(join(repo, ".beads"), { recursive: true })
        writeFileSync(join(repo, ".beads", "metadata.json"), `{"dolt_database":"db_${repo.slice(-1)}"}`)
        execFileSync("git", ["init", "-q", repo])
      }
    })

    test("an allowed bd create into another repository's ledger carries the advisory", async () => {
      const decision = await decideShell(
        "bd create --title t",
        repoA,
        deps({ actor: "a/b/c", env: { PATH: process.env.PATH, BEADS_DIR: join(repoB, ".beads") } }),
      )
      if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
      expect(decision.advisories.join("\n")).toContain(realpathSync(join(repoB, ".beads")))
    })

    test("a create into the repository's own ledger carries none", async () => {
      const decision = await decideShell(
        "bd create --title t",
        repoA,
        deps({ actor: "a/b/c", env: { PATH: process.env.PATH, BEADS_DIR: join(repoA, ".beads") } }),
      )
      expect(decision.kind === "allow" ? decision.advisories : ["x"]).toEqual([])
    })

    test("a PR-link refusal names the ledger it read and where it walked from", async () => {
      const sub = join(repoA, "sub")
      mkdirSync(sub, { recursive: true })
      const decision = await decideShell(
        'gh pr create --title t --body "no trailer"',
        sub,
        deps({ repositoryControl: () => ({ kind: "controlled" }) }),
      )
      if (decision.kind !== "block") throw new Error(JSON.stringify(decision))
      expect(decision.cause).toContain(JSON.stringify(join(repoA, ".beads")))
      expect(decision.cause).toContain('prefix "db_a"')
      expect(decision.cause).toContain(`walking up from ${JSON.stringify(sub)}`)
    })

    test("with the write lock disabled, a hostile ledger file neither hangs nor yields an advisory", async () => {
      const hostileRoot = join(root, "repo-fifo")
      mkdirSync(join(hostileRoot, ".beads"), { recursive: true })
      execFileSync("mkfifo", [join(hostileRoot, ".beads", "metadata.json")])
      execFileSync("git", ["init", "-q", hostileRoot])
      const env = { PATH: process.env.PATH, BEADS_DIR: join(hostileRoot, ".beads") }
      const off = { gates: { "bd-embedded-write-lock": { enabled: false } } }
      const decision = await decideShell("bd create --title t", repoA, deps({ actor: "a/b/c", env, options: off }))
      expect(decision.kind === "allow" ? decision.advisories : ["x"]).toEqual([])
      // Enabled, the same ledger still reaches the lock rather than skipping it.
      const on = await decideShell("bd create --title t", repoA, deps({ actor: "a/b/c", env }))
      expect(on.kind).toBe("allow")
      expect(on.kind === "allow" ? on.command : "").toContain("bd-embedded-write-runner")
    })

    test("admission's dynamic-cwd refusal tells the agent to pass workdir", async () => {
      const decision = await decideShell("cd $WORKTREE && bd update proj-1 --claim", root, deps({ actor: "a/b/c" }))
      if (decision.kind !== "block") throw new Error(JSON.stringify(decision))
      expect(decision.gate).toBe("beads-gate-admission")
      expect(decision.cause).toContain("pass the shell tool's `workdir` parameter")
    })

    test("--actor and --json before create do not suppress the advisory", () => {
      const env = { BEADS_DIR: join(repoB, ".beads") }
      for (const command of ["bd --actor x create --title t", "bd --json create --title t"])
        expect(createLedgerWarning(command, repoA, env)).toContain("`workdir`")
    })

    test("target selectors and help forms suppress it", () => {
      const env = { BEADS_DIR: join(repoB, ".beads") }
      for (const command of [
        `bd -C ${repoB} create --title t`,
        `bd --db ${join(repoB, ".beads")} create --title t`,
        "bd --global create --title t",
        "bd create --help",
        "bd list",
      ])
        expect(createLedgerWarning(command, repoA, env)).toBeUndefined()
    })

    test("follows export and unset BEADS_DIR earlier in the command", () => {
      const own = { BEADS_DIR: join(repoA, ".beads") }
      expect(createLedgerWarning(`export BEADS_DIR=${join(repoB, ".beads")}; bd create --title t`, repoA, own)).toContain(
        "belongs to",
      )
      const other = { BEADS_DIR: join(repoB, ".beads") }
      expect(createLedgerWarning("unset BEADS_DIR; bd create --title t", repoA, other)).toBeUndefined()
    })
  })

  test("runs an embedded write under the runner and keeps the actor prefix outermost", async () => {
    const decision = await decideShell("bd update proj-1 --claim", root, deps({ actor: "opencode/r/general/s" }))
    if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
    const held = realpathSync(store)
    // The store as named rides along for the runner's last check, whether or not it is canonical.
    expect(decision.command).toBe(
      `unset BEADS_ACTOR; export BD_ACTOR='opencode/r/general/s'; BEADS_DOLT_SHARED_SERVER= BEADS_DIR='${held}' '/opt/bun' '/opt/beads/src/bd-embedded-write-runner.ts' --beads-store '${held}' --beads-store-selected '${store}' --beads-wait-ms 30000 -- bd update proj-1 --claim`,
    )
  })

  test("leaves reads unwrapped", async () => {
    const decision = await decideShell("bd show proj-1 --json", root, deps())
    expect(decision).toEqual({ kind: "allow", command: "bd show proj-1 --json", advisories: [] })
  })

  test("a gate's verdict notice rides along once as an advisory", async () => {
    const gates = JSON.stringify([{ id: "proj-g1", await_type: "human", status: "open", description: "" }])
    const admitter = new GateAdmitter(async () => ({ output: gates }))
    const first = await decideShell("bd update proj-1 --claim", root, deps({ actor: "a/b/c", admitter }))
    if (first.kind !== "allow") throw new Error(JSON.stringify(first))
    expect(first.advisories.join("\n")).toContain("1 open beads gate(s)")
    const second = await decideShell("bd update proj-2 --claim", root, deps({ actor: "a/b/c", admitter }))
    expect(second.kind === "allow" ? second.advisories : ["x"]).toEqual([])
  })

  test("admission refuses while gates cannot be verified", async () => {
    const admitter = new GateAdmitter(async () => ({ failure: "store locked" }))
    const decision = await decideShell("bd update proj-1 --claim", root, deps({ actor: "a/b/c", admitter }))
    expect(decision).toMatchObject({ kind: "block", gate: "beads-gate-admission" })
  })
})

describe("helpers", () => {
  test("hasBdEdit finds bd edit, also nested, and skips help", () => {
    expect(hasBdEdit(parse("bd edit proj-1") as never)).toBe(true)
    expect(hasBdEdit(parse("echo $(bd edit proj-1)") as never)).toBe(true)
    expect(hasBdEdit(parse("bd edit --help") as never)).toBe(false)
    expect(hasBdEdit(parse("echo bd edit") as never)).toBe(false)
  })

  test("withActorPrefix quotes the actor", () => {
    expect(withActorPrefix("bd list", "it's")).toBe("unset BEADS_ACTOR; export BD_ACTOR='it'\\''s'; bd list")
  })
})

describe("a close after the command changes its store", () => {
  // Ledger A holds proj-1 as a task; ledger B holds it as a gate. The write lands in B.
  let root = ""
  let repoA = ""
  let repoB = ""
  const lookups: { store: string; argv: string[] }[] = []
  const admitted: string[] = []
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-close-target-")))
    repoA = join(root, "repo-a")
    repoB = join(root, "repo-b")
    for (const repo of [repoA, repoB]) {
      mkdirSync(join(repo, ".beads"), { recursive: true })
      writeFileSync(join(repo, ".beads", "metadata.json"), "{}")
      execFileSync("git", ["init", "-q", repo])
    }
    setBdShowRunForTests((argv, cwd, _deadline, env) => {
      // bd opens BEADS_DIR when it is set, else the ledger of the directory it runs in.
      const store = env?.BEADS_DIR ? env.BEADS_DIR : join(cwd, ".beads")
      lookups.push({ store, argv })
      const type = store === join(repoB, ".beads") ? "gate" : "task"
      return { exitCode: 0, stdout: JSON.stringify([{ id: "proj-1", issue_type: type }]) }
    })
  })
  afterAll(() => {
    setBdShowRunForTests(null)
    rmSync(root, { recursive: true, force: true })
  })

  const admitter = {
    admit: async (cwd: string, env: NodeJS.ProcessEnv) => {
      admitted.push(env.BEADS_DIR ? env.BEADS_DIR : join(cwd, ".beads"))
      return undefined
    },
    verify: () => undefined,
  } as unknown as GateAdmitter

  test.each([
    ["an export", (a: string, b: string): [string, string, string] => [`export BEADS_DIR=${b}/.beads; bd close proj-1`, a, `${a}/.beads`]],
    ["a cd into the other repository", (a: string, b: string): [string, string, string] => [`cd ${b} && bd close proj-1`, a, ""]],
    ["an unset", (a: string, b: string): [string, string, string] => ["unset BEADS_DIR; bd close proj-1", b, `${a}/.beads`]],
  ] as const)("after %s, the lookup and admission read the store the write targets", async (_case, shape) => {
    const [command, cwd, ambient] = shape(repoA, repoB)
    lookups.length = 0
    admitted.length = 0
    const decision = await decideShell(
      command,
      cwd,
      gateDeps({
        admitter,
        options: { gates: { "bd-embedded-write-lock": false } },
        env: { PATH: process.env.PATH, BEADS_DIR: ambient },
      }),
    )
    expect(lookups.map((lookup) => lookup.store)).toEqual([join(repoB, ".beads")])
    expect(admitted).toEqual([join(repoB, ".beads")])
    expect(decision.kind).toBe("block")
  })

  test("a close whose store the shell picks at run time is refused", async () => {
    const decision = await decideShell(
      "export BEADS_DIR=$OTHER; bd close proj-1",
      repoA,
      gateDeps({
        admitter,
        options: { gates: { "bd-embedded-write-lock": false, "beads-gate-admission": false } },
        env: { PATH: process.env.PATH, BEADS_DIR: `${repoA}/.beads` },
      }),
    )
    expect(decision).toMatchObject({ kind: "block", gate: "bd-close-gate", cause: expect.stringMatching(/run time/) })
  })
})

describe("a write whose store is not settled when it is checked", () => {
  // Ledgers A and B are embedded stores; `bare` has no ledger at all.
  let root = ""
  let storeA = ""
  let storeB = ""
  let bare = ""
  const admitter = { admit: async () => undefined, verify: () => undefined } as unknown as GateAdmitter
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "beads-unsettled-")))
    storeA = join(root, "a", ".beads")
    storeB = join(root, "b", ".beads")
    bare = join(root, "bare")
    for (const store of [storeA, storeB]) {
      mkdirSync(store, { recursive: true })
      writeFileSync(join(store, "metadata.json"), "{}")
    }
    mkdirSync(bare)
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const realRunner = () => ({ interpreter: process.execPath, script: join(import.meta.dir, "bd-embedded-write-runner.ts") })

  test("a store link that moves from A to B between the check and the run is refused", async () => {
    const link = join(root, "link")
    symlinkSync(storeA, link)
    const bin = join(root, "bin")
    const ran = join(root, "bd-ran")
    mkdirSync(bin)
    writeExecutable(join(bin, "bd"), `#!/bin/sh\nprintf '%s' "$BEADS_DIR" > ${JSON.stringify(ran)}\n`)
    const env = { PATH: `${bin}:${process.env.PATH}`, BEADS_DIR: link }
    const decision = await decideShell(
      "bd update proj-1 --status open",
      bare,
      gateDeps({ admitter, env, runnerLookup: realRunner, options: { gates: { "beads-gate-admission": false } } }),
    )
    if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
    rmSync(link)
    symlinkSync(storeB, link)
    const run = Bun.spawnSync(["/bin/sh", "-c", decision.command], { cwd: bare, env, stdout: "pipe", stderr: "pipe" })
    expect(existsSync(ran)).toBe(false)
    expect(run.exitCode).not.toBe(0)
    expect(run.stderr.toString()).toContain(link)
  })

  test("a canonical store directory that becomes a link to another store before the run is refused", async () => {
    const repo = join(root, "swap")
    const store = join(repo, ".beads")
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, "metadata.json"), "{}")
    const bin = join(root, "swap-bin")
    const ran = join(root, "swap-bd-ran")
    mkdirSync(bin)
    writeExecutable(join(bin, "bd"), `#!/bin/sh\nprintf '%s' "$BEADS_DIR" > ${JSON.stringify(ran)}\n`)
    const env = { PATH: `${bin}:${process.env.PATH}`, BEADS_DIR: store }
    const decision = await decideShell(
      "bd update proj-1 --status open",
      bare,
      gateDeps({ admitter, env, runnerLookup: realRunner, options: { gates: { "beads-gate-admission": false } } }),
    )
    if (decision.kind !== "allow") throw new Error(JSON.stringify(decision))
    renameSync(store, join(repo, ".beads-checked"))
    symlinkSync(storeB, store)
    const run = Bun.spawnSync(["/bin/sh", "-c", decision.command], { cwd: bare, env, stdout: "pipe", stderr: "pipe" })
    expect(existsSync(ran)).toBe(false)
    expect(run.exitCode).toBe(120)
  })

  test("a close is looked up at the store's real path, the one the write runs in", async () => {
    const link = join(root, "close-link")
    symlinkSync(storeA, link)
    const stores: (string | undefined)[] = []
    setBdShowRunForTests((_argv, _cwd, _deadline, env) => {
      stores.push(env?.BEADS_DIR)
      return { exitCode: 0, stdout: JSON.stringify([{ id: "proj-1", issue_type: "task" }]) }
    })
    try {
      await decideShell("bd close proj-1", bare, gateDeps({ admitter, env: { PATH: process.env.PATH, BEADS_DIR: link } }))
    } finally {
      setBdShowRunForTests(null)
    }
    expect(stores).toEqual([storeA])
  })

  test.each([
    ["a run-time export, with no store in reach", "export BEADS_DIR=$X; bd update proj-1 --status open"],
    ["an export behind &&", `false && export BEADS_DIR=<B>; bd update proj-1 --status open`],
    ["an export behind ||", `true || export BEADS_DIR=<B>; bd update proj-1 --status open`],
    ["an export inside if", `if false; then export BEADS_DIR=<B>; fi; bd update proj-1 --status open`],
  ])("a write after %s is refused", async (_case, shape) => {
    const command = shape.replace("<B>", storeB)
    for (const admission of [true, false]) {
      const decision = await decideShell(
        command,
        bare,
        gateDeps({
          admitter,
          env: { PATH: process.env.PATH },
          runnerLookup: realRunner,
          options: { gates: { "beads-gate-admission": admission } },
        }),
      )
      expect(decision.kind).toBe("block")
    }
  })

  test("a read after an export behind && runs as written", async () => {
    const command = `false && export BEADS_DIR=${storeB}; bd show proj-1`
    const decision = await decideShell(command, bare, gateDeps({ admitter, env: { PATH: process.env.PATH } }))
    expect(decision).toMatchObject({ kind: "allow", command })
  })
})
