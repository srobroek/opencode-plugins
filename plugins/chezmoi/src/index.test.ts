import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { createFakeContext } from "@srobroek/opencode-lib/testing"
import { createGuard, type Spawn } from "./guard.ts"
import { createPlugin, SKILL_PATH } from "./index.ts"

const HOME = homedir()
const OUTSIDE = join(HOME, ".config", "opencode-plugins-chezmoi-guard-test")
const CWD = join(HOME, "projects", "app")
const SOURCE = join(HOME, ".local", "share", "chezmoi")
const ZSHRC = join(HOME, ".zshrc")
const ZSHRC_SOURCE = join(SOURCE, "dot_zshrc")

/** A fake `chezmoi` whose managed list the test can grow. */
function fakeChezmoi(managed: string[] = [ZSHRC]) {
  const calls: string[][] = []
  const spawn: Spawn = async (args) => {
    calls.push(args)
    if (args[0] === "managed") return managed.join("\n")
    if (args[0] === "source-path" && args[1] === ZSHRC) return `${ZSHRC_SOURCE}\n`
    if (args[0] === "source-path" && args[1] === OUTSIDE) return `${SOURCE}/dot_config/file\n`
    if (args[0] === "source-path" && args.length === 1) return `${SOURCE}\n`
    return null
  }
  return { spawn, managed, calls }
}

function guard(managed?: string[], now?: () => number) {
  const chezmoi = fakeChezmoi(managed)
  const g = createGuard({ spawn: chezmoi.spawn, ...(now ? { now } : {}) })
  const call = (tool: string, input: Record<string, unknown>, cwd = CWD) => g.decide(tool, input, cwd)
  return { call, ...chezmoi }
}

const shell = (command: string, workdir?: string) => (workdir ? { command, workdir } : { command })

describe("managed-set lookup", () => {
  test("refuses a managed target and names its source", async () => {
    const reason = await guard([OUTSIDE]).call("write", { path: OUTSIDE, content: "x" })
    expect(reason).toContain(OUTSIDE)
    expect(reason).toContain(`${SOURCE}/dot_config/file`)
  })

  test("allows an unmanaged home path", async () => {
    expect(await guard([`${OUTSIDE}-other`]).call("edit", { path: OUTSIDE })).toBeUndefined()
  })

  test("allows when chezmoi is missing", async () => {
    const g = createGuard({ spawn: async () => null })
    expect(await g.decide("write", { path: ZSHRC }, CWD)).toBeUndefined()
  })

  test("allows a path inside the source directory", async () => {
    expect(await guard().call("write", { path: ZSHRC_SOURCE })).toBeUndefined()
  })

  test("skips paths outside home without running chezmoi", async () => {
    const g = guard(["/tmp/elsewhere"])
    expect(await g.call("write", { path: "/tmp/elsewhere" })).toBeUndefined()
    expect(g.calls).toEqual([])
  })

  test("falls back to a source-path hint when chezmoi cannot resolve the source", async () => {
    const g = createGuard({
      spawn: async (args) => (args[0] === "managed" ? OUTSIDE : args.length === 1 ? SOURCE : null),
    })
    expect(await g.decide("write", { path: OUTSIDE }, CWD)).toContain(`chezmoi source-path ${OUTSIDE}`)
  })
})

