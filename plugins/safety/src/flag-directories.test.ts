import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { externalDirectories, repositoryRoot, sessionRoots, shellFlagDirectories } from "./flag-directories.ts"

const CWD = "/work/repo"

describe("shellFlagDirectories", () => {
  test.each([
    ["git -C /other status", ["/other"]],
    ["git -C ../sib log", ["/work/sib"]],
    ["git -C /a -C b status", ["/a", "/a/b"]],
    ["git --git-dir=/x/.git --work-tree /x status", ["/x/.git", "/x"]],
    ["GIT_DIR=/y/.git git log", ["/y/.git"]],
    ["dgit -C /z push", ["/z"]],
    ["git -c core.x=1 -C /q status", ["/q"]],
    ["sudo git -C /root/r status", ["/root/r"]],
    ["make -C /m all", ["/m"]],
    ["make -C/m -C sub", ["/m", "/m/sub"]],
    ["make --directory=/m", ["/m"]],
    ["npm --prefix /n install", ["/n"]],
    ["npm install --prefix=/n", ["/n"]],
    ["pnpm -C /p build", ["/p"]],
    ["pnpm --dir /p build", ["/p"]],
    ["yarn --cwd /y test", ["/y"]],
    ["bun --cwd /b test", ["/b"]],
    ["cargo build --manifest-path /c/Cargo.toml", ["/c"]],
    ["cargo test --manifest-path=crates/x/Cargo.toml", ["/work/repo/crates/x"]],
    ["go -C /g build ./...", ["/g"]],
    ["go build -C=/g", ["/g"]],
    ["uv --directory /u run x", ["/u"]],
    ["cd x && echo; bash -c 'git -C /deep status'", ["/deep"]],
    ["git -C ~/r status", [join(homedir(), "r")]],
  ])("%s", (command, dirs) => {
    expect(shellFlagDirectories(command, CWD)).toEqual(dirs)
  })

  test.each([
    "git status",
    "git log -C",
    "git -C $DIR status",
    'git -C "$(pwd)/x" status',
    "echo git -C /other status",
    "npm run x -- --prefix /n",
    "make all",
    "constructor -C /x",
    "grep 'git -C /x' file",
  ])("none: %s", (command) => {
    expect(shellFlagDirectories(command, CWD)).toEqual([])
  })
})

describe("externalDirectories", () => {
  test("keeps only directories outside the roots, as cd-style resources", () => {
    const out = externalDirectories(["/work/repo/sub", "/work/repo", "/other", "/other"], ["/work/repo"])
    expect(out).toEqual([{ resource: "/other/*", save: "/other/*" }])
  })

  test("saves the repository root of an external directory", () => {
    const root = mkdtempSync(join(tmpdir(), "safety-flagdir-"))
    mkdirSync(join(root, ".git"))
    mkdirSync(join(root, "a", "b"), { recursive: true })
    expect(repositoryRoot(join(root, "a", "b"))).toBe(root)
    expect(externalDirectories([join(root, "a")], ["/work"])).toEqual([
      { resource: `${join(root, "a")}/*`, save: `${root}/*` },
    ])
    expect(sessionRoots(join(root, "a"))).toEqual([join(root, "a"), root])
  })
})
