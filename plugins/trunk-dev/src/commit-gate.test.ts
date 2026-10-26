import { describe, expect, test } from "bun:test"
import { decideCommitGate } from "./commit-gate.ts"

const cwd = "/repo"
const releaseOptions = {
  git: (args: readonly string[], dir: string) =>
    args[0] === "rev-parse" ? dir : args[0] === "branch" ? "topic\n" : null,
  exists: (path: string) => path === "/repo/.releaserc",
  list: () => [],
}

function gate(command: string, options: Parameters<typeof decideCommitGate>[2] = releaseOptions) {
  return decideCommitGate(command, cwd, { processEnv: {}, ...options })
}

describe("decideCommitGate commit subjects", () => {
  test("requires a Conventional Commit subject in release repos", () => {
    expect(gate("git commit -m 'add feature'")).toMatchObject({ reason: expect.stringContaining("Conventional") })
    expect(gate("git commit -m 'feat(api): add feature'")).toBeUndefined()
    expect(gate("git commit -m 'feat!: break API'")).toBeUndefined()
  })

  test("rejects types outside the Conventional Commit set", () => {
    expect(gate("git commit -m 'update: something'")).toBeDefined()
    expect(gate("git commit -m 'feat:missing space'")).toBeDefined()
  })

  test("allows editor messages, amend without a new message, fixup, merge, and revert subjects", () => {
    for (const command of [
      "git commit",
      "git commit --amend",
      "git commit -m 'fixup! feat: follow up'",
      "git commit -m 'Merge branch x'",
      `git commit -m 'Revert "feat: x"'`,
    ]) {
      expect(gate(command)).toBeUndefined()
    }
  })

  test("uses the first inline message, and reads message files", () => {
    expect(gate("git commit -m 'feat: first' -m 'second' ")).toBeUndefined()
    expect(gate("git commit -m 'bad' -m 'feat: later'")).toBeDefined()
    expect(gate("git commit -mbad")).toBeDefined()
    expect(
      gate("git commit -F msg.txt", {
        ...releaseOptions,
        readFile: (path) => (path === "/repo/msg.txt" ? "# comment\n\nfeat(cli): from file\nbody" : null),
      }),
    ).toBeUndefined()
    expect(gate("git commit --file msg.txt", { ...releaseOptions, readFile: () => "not conventional\n" })).toBeDefined()
    expect(gate("git commit -F missing", { ...releaseOptions, readFile: () => null })).toBeUndefined()
  })

  test("reads a quoted here-document for -F -, and leaves an expanding one alone", () => {
    expect(gate("git commit -F - <<'EOF'\nbad subject\nEOF")).toBeDefined()
    expect(gate("git commit -F - <<'EOF'\nfix: good\nEOF")).toBeUndefined()
    expect(gate("git commit -F - <<EOF\n$SUBJECT\nEOF")).toBeUndefined()
  })

  test("an expanding message is uncertain and allowed", () => {
    expect(gate('git commit -m "$MSG"')).toBeUndefined()
    expect(gate(`git commit -m "$(cat <<'EOF'\nbad\nEOF\n)"`)).toBeUndefined()
  })

  test("recognizes quoting, assignment and env prefixes, command chains, dgit, -C and cd", () => {
    expect(gate("echo 'git commit -m bad' && git commit -m 'wrong'; git status")).toBeDefined()
    expect(gate("echo 'git commit -m bad'")).toBeUndefined()
    expect(gate("TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1 git commit -m bad")).toBeUndefined()
    expect(gate("env TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1 dgit commit -m bad")).toBeUndefined()
    expect(gate("dgit commit -m bad")).toBeDefined()
    expect(gate("git -C /repo commit -m bad")).toBeDefined()
    expect(gate("git -C /elsewhere commit -m bad")).toBeUndefined()
    expect(gate("cd /elsewhere && git commit -m bad")).toBeUndefined()
    expect(gate("(cd /elsewhere && true) && git commit -m bad")).toBeDefined()
  })

  test("non-release repositories remain silent and process overrides are honored", () => {
    expect(gate("git commit -m bad", { git: releaseOptions.git, exists: () => false, list: () => [] })).toBeUndefined()
    expect(
      gate("git commit -m bad", { ...releaseOptions, processEnv: { TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT: "1" } }),
    ).toBeUndefined()
  })

  test("commitlint config and a package.json release key mark a release repository", () => {
    const base = { git: releaseOptions.git, exists: (path: string) => path === "/repo/commitlint.config.js" }
    expect(gate("git commit -m bad", { ...base, list: () => ["commitlint.config.js"] })).toBeDefined()
    expect(
      gate("git commit -m bad", {
        git: releaseOptions.git,
        exists: (path) => path === "/repo/package.json",
        readFile: () => JSON.stringify({ release: { branches: ["main"] } }),
        list: () => [],
      }),
    ).toBeDefined()
  })

  test("an unterminated quote fails open", () => {
    expect(gate("git commit -m 'bad")).toBeUndefined()
  })
})