describe("tool targets", () => {
  test("refuses write, edit and patch to a managed target", async () => {
    const g = guard()
    expect(await g.call("write", { path: ZSHRC, content: "x" })).toContain(ZSHRC_SOURCE)
    expect(await g.call("edit", { path: "~/.zshrc", oldString: "a", newString: "b" })).toContain(ZSHRC_SOURCE)
    const patchText = "*** Begin Patch\n*** Update File: ~/.zshrc\n@@\n-a\n+b\n*** End Patch"
    expect(await g.call("patch", { patchText })).toContain(ZSHRC_SOURCE)
    const move = `*** Begin Patch\n*** Update File: ${OUTSIDE}\n*** Move to: ${ZSHRC}\n*** End Patch`
    expect(await g.call("patch", { patchText: move })).toContain(ZSHRC_SOURCE)
  })

  test("resolves a relative edit path against the session directory", async () => {
    expect(await guard().call("edit", { path: ".zshrc" }, HOME)).toContain(ZSHRC_SOURCE)
  })

  test("ignores read and other tools", async () => {
    expect(await guard().call("read", { path: ZSHRC })).toBeUndefined()
  })

  test.each([
    "printf x > ~/.zshrc",
    "printf x >>~/.zshrc",
    "echo x 2>/dev/null >$HOME/.zshrc",
    "echo x | tee -a ~/.zshrc",
    "cp /tmp/x ~/.zshrc",
    "cp -t ~ /tmp/.zshrc",
    "mv /tmp/x ~/.zshrc",
    "perl -pi -e 's/a/b/' ~/.zshrc",
    "perl -i.bak -pe 's/a/b/' ~/.zshrc",
    "sudo sed -i s/a/b/ ~/.zshrc",
    "gsed -i s/a/b/ ~/.zshrc",
    "sed -i '' s/a/b/ ~/.zshrc",
    "cd ~ && sed -i s/a/b/ .zshrc",
    "cd /tmp; cd ~; printf x > .zshrc",
    'echo x >"$HOME/.zshrc"',
    `printf x >>"${ZSHRC}"`,
    "cat <<EOF\n$(cp a ~/.zshrc)\nEOF",
    "timeout 5 tee ~/.zshrc",
    "env -S 'tee -a ~/.zshrc'",
    "sudo nice -n 5 timeout 5 tee ~/.zshrc",
  ])("refuses a shell write to a managed target: %s", async (command) => {
    expect(await guard().call("shell", shell(command))).toContain(ZSHRC_SOURCE)
  })

  test("resolves a relative target against the shell workdir", async () => {
    expect(await guard().call("shell", shell("sed -i s/a/b/ .zshrc", HOME))).toContain(ZSHRC_SOURCE)
    expect(await guard().call("shell", shell("sed -i s/a/b/ .zshrc", ".."), join(HOME, "x"))).toContain(ZSHRC_SOURCE)
  })

  test.each([
    ["env -C ~ tee .zshrc", "/tmp"],
    ["sudo -D ~ sed -i s/a/b/ .zshrc", "/tmp"],
    [`env -C ${dirname(HOME)} env -C ${basename(HOME)} tee .zshrc`, "/tmp"],
    ["env -C /tmp printf x > .zshrc", HOME],
  ])("resolves a wrapped command's paths in the wrapper's directory, redirects in the shell's: %s", async (command, workdir) => {
    expect(await guard().call("shell", shell(command, workdir))).toContain(ZSHRC_SOURCE)
  })

  test.each([
    "cd /tmp; sed -i s/a/b/ .zshrc",
    "(cd /tmp; printf x > .zshrc)",
    'cd "$DIR"; printf x > .zshrc',
    "cat ~/.zshrc",
    "cp ~/.zshrc /tmp/backup",
    "echo '> ~/.zshrc'",
    "sed s/a/b/ ~/.zshrc",
    "cat > /tmp/notes <<EOF\ncp a ~/.zshrc\nEOF",
    'echo ">" ~/.zshrc',
  ])("allows a shell command that writes no managed target: %s", async (command) => {
    expect(await guard().call("shell", shell(command, HOME))).toBeUndefined()
  })
})

describe("managed-list refresh", () => {
  test("re-reads the managed list after the TTL", async () => {
    let clock = 0
    const g = guard([], () => clock)
    expect(await g.call("write", { path: ZSHRC })).toBeUndefined()
    g.managed.push(ZSHRC)
    clock = 4000
    expect(await g.call("write", { path: ZSHRC })).toBeUndefined()
    clock = 6000
    expect(await g.call("write", { path: ZSHRC })).toContain(ZSHRC_SOURCE)
  })

  test("a chezmoi command invalidates the managed list at once", async () => {
    const g = guard([], () => 0)
    expect(await g.call("write", { path: ZSHRC })).toBeUndefined()
    g.managed.push(ZSHRC)
    expect(await g.call("shell", shell("chezmoi add ~/.zshrc"))).toBeUndefined()
    expect(await g.call("write", { path: ZSHRC })).toContain(ZSHRC_SOURCE)
  })

  test("a write inside the source directory invalidates the managed list", async () => {
    const g = guard([], () => 0)
    expect(await g.call("write", { path: ZSHRC })).toBeUndefined()
    g.managed.push(ZSHRC)
    expect(await g.call("write", { path: ZSHRC_SOURCE })).toBeUndefined()
    expect(await g.call("write", { path: ZSHRC })).toContain(ZSHRC_SOURCE)
  })
})

describe("plugin", () => {
  test("throws from execute.before for a managed target, registers the skill and disposes both", async () => {
    const chezmoi = fakeChezmoi()
    const fake = createFakeContext({ directory: HOME })
    const cleanup = await createPlugin({ spawn: chezmoi.spawn }).setup(fake.context)
    expect(fake.hooks("tool")).toEqual(["execute.before"])
    expect(fake.skills.get("chezmoi-editor")).toMatchObject({ path: SKILL_PATH })
    expect(String(fake.skills.get("chezmoi-editor")?.content)).not.toMatch(/skill:\/\/|ast_edit|\bbash\b/)
    await expect(
      fake.fire.tool("execute.before", { tool: "shell", sessionID: "ses_1", input: { command: "tee .zshrc" } }),
    ).rejects.toThrow(ZSHRC_SOURCE)
    await expect(
      fake.fire.tool("execute.before", { tool: "bash", sessionID: "ses_1", input: { command: "tee .zshrc" } }),
    ).rejects.toThrow(ZSHRC_SOURCE)
    await fake.fire.tool("execute.before", { tool: "read", sessionID: "ses_1", input: { path: ZSHRC } })
    await cleanup?.()
    expect(fake.active()).toBe(0)
  })
})

describe("bundle", () => {
  test("the built entry resolves the shipped SKILL.md from the package root", async () => {
    const built = (await import(join(import.meta.dir, "..", "index.js"))) as { SKILL_PATH: string }
    expect(built.SKILL_PATH).toBe(join(import.meta.dir, "..", "skills", "chezmoi-editor", "SKILL.md"))
    expect(existsSync(built.SKILL_PATH)).toBe(true)
  })
})
