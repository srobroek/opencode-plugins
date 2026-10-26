import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  collectCommands,
  decideMergePolicy,
  MERGE_POLICY_REFUSAL,
  type Probe,
  type Probes,
  parseMergeInvocation,
  spawnProbe,
} from "./merge-gate.ts"

const git =
  (defaultBranch: string | null, currentBranch: string | null = "worker"): Probe =>
  async (args) =>
    args[0] === "branch" ? currentBranch : defaultBranch ? `origin/${defaultBranch}` : null
const wt =
  (branch: string | null): Probe =>
  async () =>
    branch
const probes = (gitProbe: Probe, wtProbe: Probe = wt(null)): Probes => ({ git: gitProbe, wt: wtProbe })
const decide = (command: string, p: Probes = probes(git("main"))) => decideMergePolicy(command, "/repo", p)
const refusal = (target: string) => ({ block: true as const, reason: MERGE_POLICY_REFUSAL.replace("<target>", target) })

describe("parseMergeInvocation", () => {
  test("reads target, flags and -C", () => {
    expect(parseMergeInvocation(["wt", "-C", "sub", "-v", "merge", "develop", "--no-squash", "--stage", "tracked"])).toEqual({
      target: "develop",
      noSquash: true,
      noFf: false,
      workdir: "sub",
    })
  })
  test("ignores other subcommands and help", () => {
    expect(parseMergeInvocation(["wt", "list"])).toBeNull()
    expect(parseMergeInvocation(["wt", "merge", "--help"])).toBeNull()
    expect(parseMergeInvocation(["git", "merge", "develop"])).toBeNull()
  })
})

describe("collectCommands", () => {
  test("drops wrappers and reads nested bodies", () => {
    const { commands } = collectCommands('sudo -u me wt merge a; echo "$(wt merge b)"; bash -c "wt merge c"')
    expect(commands.map((argv) => argv.join(" "))).toEqual([
      "wt merge a",
      'echo $(wt merge b)',
      "bash -c wt merge c",
      "wt merge c",
      "wt merge b",
    ])
  })
})