describe("decideCommitGate push destinations", () => {
  const push = (command: string, branch = "topic", processEnv?: Record<string, string>, release = true) =>
    gate(command, {
      git: (args, dir) => (args[0] === "branch" ? branch : releaseOptions.git(args, dir)),
      exists: release ? releaseOptions.exists : () => false,
      list: () => [],
      processEnv: processEnv ?? {},
    })

  test("allows main pushes in repositories without release configuration", () => {
    expect(push("git push origin main", "topic", undefined, false)).toBeUndefined()
    expect(push("git push", "main", undefined, false)).toBeUndefined()
  })

  test("blocks explicit main/master destinations and implicit pushes from the main branch", () => {
    for (const ref of ["main", "HEAD:main", "x:refs/heads/main", "+x:main", "HEAD:master"]) {
      expect(push(`git push origin ${ref}`)).toMatchObject({ reason: expect.stringContaining("main/master") })
    }
    expect(push("git push", "main")).toBeDefined()
    expect(push("git push", "master")).toBeDefined()
  })

  test("treats -u and --opt=value forms as flags, and blocks --all/--mirror", () => {
    for (const command of [
      "git push -u origin main",
      "git push --set-upstream origin main",
      "git push --force-with-lease=main:abc origin main",
      "git push --recurse-submodules=check origin HEAD:main",
      "git push --all origin",
      "git push --mirror origin",
    ]) {
      expect(push(command)).toBeDefined()
    }
    expect(push("git push -u origin topic")).toBeUndefined()
    expect(push("git push --unknown-flag origin main")).toBeUndefined()
  })

  test("resolves bare HEAD and @ refspecs to the current branch", () => {
    expect(push("git push origin HEAD", "main")).toBeDefined()
    expect(push("dgit push -u origin @", "master")).toBeDefined()
    expect(push("git push origin HEAD", "topic")).toBeUndefined()
    expect(push("git push origin HEAD", "")).toBeUndefined()
  })

  test("allows other branches, tags, dry runs, deletions, expansions and uncertain branches", () => {
    for (const command of [
      "git push origin topic",
      "git push origin v1:refs/tags/v1",
      "git push --tags origin",
      "git push --dry-run origin main",
      "git push -n origin main",
      "git push --delete origin main",
      "git push origin :main",
      'git push origin "$BRANCH"',
    ]) {
      expect(push(command)).toBeUndefined()
    }
    expect(push("git push", "")).toBeUndefined()
  })

  test("honors assignment and process environment main-push overrides", () => {
    expect(push("TRUNK_DEV_ALLOW_MAIN_PUSH=1 git push origin HEAD:main")).toBeUndefined()
    expect(push("git push origin main", "topic", { TRUNK_DEV_ALLOW_MAIN_PUSH: "1" })).toBeUndefined()
  })
})
