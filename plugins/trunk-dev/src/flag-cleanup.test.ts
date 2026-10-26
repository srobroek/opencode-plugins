import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type BeadsRuntime,
  type CommandResult,
  createCleanup,
  DEFAULT_ACTOR,
  decideFlagCleanup,
  findRunner,
  flagCleanupFollowUp,
  landedMerge,
  mergedForgeData,
  shellMerges,
} from "./flag-cleanup.ts"

const flagTitle = "feat(api)!: add staged API"
const flagBody = "Flag: staged_api (default off; owner alice; remove by 2026-11-30)"
const links = { branch: "opencode/agent/proj-1234", url: "https://github.com/acme/repo/pull/7" }
const ledger = ["proj-1234", "omp-1", "bd-4321", "proj-9"].map((id) => ({ id, status: "in_progress" }))

describe("decideFlagCleanup", () => {
  test("creates a safe due-dated cleanup command for a valid flagged feature", () => {
    const decision = decideFlagCleanup(flagTitle, flagBody, ledger, links)
    expect(decision?.args.slice(0, 6)).toEqual([
      "create",
      "chore: remove feature flag staged_api",
      "--type",
      "chore",
      "--due",
      "2026-11-30",
    ])
    expect(decision?.command).toContain("bd create 'chore: remove feature flag staged_api'")
    expect(decision?.command).toContain("--type chore --due 2026-11-30")
    expect(decision?.command).toContain("--deps discovered-from:proj-1234")
    expect(decision?.command).toContain("--silent")
    expect(JSON.parse(decision?.args[7] ?? "")).toEqual({ trunk_dev_flag: "staged_api", pr: links.url })
  })

  test("reads the omp branch convention too", () => {
    expect(decideFlagCleanup(flagTitle, flagBody, ledger, { ...links, branch: "omp/agent/omp-1" })?.command).toContain(
      "discovered-from:omp-1",
    )
  })

  test("links only a bead the ledger has, so bd create --deps cannot fail on it", () => {
    const decision = decideFlagCleanup(flagTitle, flagBody, [], links)
    expect(decision?.command).not.toContain("--deps")
    expect(decision?.command).toContain("--silent")
  })

  test("does not make cleanup work for Flag none or non-features", () => {
    expect(decideFlagCleanup("feat: no flag", "Flag: none — no temporary flag", [], links)).toBeUndefined()
    expect(decideFlagCleanup("fix: repair", flagBody, [], links)).toBeUndefined()
  })

  test("rejects unsafe names, impossible dates, two Flag lines and a missing URL", () => {
    expect(decideFlagCleanup(flagTitle, flagBody.replace("staged_api", "bad name"), [], links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody.replace("2026-11-30", "2026-02-30"), [], links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody.replace("2026-11-30", "2026-1-30"), [], links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, `${flagBody}\nFlag: other`, [], links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody, [], { url: "not a url" })).toBeUndefined()
  })

  test("skips when a non-closed cleanup bead already exists", () => {
    const existing = [{ id: "cleanup", status: "in_progress", metadata: { trunk_dev_flag: "staged_api" } }]
    expect(decideFlagCleanup(flagTitle, flagBody, existing, links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody, [{ ...existing[0], status: "closed" }], links)).toBeDefined()
  })

  test("shell-quotes PR metadata and generated descriptions containing quotes", () => {
    const quoted = decideFlagCleanup(flagTitle, flagBody, [], { url: "https://github.com/acme/repo/pull/7?note=o'connor" })
    expect(quoted?.command).toContain("o'\\''connor")
    expect(quoted?.command).toContain("--metadata '")
  })

  test("uses a Bead trailer when the branch has no bead id, and an explicit bead over both", () => {
    expect(decideFlagCleanup(flagTitle, `${flagBody}\n\nBead: bd-4321`, ledger, { url: links.url })?.command).toContain(
      "discovered-from:bd-4321",
    )
    expect(decideFlagCleanup(flagTitle, flagBody, ledger, { ...links, bead: "proj-9" })?.command).toContain(
      "discovered-from:proj-9",
    )
  })

  test("an open hand-made cleanup bead for the same flag suppresses a duplicate", () => {
    const handMade = (title: string, status = "open") => [{ id: "sbx-ugk", status, title, metadata: {} }]
    expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove staged_api feature flag by 2026-11-30"), links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove `staged_api` flag"), links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove feature flag staged_api"), links)).toBeUndefined()
    expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove staged_api feature flag", "closed"), links)).toBeDefined()
    expect(decideFlagCleanup(flagTitle, flagBody, handMade("chore: remove staged_api_v2 feature flag"), links)).toBeDefined()
    expect(decideFlagCleanup(flagTitle, flagBody, handMade("feat: rename staged_api flag docs"), links)).toBeDefined()
  })

  test("a rollout PR that enables an existing flag creates no cleanup bead", () => {
    const body = "Flag: staged_api (enable; owner alice; remove by 2026-11-30)"
    expect(decideFlagCleanup("feat(cli): enable priorities for everyone", body, [], links)).toBeUndefined()
  })
})