describe("merge policy", () => {
  test("blocks opaque dynamic bodies with literal merge and land commands", async () => {
    for (const command of [
      'cmd="wt merge develop"; eval "$cmd"',
      'cmd="wt merge develop"; bash -c "$cmd"',
      'cmd="wt merge develop"; echo "$( $cmd )"',
      'cmd="wt merge develop"; echo <($cmd)',
      'cmd="wt merge develop"; eval "echo $cmd"',
      'cmd="git merge develop"; eval "$cmd"',
      'cmd="gh pr merge 123"; eval "$cmd"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
      'cmd="wt merge develop"; ${cmd}',
    ]) {
      expect((await decide(command))?.block, command).toBe(true)
    }
  })

  test("allows opaque dynamic bodies for ordinary literal commands", async () => {
    expect(await decide('cmd="echo ready"; eval "$cmd"')).toBeUndefined()
    expect(await decide('cmd="wt merge develop"; echo "$cmd"')).toBeUndefined()
  })

  test("blocks a non-default target without both history flags", async () => {
    expect(await decide("wt merge develop")).toEqual({
      block: true,
      reason: "worker-to-epic merges must preserve history; retry with wt merge develop --no-squash --no-ff",
    })
  })

  test("blocks when either required flag is missing", async () => {
    expect(await decide("wt merge develop --no-squash")).toEqual(refusal("develop"))
    expect(await decide("wt merge develop --no-ff")).toEqual(refusal("develop"))
  })

  test("allows a non-default target with both flags", async () => {
    expect(await decide("wt merge develop --no-squash --no-ff")).toBeUndefined()
  })

  test("refuses a worker merge launched from the target worktree", async () => {
    const result = await decide("wt merge develop --no-squash --no-ff", probes(git("main", "develop")))
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain("run from the source worktree")
  })

  test("refuses when the current branch cannot be read (detached HEAD)", async () => {
    expect((await decide("wt merge develop --no-squash --no-ff", probes(git("main", ""))))?.block).toBe(true)
  })

  test("a failed branch probe names the probe, not the source worktree", async () => {
    const result = await decide("wt merge orc/epic --no-squash --no-ff", probes(git("main", null)))
    expect(result?.reason).toContain("git branch --show-current")
    expect(result?.reason).not.toContain("must run from the source worktree")
  })

  test("allows a flagged merge from a worker branch and a main-to-epic refresh", async () => {
    expect(await decide("wt merge develop --no-squash --no-ff", probes(git("main", "worker")))).toBeUndefined()
    expect(await decide("wt merge develop --no-squash --no-ff", probes(git("main", "main")))).toBeUndefined()
  })

  test("reads the current branch in the -C directory", async () => {
    const seen: Array<[string, string]> = []
    const runner: Probe = async (args, cwd) => {
      seen.push([args[0] ?? "", cwd])
      return args[0] === "branch" ? "worker" : "origin/main"
    }
    expect(await decide("wt -C sub merge develop --no-squash --no-ff", probes(runner))).toBeUndefined()
    expect(seen).toContainEqual(["branch", "/repo/sub"])
  })

  test("resolves a leading cd before the merge", async () => {
    const seen: string[] = []
    const runner: Probe = async (args, cwd) => {
      seen.push(cwd)
      return args[0] === "branch" ? "worker" : "origin/main"
    }
    expect(await decide("cd /wt/worker && wt merge develop --no-squash --no-ff", probes(runner))).toBeUndefined()
    expect(seen).toContain("/wt/worker")
  })

  test("allows default-target and omitted-target merges", async () => {
    expect(await decide("wt merge main")).toBeUndefined()
    expect(await decide("wt merge")).toBeUndefined()
  })

  test("uses the Worktrunk default branch before origin/HEAD", async () => {
    expect(await decide("wt merge fixture-base --no-squash --no-ff", probes(git(null), wt("fixture-base")))).toBeUndefined()
    expect((await decide("wt merge develop", probes(git(null), wt("fixture-base"))))?.block).toBe(true)
  })

  test("fails closed when both default branch lookups fail for an explicit target", async () => {
    const result = await decide("wt merge develop --no-squash --no-ff", probes(git(null)))
    expect(result?.block).toBe(true)
    expect(result?.reason).toContain("cannot determine the repository default branch")
  })

  test("allows omitted target when both default branch lookups fail", async () => {
    expect(await decide("wt merge", probes(git(null)))).toBeUndefined()
  })

  test("does not treat merge help as a merge", async () => {
    expect(await decide("wt merge --help", probes(git(null)))).toBeUndefined()
    expect(await decide("wt merge -h", probes(git(null)))).toBeUndefined()
  })

  test("finds compound and absolute-path invocations, but ignores git merge", async () => {
    expect((await decide("echo ready && /opt/wt merge develop"))?.reason).toContain("wt merge develop --no-squash --no-ff")
    expect(await decide("git merge develop")).toBeUndefined()
    expect(await decide("git commit -m 'wt merge develop'")).toBeUndefined()
  })

  test("inspects executable command substitutions and backticks", async () => {
    for (const command of [
      'echo "$(wt merge develop)"',
      "echo $(wt merge develop)",
      "echo `wt merge develop`",
      'echo "`wt merge develop`"',
      'bash -c "wt merge develop"',
      "sh -c 'wt merge develop'",
      'zsh -c "wt merge develop"',
      'dash -c "wt merge develop"',
      'ksh -c "wt merge develop"',
      'eval "wt merge develop"',
      "echo <(wt merge develop)",
      "echo >(wt merge develop)",
    ]) {
      expect((await decide(command))?.reason, command).toContain("wt merge develop --no-squash --no-ff")
    }
    for (const command of [
      "echo '\\$(wt merge develop)'",
      'echo "$(wt merge develop --no-squash --no-ff)"',
      "echo '$(wt merge develop)'",
      'bash -c "wt merge develop --no-squash --no-ff"',
      'eval "wt merge develop --no-squash --no-ff"',
      "echo <(wt merge develop --no-squash --no-ff)",
      'echo "`wt merge develop --no-squash --no-ff`"',
    ]) {
      expect(await decide(command), command).toBeUndefined()
    }
  })

  test("sees merges behind global options and resolves the default branch in -C", async () => {
    const seen: string[] = []
    const runner: Probe = async (_args, cwd) => {
      seen.push(cwd)
      return "origin/main"
    }
    const wtRunner: Probe = async (_args, cwd) => {
      seen.push(cwd)
      return null
    }
    expect((await decide("wt -C sub -v merge develop", probes(runner, wtRunner)))?.reason).toContain(
      "wt merge develop --no-squash --no-ff",
    )
    expect(seen).toEqual(["/repo/sub", "/repo/sub"])
    expect(await decide("wt --config /c.toml merge develop --no-squash --no-ff", probes(runner, wtRunner))).toBeUndefined()
  })

  test("preserves a block through whitespace and transparent wrappers", async () => {
    for (const command of [
      "wt merge develop",
      "  wt  merge  develop  ",
      "command wt merge develop",
      "env wt merge develop",
      "env FOO=1 timeout 5 wt merge develop",
      "(wt merge develop)",
      "{ wt merge develop; }",
      "echo $(wt merge develop)",
    ]) {
      expect((await decide(command))?.block, command).toBe(true)
    }
  })

  test("fails closed on an unterminated command that names wt merge", async () => {
    expect((await decide('wt merge develop "unterminated'))?.block).toBe(true)
    expect(await decide('echo "unterminated')).toBeUndefined()
  })

  test("never throws for malformed input", async () => {
    let state = 0x13579bdf
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    const alphabet = "wt merge develop --no-squash --no-ff ;|&()$\\\"'`\n<>{}="
    const started = performance.now()
    for (let iteration = 0; iteration < 2000; iteration++) {
      let value = ""
      const length = random() % 100
      for (let i = 0; i < length; i++) value += alphabet[random() % alphabet.length] ?? ""
      await decide(value)
    }
    expect(performance.now() - started).toBeLessThan(5_000)
  })
})

