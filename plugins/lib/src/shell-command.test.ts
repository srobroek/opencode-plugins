import { expect, test } from "bun:test"
import {
  commandFromInput,
  commandSegments,
  invocation,
  leadingCdCwd,
  parse,
  parsedInvocations,
  type ShellScan,
  scanShell,
} from "./shell-command.ts"

/** Each item as text: an operator as itself, a command as its words. */
function outline(scan: ShellScan): string[] {
  return scan.items.map((item) =>
    item.kind === "operator" ? item.operator : item.words.map((word) => word.value).join(" "),
  )
}

test("reads fd redirections as redirections, not as background operators", () => {
  const scan = scanShell("bd list 2>&1 | head -40 &> log; bd prime >| out")
  expect(outline(scan)).toEqual(["bd list", "|", "head -40", ";", "bd prime"])
  expect(
    scan.items.flatMap((item) => (item.kind === "command" ? [item.redirects.map((word) => word.value)] : [])),
  ).toEqual([["1"], ["log"], ["out"]])
})

test("keeps quoted separators inside their word and records exact source offsets", () => {
  const source = `bd close x --reason 'a; b | c' && echo "d && e"`
  const scan = scanShell(source)
  expect(outline(scan)).toEqual(["bd close x --reason a; b | c", "&&", "echo d && e"])
  const first = scan.items[0]
  if (first?.kind !== "command") throw new Error("expected a command first")
  expect(first.words.map((word) => source.slice(word.start, word.end))).toEqual([
    "bd",
    "close",
    "x",
    "--reason",
    "'a; b | c'",
  ])
  expect(first.words[4]?.quoted).toBe(true)
  expect(scan.complete).toBe(true)
})

test("returns every substitution for the caller to judge, wherever it expands", () => {
  const scan = scanShell(
    "echo \"$(bd list)\" `date` <(sort f)\ncat <<EOF\n$(bd show x)\nEOF\ncat <<'EOF'\n$(inert)\nEOF\n",
  )
  expect(scan.substitutions).toEqual(["bd list", "date", "sort f", "bd show x"])
  expect(scan.items.flatMap((item) => (item.kind === "command" ? item.hereDocuments : []))).toEqual([
    { body: "$(bd show x)\n", quoted: false },
    { body: "$(inert)\n", quoted: true },
  ])
})

test("marks words the shell expands later", () => {
  const scan = scanShell("bd -C $DIR close ~/x 'lit$eral' *.md")
  const first = scan.items[0]
  if (first?.kind !== "command") throw new Error("expected a command")
  expect(first.words.map((word) => word.expands)).toEqual([false, false, true, false, true, false, true])
})

test("treats braces as group words only in command position", () => {
  // The group's own redirection is a command with no words.
  expect(outline(scanShell("{ bd list; } > out; find . -exec echo {} +"))).toEqual([
    "{",
    "bd list",
    ";",
    "}",
    "",
    ";",
    "find . -exec echo {} +",
  ])
})

test("drops comments and joins continued lines", () => {
  expect(outline(scanShell("bd list \\\n  --json # then bd close x"))).toEqual(["bd list --json"])
})

test("reports an open quote, substitution or here-document as incomplete", () => {
  for (const source of ["echo 'open", 'echo "open', "echo $(bd list", "cat <<EOF\nbody", "cat <<EOF"]) {
    expect(scanShell(source).complete).toBe(false)
  }
})

test("splits segments at operators outside quotes", () => {
  expect(commandSegments("a && b 'c;d' | e")).toEqual(["a ", "&&", " b 'c;d' ", "|", " e"])
})

test("finds an invocation behind env and wrapper prefixes, never behind a quoted word", () => {
  expect(invocation("env FOO=1 -u BAR sudo git push", ["git", "push"])?.map((token) => token.value)).toEqual([
    "git",
    "push",
  ])
  expect(invocation("/usr/bin/git push origin", ["git", "push"])?.length).toBe(3)
  expect(invocation("'git' push", ["git", "push"])).toBeNull()
  expect(invocation("echo git push", ["git", "push"])).toBeNull()
})

test("resolves a leading literal cd against cwd", () => {
  expect(leadingCdCwd("cd sub && ls", "/repo")).toBe("/repo/sub")
  expect(leadingCdCwd("cd /abs && ls", "/repo")).toBe("/abs")
  expect(leadingCdCwd("cd $DIR && ls", "/repo")).toBe("/repo")
  expect(leadingCdCwd("ls", "/repo")).toBe("/repo")
})

test("parses command positions and nested sources, flagging what it cannot read", () => {
  const parsed = parse("FOO=1 git status; echo \"$(gh pr list)\" | bash -c 'rm x'")
  expect(parsed.commands.map((position) => position.executable)).toEqual(["git", "echo", "bash"])
  expect(parsed.nested.map((child) => child.command)).toEqual(["gh pr list", "rm x"])
  expect(parsed.unknown).toBe(false)
  expect(parse("eval $CMD").unknown).toBe(true)
  expect(parse("echo 'open")).toMatchObject({ kind: "parse-failure", reason: "unbalanced shell quote" })
  expect(parse(42)).toMatchObject({ kind: "parse-failure" })
})

test("lists invocations of one executable with their globals and verb", () => {
  const found = parsedInvocations(parse("gh -R o/r pr list && echo $(gh --json api x)"), "gh", ["--json"])
  expect(found.map(({ verb, globals }) => ({ verb, globals }))).toEqual([
    { verb: "pr", globals: ["-R", "o/r"] },
    { verb: "api", globals: ["--json"] },
  ])
  expect(parsedInvocations(parse("eval $X; gh pr list"), "gh")).toEqual([])
})

test("reads command or cmd from tool input", () => {
  expect(commandFromInput({ command: "ls" })).toBe("ls")
  expect(commandFromInput({ cmd: "pwd" })).toBe("pwd")
  expect(commandFromInput(null)).toBe("")
})