describe("createCleanup", () => {
  const decision = decideFlagCleanup(flagTitle, flagBody, [], links)
  if (decision === undefined) throw new Error("expected a cleanup decision")
  const runner = { interpreter: "/usr/bin/bun", script: "/beads/dist/bd-embedded-write-runner.js" }

  test("runs bd under the beads runner with an explicit actor, a pinned store and no kill", async () => {
    let argv: string[] = []
    let env: NodeJS.ProcessEnv = {}
    let kill: boolean | undefined
    const result = await createCleanup(decision, "/repo/.beads", "/repo", { BEADS_ACTOR: "opencode/a" }, {
      findRunner: () => runner,
      run: async (cmd, _cwd, e, _timeout, k) => {
        argv = cmd
        env = e
        kill = k
        return { exitCode: 0, stdout: '{"id":"cleanup-1"}' }
      },
    })
    expect(argv.slice(0, 12)).toEqual([
      runner.interpreter,
      runner.script,
      "--beads-store",
      "/repo/.beads",
      "--beads-wait-ms",
      "5000",
      "--",
      "bd",
      "--json",
      "--actor",
      "opencode/a",
      "create",
    ])
    expect(env).toMatchObject({ BEADS_ACTOR: "opencode/a", BEADS_DIR: "/repo/.beads", BEADS_DOLT_SHARED_SERVER: "" })
    expect(kill).toBe(false)
    expect(result).toContain("created cleanup bead cleanup-1")
  })

  test("defaults the actor", async () => {
    let argv: string[] = []
    await createCleanup(decision, "/s", "/repo", {}, {
      findRunner: () => runner,
      run: async (cmd) => {
        argv = cmd
        return { exitCode: 0, stdout: "x-1\n" }
      },
    })
    expect(argv[10]).toBe(DEFAULT_ACTOR)
  })

  test("a write that outlives the wait reports pending instead of a retry command", async () => {
    const result = await createCleanup(decision, "/repo/.beads", "/repo", {}, {
      findRunner: () => runner,
      run: async () => ({ exitCode: -1, stdout: "", timedOut: true }),
    })
    expect(result).toContain("still being written")
    expect(result).not.toContain("bd create")
  })

  test("falls back to the exact command when no runner exists or the lock refuses", async () => {
    const missing = await createCleanup(decision, "/repo/.beads", "/repo", {}, {
      findRunner: () => undefined,
      run: async () => undefined,
    })
    expect(missing).toContain("BEADS_ACTOR=opencode/trunk-dev bd create 'chore: remove feature flag staged_api'")
    const locked = await createCleanup(decision, "/repo/.beads", "/repo", {}, {
      findRunner: () => runner,
      run: async () => ({ exitCode: 120, stdout: "" }),
    })
    expect(locked).toContain("bd create 'chore: remove feature flag staged_api'")
  })
})

describe("mergedForgeData", () => {
  const pr = { title: flagTitle, body: flagBody, url: links.url, headRefName: "opencode/agent/proj-1234" }
  test("only a completed merge yields data, so --auto merges that are still open create nothing", () => {
    expect(mergedForgeData(JSON.stringify({ ...pr, state: "OPEN" }), "gh")).toBeUndefined()
    expect(mergedForgeData(JSON.stringify(pr), "gh")).toBeUndefined()
    expect(mergedForgeData(JSON.stringify({ ...pr, state: "MERGED" }), "gh")).toEqual({
      title: flagTitle,
      body: flagBody,
      url: links.url,
      branch: "opencode/agent/proj-1234",
    })
    expect(mergedForgeData("{not json", "gh")).toBeUndefined()
  })

  test("reads GitLab description, web_url and source_branch", () => {
    const mr = {
      title: flagTitle,
      description: flagBody,
      web_url: "https://gitlab.example/acme/repo/-/merge_requests/7",
      source_branch: "feat/x",
      state: "merged",
    }
    expect(mergedForgeData(JSON.stringify(mr), "glab")).toMatchObject({ body: flagBody, branch: "feat/x" })
    expect(mergedForgeData(JSON.stringify({ ...mr, state: "opened" }), "glab")).toBeUndefined()
  })
})

