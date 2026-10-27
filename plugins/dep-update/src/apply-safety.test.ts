import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyBump, checkNodeVersion } from "./bump.ts"

/** What one package-manager stub does: record its argv, write files, print, then hang or exit. */
type Behaviour = {
  marker?: string
  pidFile?: string
  /** Prepended to the recorded argv, naming which manager ran. */
  label?: string
  write?: Array<[string, string]>
  stdout?: string
  hang?: boolean
  exit?: number
}

/**
 * One executable for every package-manager stub in this file. macOS can hold the first
 * exec of a freshly written executable for a second or more (a policy scan), and each
 * test used to write several; now each name is a symlink to this one file, which pays
 * that once. The shell wrapper passes the name it was run as (`$0`) to a script bun
 * reads rather than execs, and the behaviour comes from `<name>.json` beside it.
 */
const STUB_HOME = mkdtempSync(join(tmpdir(), "dep-apply-stub-"))
const STUB = join(STUB_HOME, "stub")
const STUB_SCRIPT = join(STUB_HOME, "stub.mjs")
writeFileSync(
  STUB_SCRIPT,
  `import { readFileSync, writeFileSync } from "node:fs"
const [self, ...args] = process.argv.slice(2)
const behaviour = JSON.parse(readFileSync(self + ".json", "utf8"))
if (behaviour.pidFile) writeFileSync(behaviour.pidFile, String(process.pid))
if (behaviour.marker) writeFileSync(behaviour.marker, JSON.stringify(behaviour.label ? [behaviour.label, ...args] : args))
for (const [path, content] of behaviour.write ?? []) writeFileSync(path, content)
if (behaviour.stdout) process.stdout.write(behaviour.stdout)
if (behaviour.hang) setInterval(() => {}, 1000)
else process.exitCode = behaviour.exit ?? 0
`,
)
writeFileSync(STUB, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STUB_SCRIPT)} "$0" "$@"\n`)
chmodSync(STUB, 0o755)
afterAll(() => rmSync(STUB_HOME, { recursive: true, force: true }))

/** Put a package manager named `name` in `bin` that does `behaviour`. */
function stubManager(bin: string, name: string, behaviour: Behaviour): void {
  const path = join(bin, name)
  if (!existsSync(path)) symlinkSync(STUB, path)
  writeFileSync(`${path}.json`, JSON.stringify(behaviour))
}

test("checkNodeVersion reads own manifest keys only", async () => {
  const root = mkdtempSync(join(tmpdir(), "dep-shape-"))
  try {
    writeFileSync(
      join(root, "package.json"),
      '{"dependencies":{"constructor":"1.0.0","__proto__":"2.0.0"},"devDependencies":["invalid"]}',
    )
    expect(await checkNodeVersion(root, "constructor", "1.0.0")).toBe(true)
    expect(await checkNodeVersion(root, "toString", "1.0.0")).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("apply rejects options, honors cancellation, bounds children/output, and pins scoped npm operands", async () => {
  const root = mkdtempSync(join(tmpdir(), "dep-apply-safe-"))
  const oldPath = process.env.PATH
  // Real processes and inherited pipes require the platform clock, not fake JS timers.
  const oldPm = process.env.DEP_UPDATE_PKG_MANAGER
  const marker = join(root, "spawned")
  const pidFile = join(root, "pid")
  const installStub = (behaviour: Behaviour) => stubManager(root, "pnpm", { marker, ...behaviour })
  try {
    process.env.PATH = root
    process.env.DEP_UPDATE_PKG_MANAGER = "pnpm"
    installStub({ hang: true, pidFile })
    for (const [ecosystem, name, version] of [
      ["npm", "--help", "1.0.0"],
      ["npm", "x", "--recursive"],
      ["pypi", "-r", "1.0.0"],
      ["npm", "x", "file:/tmp/x"],
    ] as Array<[string, string, string]>) {
      expect((await applyBump(ecosystem, name, version, root)).exit).toBe(2)
    }
    const cancelled = new AbortController()
    cancelled.abort()
    expect((await applyBump("npm", "x", "1.0.0", root, { signal: cancelled.signal })).exit).toBe(1)
    expect(existsSync(marker)).toBe(false)
    // Fire the injected deadline only after the child has started. Scheduler or
    // executable-policy latency is not the package-manager timeout contract.
    const whenStarted = (callback: () => void) => {
      const timer = setInterval(() => {
        if (!existsSync(marker)) return
        clearInterval(timer)
        callback()
      }, 10)
      return timer
    }
    const timed = await applyBump("npm", "x", "1.0.0", root, {
      timeoutMs: 100,
      setTimeout: (callback, ms) => ms === 100 ? whenStarted(callback) : setTimeout(callback, ms),
    })
    expect(timed.exit).toBe(1)
    expect(timed.text).toContain("deadline exceeded")
    expect(timed.text).toContain("partial")
    expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow()

    const controller = new AbortController()
    rmSync(marker)
    const timer = whenStarted(() => controller.abort())
    try {
      const aborted = await applyBump("npm", "x", "1.0.0", root, { signal: controller.signal })
      expect(aborted.exit).toBe(1)
      expect(aborted.text).toContain("Cancelled")
      expect(() => process.kill(Number(readFileSync(pidFile, "utf8")), 0)).toThrow()
    } finally {
      clearTimeout(timer)
    }

    installStub({ stdout: "x".repeat(100000), hang: true })
    const loud = await applyBump("npm", "x", "1.0.0", root, { maxOutputBytes: 512 })
    expect(loud.exit).toBe(1)
    expect(loud.text).toContain("output limit exceeded")
    expect(loud.text.length).toBeLessThan(1500)

    installStub({ write: [["package.json", JSON.stringify({ dependencies: { "@scope/pkg": "1.2.3" } })]] })
    const success = await applyBump("npm", "@scope/pkg", "1.2.3", root)
    expect(success.exit).toBe(0)
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["update", "@scope/pkg@1.2.3"])
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPm === undefined) delete process.env.DEP_UPDATE_PKG_MANAGER
    else process.env.DEP_UPDATE_PKG_MANAGER = oldPm
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)

test("the package-manager bound is sized for a real install, not a 25 s tool_call budget", async () => {
  // A registered tool's execute has no harness deadline, so a caller-sized bound is
  // honoured as given and the default leaves ten minutes for an install.
  const root = mkdtempSync(join(tmpdir(), "dep-apply-bound-"))
  const oldPath = process.env.PATH
  const oldPm = process.env.DEP_UPDATE_PKG_MANAGER
  stubManager(root, "pnpm", { write: [["package.json", JSON.stringify({ dependencies: { x: "1.0.0" } })]] })
  const scheduled: number[] = []
  const schedule = (callback: () => void, ms: number) => {
    scheduled.push(ms)
    return setTimeout(callback, ms)
  }
  try {
    process.env.PATH = root
    process.env.DEP_UPDATE_PKG_MANAGER = "pnpm"
    expect((await applyBump("npm", "x", "1.0.0", root, { setTimeout: schedule })).exit).toBe(0)
    expect((await applyBump("npm", "x", "1.0.0", root, { setTimeout: schedule, timeoutMs: 120_000 })).exit).toBe(0)
    expect(scheduled).toEqual([600_000, 120_000])
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPm === undefined) delete process.env.DEP_UPDATE_PKG_MANAGER
    else process.env.DEP_UPDATE_PKG_MANAGER = oldPm
    rmSync(root, { recursive: true, force: true })
  }
}, 10000)

test("apply reports missing package managers as failures", async () => {
  const root = mkdtempSync(join(tmpdir(), "dep-apply-missing-pm-"))
  const oldPath = process.env.PATH
  const oldPm = process.env.DEP_UPDATE_PKG_MANAGER
  try {
    process.env.PATH = root
    process.env.DEP_UPDATE_PKG_MANAGER = "pnpm"
    const nodeResult = await applyBump("npm", "example", "1.0.0", root)
    expect(nodeResult.exit).toBe(1)
    expect(nodeResult.text).toContain("pnpm not found")
    delete process.env.DEP_UPDATE_PKG_MANAGER
    writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "app"\ndependencies = []\n')
    const pythonResult = await applyBump("pypi", "example", "1.0.0", root)
    expect(pythonResult.exit).toBe(1)
    expect(pythonResult.text).toContain("uv not found")
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPm === undefined) delete process.env.DEP_UPDATE_PKG_MANAGER
    else process.env.DEP_UPDATE_PKG_MANAGER = oldPm
    rmSync(root, { recursive: true, force: true })
  }
})

test("Python bumps route by project: poetry, uv with or without a lock, requirements-only is manual", async () => {
  const root = mkdtempSync(join(tmpdir(), "dep-apply-python-"))
  const bin = mkdtempSync(join(tmpdir(), "dep-apply-bin-"))
  const oldPath = process.env.PATH
  const marker = join(bin, "argv.json")
  // Each stub records its argv and writes the pin the real manager would write.
  const stub = (pm: string, pin: string) => stubManager(bin, pm, { marker, label: pm, write: [["pyproject.toml", pin]] })
  const reset = (files: Record<string, string>) => {
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root)
    rmSync(marker, { force: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(root, name), body)
  }
  try {
    process.env.PATH = bin
    stub("poetry", '[tool.poetry.dependencies]\npython = "^3.11"\nrequests = "2.32.3"\n')
    stub("uv", '[project]\nname = "app"\ndependencies = ["requests==2.32.3"]\n')

    reset({ "pyproject.toml": '[tool.poetry.dependencies]\nrequests = "2.31.0"\n', "poetry.lock": "" })
    const poetry = await applyBump("pypi", "requests", "2.32.3", root)
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["poetry", "add", "requests==2.32.3"])
    expect(poetry).toMatchObject({ exit: 0 })
    expect(poetry.text).toContain("OK: requests confirmed at 2.32.3")

    reset({ "pyproject.toml": '[project]\nname = "app"\ndependencies = ["requests==2.31.0"]\n' })
    expect((await applyBump("pypi", "requests", "2.32.3", root)).exit).toBe(0)
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["uv", "add", "--frozen", "requests==2.32.3"])

    reset({
      "pyproject.toml": '[project]\nname = "app"\ndependencies = ["requests==2.31.0"]\n',
      "uv.lock": "version = 1\n",
    })
    expect((await applyBump("pypi", "requests", "2.32.3", root)).exit).toBe(0)
    expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual(["uv", "add", "requests==2.32.3"])

    // Poetry 2 writes PEP 621 pins as `name (==version)`.
    stub("poetry", '[project]\nname = "app"\ndependencies = ["requests (==2.32.3)"]\n')
    reset({ "pyproject.toml": '[project]\nname = "app"\ndependencies = ["requests (>=2.31)"]\n', "poetry.lock": "" })
    expect((await applyBump("pypi", "requests", "2.32.3", root)).exit).toBe(0)
    expect(JSON.parse(readFileSync(marker, "utf8"))[0]).toBe("poetry")

    reset({ "requirements.txt": "requests==2.31.0\n" })
    const manual = await applyBump("pypi", "requests", "2.32.3", root)
    expect(manual.exit).toBe(0)
    expect(manual.text).toContain("MANUAL")
    expect(manual.text).not.toContain("pip install")
    expect(existsSync(marker)).toBe(false)
    expect(readFileSync(join(root, "requirements.txt"), "utf8")).toBe("requests==2.31.0\n")
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    rmSync(root, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
}, 10000)

test("npm and Python bumps end the same three ways: a failed run, an unconfirmed pin, a confirmed pin", async () => {
  const root = mkdtempSync(join(tmpdir(), "dep-apply-tail-"))
  const bin = mkdtempSync(join(tmpdir(), "dep-apply-tail-bin-"))
  const oldPath = process.env.PATH
  const oldPm = process.env.DEP_UPDATE_PKG_MANAGER
  /** A package manager that exits with `code`, after writing `pin` into its working directory when given. */
  const stub = (pm: string, code: number, pin?: [string, string]) =>
    stubManager(bin, pm, { exit: code, ...(pin ? { write: [pin] } : {}) })
  const node: [string, string] = ["package.json", '{"dependencies":{"left-pad":"1.3.0"}}']
  const python: [string, string] = ["pyproject.toml", '[project]\nname = "app"\ndependencies = ["requests==2.32.3"]\n']
  const cases: Array<[string, string, string, string, number, [string, string] | undefined, number, string]> = [
    [
      "npm",
      "npm",
      "left-pad",
      "1.3.0",
      3,
      undefined,
      1,
      "WARN: npm exited with status 3; partial changes may remain; bump was not confirmed",
    ],
    [
      "npm",
      "npm",
      "left-pad",
      "1.3.0",
      0,
      undefined,
      1,
      "WARN: left-pad: post-apply manifest check failed - version may not have landed",
    ],
    ["npm", "npm", "left-pad", "1.3.0", 0, node, 0, "OK: left-pad confirmed at 1.3.0"],
    [
      "pypi",
      "uv",
      "requests",
      "2.32.3",
      3,
      undefined,
      1,
      "WARN: uv exited with status 3; partial changes may remain; bump was not confirmed",
    ],
    [
      "pypi",
      "uv",
      "requests",
      "2.32.3",
      0,
      undefined,
      1,
      "WARN: requests: post-apply manifest check failed - version may not have landed",
    ],
    ["pypi", "uv", "requests", "2.32.3", 0, python, 0, "OK: requests confirmed at 2.32.3"],
  ]
  try {
    process.env.PATH = bin
    process.env.DEP_UPDATE_PKG_MANAGER = "npm"
    for (const [ecosystem, pm, name, version, code, pin, exit, last] of cases) {
      rmSync(root, { recursive: true, force: true })
      mkdirSync(root)
      writeFileSync(join(root, "package.json"), '{"dependencies":{"left-pad":"1.2.0"}}')
      writeFileSync(join(root, "pyproject.toml"), '[project]\nname = "app"\ndependencies = ["requests==2.31.0"]\n')
      stub(pm, code, pin)
      const result = await applyBump(ecosystem, name, version, root)
      expect({
        ecosystem,
        code,
        pin: pin !== undefined,
        exit: result.exit,
        last: result.text.split("\n").at(-1),
      }).toEqual({
        ecosystem,
        code,
        pin: pin !== undefined,
        exit,
        last,
      })
    }
  } finally {
    if (oldPath === undefined) delete process.env.PATH
    else process.env.PATH = oldPath
    if (oldPm === undefined) delete process.env.DEP_UPDATE_PKG_MANAGER
    else process.env.DEP_UPDATE_PKG_MANAGER = oldPm
    rmSync(root, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
}, 20000)
