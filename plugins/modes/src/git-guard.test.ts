import { describe, expect, test } from "bun:test"
import { forbiddenGit } from "./git-guard.ts"

const REFUSED_BOTH = [
  "git push origin main",
  "git -C /wt push",
  "git -c core.pager=cat clean -fdx",
  "git --git-dir=/x/.git push",
  "git --work-tree /x --no-pager clean -n",
  "cd /wt && git push",
  "echo hi | git push",
  "(git push)",
  "sh -c 'git push'",
  "env GIT_TRACE=1 git push",
  "x=$(git push)",
  "git $(echo push)",
]
const ALLOWED_BOTH = [
  "git log --grep push",
  "git -C /wt commit -m x",
  "git status",
  "git -C /wt checkout -b probe",
  "git diff main -- clean.ts",
  "bun test",
  "echo 'git push is blocked'",
]

describe("forbiddenGit", () => {
  test.each(REFUSED_BOTH)("refuses %s for debug and refactor", (command) => {
    expect(forbiddenGit(command, "debug")).toBeString()
    expect(forbiddenGit(command, "refactor")).toBeString()
  })
  test.each(ALLOWED_BOTH)("allows %s for debug and refactor", (command) => {
    expect(forbiddenGit(command, "debug")).toBeUndefined()
    expect(forbiddenGit(command, "refactor")).toBeUndefined()
  })
  test("rebase and hard reset are refused for refactor only", () => {
    for (const command of ["git rebase main", "git -C wt reset --hard HEAD~1", "git -c a=b rebase -i HEAD~3"]) {
      expect(forbiddenGit(command, "refactor")).toBeString()
      expect(forbiddenGit(command, "debug")).toBeUndefined()
    }
  })
  test("a soft reset is allowed for refactor", () => {
    expect(forbiddenGit("git reset --soft HEAD~1", "refactor")).toBeUndefined()
  })
  test("other agents are not guarded", () => {
    expect(forbiddenGit("git push", "build")).toBeUndefined()
  })
  test("an unparseable command that mentions git is refused", () => {
    expect(forbiddenGit("git push 'unterminated", "debug")).toBeString()
  })
})