describe("observed merges", () => {
  const dir = mkdtempSync(join(tmpdir(), "trunk-dev-land-"))
  test("a proved delivery_land output yields its request, forge, directory and bead", () => {
    const output = {
      ok: true,
      pr: 6,
      receipt: {
        repo: { forge: "github", canonicalRoot: dir },
        worktree: { path: "/gone" },
        beads: { ids: ["proj-6"] },
      },
    }
    expect(landedMerge(output, "/session")).toEqual({ forge: "gh", number: "6", cwd: dir, bead: "proj-6" })
    expect(landedMerge({ ...output, receipt: { ...output.receipt, repo: { forge: "gitlab" } } }, "/s")).toMatchObject({
      forge: "glab",
      cwd: "/s",
    })
  })

  test("refusals, unknown forges and malformed outputs yield nothing", () => {
    expect(landedMerge({ ok: false, reason: "x", mergeIssued: true }, "/s")).toBeUndefined()
    expect(landedMerge({ ok: true, pr: "x" }, "/s")).toBeUndefined()
    expect(landedMerge({ ok: true, pr: 1, receipt: { repo: { forge: "unknown" } } }, "/s")).toBeUndefined()
    expect(landedMerge(undefined, "/s")).toBeUndefined()
  })

  test("shell merges are literal gh pr merge / glab mr merge invocations", () => {
    expect(shellMerges("gh pr merge 12 --squash && glab mr merge 3", "/r")).toEqual([
      { forge: "gh", number: "12", cwd: "/r" },
      { forge: "glab", number: "3", cwd: "/r" },
    ])
    expect(shellMerges("echo 'gh pr merge 12'", "/r")).toEqual([])
    expect(shellMerges("gh pr merge $N", "/r")).toEqual([])
    expect(shellMerges("cd /x && gh pr merge 4", "/r")).toEqual([{ forge: "gh", number: "4", cwd: "/x" }])
  })
})

describe("flagCleanupFollowUp", () => {
  const repo = mkdtempSync(join(tmpdir(), "trunk-dev-repo-"))
  mkdirSync(join(repo, ".beads"))
  const merged = JSON.stringify({ title: flagTitle, body: flagBody, url: links.url, state: "MERGED", headRefName: "x" })

  function runtime(responses: Record<string, CommandResult | undefined>, calls: string[][] = []): BeadsRuntime {
    return {
      findRunner: () => ({ interpreter: "bun", script: "runner.js" }),
      run: async (cmd) => {
        calls.push(cmd)
        if (cmd[0] === "git" && cmd[2] === "--show-toplevel") return { exitCode: 0, stdout: `${repo}\n` }
        if (cmd[0] === "git") return { exitCode: 0, stdout: `${repo}/.git\n` }
        const key = cmd[0] === "bun" ? "write" : `${cmd[0]} ${cmd[1]} ${cmd[2]}`
        return responses[key]
      },
    }
  }

  test("reads the forge and the ledger, then writes one bead", async () => {
    const calls: string[][] = []
    const note = await flagCleanupFollowUp(
      [{ forge: "gh", number: "7", cwd: repo }],
      {},
      runtime(
        {
          "gh pr view": { exitCode: 0, stdout: merged },
          "bd --readonly list": { exitCode: 0, stdout: "[]" },
          write: { exitCode: 0, stdout: '{"id":"c-1"}' },
        },
        calls,
      ),
    )
    expect(note).toContain("created cleanup bead c-1")
    expect(calls.some((cmd) => cmd.join(" ").startsWith("gh pr view 7 --json title,body,url,state,headRefName"))).toBe(
      true,
    )
  })

  test("an unmerged request, a failed read or a repository without a store writes nothing", async () => {
    const open = merged.replace("MERGED", "OPEN")
    expect(
      await flagCleanupFollowUp(
        [{ forge: "gh", number: "7", cwd: repo }],
        {},
        runtime({ "gh pr view": { exitCode: 0, stdout: open }, "bd --readonly list": { exitCode: 0, stdout: "[]" } }),
      ),
    ).toBeUndefined()
    expect(
      await flagCleanupFollowUp(
        [{ forge: "gh", number: "7", cwd: repo }],
        {},
        runtime({ "gh pr view": undefined, "bd --readonly list": { exitCode: 0, stdout: "[]" } }),
      ),
    ).toBeUndefined()
    const bare = mkdtempSync(join(tmpdir(), "trunk-dev-bare-"))
    const none: BeadsRuntime = {
      findRunner: () => undefined,
      run: async (cmd) => ({ exitCode: 0, stdout: cmd[2] === "--show-toplevel" ? bare : `${bare}/.git` }),
    }
    expect(await flagCleanupFollowUp([{ forge: "gh", number: "7", cwd: bare }], {}, none)).toBeUndefined()
  })
})

describe("findRunner", () => {
  test("finds the beads plugin's runner from this plugin's dist directory in the repository", () => {
    const found = findRunner(join(import.meta.dir, "..", "dist"))
    expect(found?.script).toBe(join(import.meta.dir, "..", "..", "beads", "dist", "bd-embedded-write-runner.js"))
  })
})

describe("templates", () => {
  test("ship the stale-bead-branches job for both forges", () => {
    for (const name of ["stale-branches.github.yml", "stale-branches.gitlab-ci.yml"]) {
      const text = readFileSync(join(import.meta.dir, "..", "skills", "trunk-dev-release-setup", "templates", name), "utf8")
      expect(text).toMatch(/^\s*stale-bead-branches\s*:/m)
    }
  })
})
