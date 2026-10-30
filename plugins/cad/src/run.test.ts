import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  DEFAULT_TIMEOUT_S,
  formatRun,
  MAX_TIMEOUT_S,
  READY_TIMEOUT_S,
  readRunParams,
  resolveScript,
  runArgv,
  runBackground,
  runEnv,
  STDOUT_LIMIT,
  stopJob,
  viewerSessionName,
  viewerStopArgs,
} from "./run.ts"

const scratch: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "cad-run-"))
  scratch.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
})

describe("readRunParams", () => {
  test("defaults the timeout per mode and caps it", () => {
    expect(readRunParams({ script: " cad-model/scripts/cad_model.py " })).toEqual({
      script: "cad-model/scripts/cad_model.py",
      args: [],
      timeoutSeconds: DEFAULT_TIMEOUT_S,
      background: false,
    })
    expect(readRunParams({ script: "x.py", background: true })).toMatchObject({ timeoutSeconds: READY_TIMEOUT_S })
    expect(readRunParams({ script: "x.py", timeout: 99_999 })).toMatchObject({ timeoutSeconds: MAX_TIMEOUT_S })
  })

  test("rejects malformed input", () => {
    expect(readRunParams({})).toBeString()
    expect(readRunParams({ script: "x.py", args: "run" })).toBeString()
    expect(readRunParams({ script: "x.py", timeout: 0 })).toBeString()
    expect(readRunParams({ script: "x.py", background: "yes" })).toBeString()
  })
})

describe("resolveScript", () => {
  const skills = temp()
  mkdirSync(join(skills, "cad-flow", "scripts"), { recursive: true })
  writeFileSync(join(skills, "cad-flow", "scripts", "run.py"), "")
  writeFileSync(join(skills, "cad-flow", "SKILL.md"), "")
  const outside = temp()
  writeFileSync(join(outside, "evil.py"), "")
  symlinkSync(join(outside, "evil.py"), join(skills, "cad-flow", "scripts", "link.py"))

  test("returns the slash-separated path relative to the skills directory", () => {
    expect(resolveScript(skills, "cad-flow/scripts/run.py")).toBe("cad-flow/scripts/run.py")
    expect(resolveScript(skills, join(skills, "cad-flow/scripts/run.py"))).toBe("cad-flow/scripts/run.py")
  })

  test("refuses paths outside, through a symlink, non-Python and missing scripts", () => {
    for (const script of [
      "../x.py",
      join(outside, "evil.py"),
      "cad-flow/scripts/link.py",
      "cad-flow/SKILL.md",
      "cad-flow/scripts/none.py",
      ".",
    ])
      expect(resolveScript(skills, script)).toHaveProperty("error")
  })
})

test("runArgv, runEnv and the viewer helpers", () => {
  expect(runArgv("/p/skills", "cad-bom/scripts/bom.py", ["a.step"])).toEqual([
    "uv",
    "run",
    "--script",
    "/p/skills/cad-flow/scripts/run.py",
    "cad-bom/scripts/bom.py",
    "a.step",
  ])
  const env = runEnv({ PATH: "/bin", GONE: undefined }, "ses_1", "srobroek.cad /p")
  expect(env).toEqual({ PATH: "/bin", CAD_SESSION_ID: "ses_1", CAD_OPENCODE_PLUGIN: "srobroek.cad /p" })
  expect(viewerSessionName(["serve"])).toBe("")
  expect(viewerSessionName(["serve", "--session", "a"])).toBe("a")
  expect(viewerSessionName(["serve", "--session=b"])).toBe("b")
  expect(viewerStopArgs("")).toEqual(["stop"])
  expect(viewerStopArgs("a")).toEqual(["stop", "--session", "a"])
})

describe("formatRun", () => {
  test("reports the exit, stdout and a stderr tail; only exit 0 is ok", () => {
    const pass = formatRun("x.py", { kind: "exited", exitCode: 0, signalCode: null, stdout: "{}\n", stderr: "uv: done\n" }, 1.25, temp)
    expect(pass).toMatchObject({ ok: true, exitCode: 0, status: "exited" })
    expect(pass.text).toBe("cad_run x.py: exit 0 after 1.3 s\n{}\nstderr:\nuv: done")
    expect(formatRun("x.py", { kind: "exited", exitCode: 1, signalCode: null, stdout: "", stderr: "" }, 1, temp).ok).toBe(false)
    const timeout = formatRun("x.py", { kind: "timeout", stdout: "", stderr: "" }, 1200, temp)
    expect(timeout).toMatchObject({ ok: false, exitCode: null, status: "timeout" })
    expect(timeout.text).toContain("pass a longer timeout")
  })

  test("saves overlong output to a file and names it", () => {
    const dir = temp()
    const stdout = "x".repeat(STDOUT_LIMIT + 10)
    const result = formatRun("a/b.py", { kind: "exited", exitCode: 0, signalCode: null, stdout, stderr: "e".repeat(5000) }, 2, () => dir)
    const saved = result.text.match(/all of it is in (\S+)\]/)?.[1] as string
    expect(readFileSync(saved, "utf8")).toBe(stdout)
    expect(result.text).toContain("stderr (last 4000 characters")
  })
})

describe("runBackground", () => {
  const options = (dir: string) => ({ cwd: dir, env: {}, script: "cad-concept/scripts/serve.py", timeoutSeconds: 1, dir })
  const noWait = async () => {}

  test("returns the first stdout line of a running script", async () => {
    const dir = temp()
    const result = await runBackground(
      ["uv"],
      options(dir),
      (_argv, { stdout }) => {
        writeFileSync(stdout, '{"url": "u"}\nmore\n')
        return { pid: 42 }
      },
      () => true,
      noWait,
    )
    expect(result).toMatchObject({ ok: true, firstLine: '{"url": "u"}', job: { pid: 42, script: "cad-concept/scripts/serve.py" } })
  })

  test("reports a script that exits first, and one that stays silent, which is still running", async () => {
    const dir = temp()
    const exited = await runBackground(
      ["uv"],
      options(dir),
      (_argv, { stderr }) => {
        writeFileSync(stderr, "boom\n")
        return { pid: 43 }
      },
      () => false,
      noWait,
    )
    expect(exited).toMatchObject({ ok: false })
    expect(exited.ok ? "" : exited.text).toContain("boom")
    expect("job" in exited && exited.job).toBeFalsy()
    const silent = await runBackground(["uv"], { ...options(dir), timeoutSeconds: 0.05 }, () => ({ pid: 44 }), () => true, () => Bun.sleep(10))
    expect(silent).toMatchObject({ ok: false, job: { pid: 44 } })
  })
})

test("stopJob reports a job that is already gone", async () => {
  expect(await stopJob(1, 0, () => false)).toBe("gone")
})