describe("probe bounds", () => {
  const bin = mkdtempSync(join(tmpdir(), "merge-gate-hang-"))
  const hang = join(bin, "hang")
  writeFileSync(hang, "#!/bin/sh\nexec sleep 30\n")
  chmodSync(hang, 0o755)
  afterAll(() => rmSync(bin, { recursive: true, force: true }))

  test("spawnProbe throws ProbeTimeout when the signal aborts", async () => {
    const started = Date.now()
    await expect(spawnProbe(hang, [], bin, AbortSignal.timeout(200))).rejects.toThrow(hang)
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  test("spawnProbe returns stdout on success and null on failure or a missing binary", async () => {
    expect(await spawnProbe("sh", ["-c", "echo ' main '"], bin, new AbortController().signal)).toBe("main")
    expect(await spawnProbe("sh", ["-c", "exit 1"], bin, new AbortController().signal)).toBeNull()
    expect(await spawnProbe(join(bin, "missing"), [], bin, new AbortController().signal)).toBeNull()
  })

  test("bounds every probe by one budget and names the timeout", async () => {
    const hanging: Probe = (args, cwd, signal) => spawnProbe(hang, args, cwd, signal)
    const started = Date.now()
    const decision = await decideMergePolicy("wt merge orc/epic --no-squash --no-ff", bin, probes(hanging, hanging), {
      timeoutMs: 300,
      budgetMs: 500,
    })
    expect(decision?.block).toBe(true)
    expect(decision?.reason).toContain("timed out")
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("a probe that ignores its signal still times out", async () => {
    const stuck: Probe = () => new Promise(() => {})
    const decision = await decideMergePolicy("wt merge orc/epic --no-squash --no-ff", "/repo", probes(stuck, stuck), {
      timeoutMs: 100,
      budgetMs: 1_000,
    })
    expect(decision?.reason).toContain("`wt config state default-branch` timed out")
  })
})
