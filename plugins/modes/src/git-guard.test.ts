import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forbiddenGit, guardShellCall } from "./git-guard.ts"

// Nothing here touches the disk: paths that do not exist resolve lexically.
const HOME = "/fake/home"
const WORKTREES = `${HOME}/.local/share/opencode/worktree/h1`
const WT = `${WORKTREES}/debug-foo`
const CHECKOUT = `${HOME}/repo`
/** A debug session started in the user's checkout, running its shell calls in the scratch worktree. */
const context = { home: HOME, startDir: CHECKOUT, workdir: WT }

/** Refused for both guarded agents. */
const REFUSED = [
  "git push origin main",
  "git -C /wt push",
  "git -Cx push",
  "git -C x -c a=b push",
  "git -c core.pager=cat clean -fdx",
  "git --git-dir=/x/.git push",
  "git --git-dir /x/.git push",
  "git --work-tree /x --no-pager clean -n",
  "git --exec-path=/x push",
  "\\git push",
  "/usr/bin/git push",
  "command git push",
  "exec git push",
  "env -i git push",
  "env FOO=1 git push",
  "nice -n 5 git push",
  "time git push",
  "xargs git push",
  "echo x | xargs -n1 git push",
  "find . -exec git push ';'",
  "cd /wt && git push",
  "echo hi | git push",
  "(git push)",
  "sh -c 'git push'",
  "bash -lc 'git push'",
  "zsh -c 'git -C x push'",
  "bash -c \"bash -c 'git push'\"",
  "eval 'git push'",
  "x=$(git push)",
  "echo `git push`",
  "git $(echo push)",
  "bash <<'EOF'\ngit push\nEOF",
  "echo 'git push' | sh",
  "bash -s <<< 'git push'",
  "bash ./run.sh # git",
  "$G push # git",
  "git pushy",
  "git gc",
  "git prune",
  "git filter-branch --all",
  "git update-ref -d HEAD",
  "git reflog expire --all",
  "git reset --hard HEAD~1",
  "git reset --har",
  "git -C wt reset --hard",
  "git rebase main",
  "git config user.name x",
  "git config --global alias.p push",
  "git config --unset user.name",
  "git branch -D old",
  "git branch -dr old",
  "git branch --delete old",
  "git branch --del old",
  "git branch -m new",
  "git remote add o url",
  "git remote set-url o url",
  "git tag v1",
  "git tag -d v1",
  "git fetch --upload-pack='touch x'",
  `git diff --output=${CHECKOUT}/src/a.ts`,
  "git -c alias.x=!rm status",
  "git -c core.fsmonitor=evil status",
  "GIT_SSH_COMMAND='evil' git fetch",
  "git --unknown-option status",
  "if true; then git push; fi",
  "! git push",
  "{ git push; }",
  "while true; do git push; done",
  "until false; do git push; done",
  "if x; then :; else git push; fi",
  "for i in 1 2; do git push; done",
  "case x in x) git push;; esac",
  "echo a\ngit push",
  "true || git push",
  "git status && git push",
  "g\\it push",
  "\"g\"\\it push",
  "g{i,}t push",
  "/usr/bin/g* push",
  "/usr/bin/gi? push",
  "/usr/bin/[g]it push",
  "$G push; G=git",
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a shell variable, not a template
  "G=git; ${G} push",
  "`echo git` push",
  "sudo git push",
  "timeout 5 git push",
  "nohup git push",
  "time -p git push",
  "! time git push",
  "python3 -c \"import os; os.system('git push')\"",
  "node -e \"require('child_process').execSync('git push')\"",
  "perl -e 'system(\"git push\")'",
  "awk 'BEGIN{system(\"git push\")}'",
  "bun -e \"Bun.spawn(['git','push'])\"",
  "git --config-env=core.pager=PAGER_VAR log",
  "git --config-env core.fsmonitor=EVIL status",
  "git --config-env=alias.x=EVIL status",
  "GIT_CONFIG_COUNT=1 git log",
  "GIT_CONFIG_KEY_0=core.pager git log",
  "GIT_CONFIG_VALUE_0=evil git log",
  "GIT_CONFIG_PARAMETERS=\"'core.pager=evil'\" git log",
  "GIT_SSH=evil git fetch",
  "GIT_SSH_COMMAND=evil git fetch",
  "GIT_ASKPASS=evil git fetch",
  "GIT_EXTERNAL_DIFF=evil git diff",
  "GIT_PAGER=evil git log",
  "GIT_EDITOR=evil git commit",
  "EDITOR=evil git commit",
  "PAGER=evil git log",
  "env GIT_PAGER=evil git log",
  "env -i EDITOR=evil git commit",
  "export GIT_PAGER=evil; git log",
  "GIT_DIR=/x/.git git status",
  "git stash drop",
  "git stash drop stash@{1}",
  "git stash clear",
  "git stash pop",
  "git stash apply",
  "git stash branch rescue",
  "git stash store abc",
  "git -C wt stash pop",
]

const ALLOWED = [
  "git status",
  "git log --grep push",
  "git -C ../x status",
  "git -Cx status",
  "git -c color.ui=never diff",
  "git --no-pager log -1",
  "git --git-dir=/x/.git show HEAD",
  "cat .gitignore",
  "grep git file",
  "ls -a | grep git",
  "python3 -c 'print(1)'",
  "echo $HOME",
  "$HOME/bin/tool run",
  "ls *.ts",
  "g\\rep x file",
  "if true; then git status; fi",
  "! git diff --quiet",
  "{ git log -1; }",
  "git --config-env=user.name=NAME log",
  "LANG=C git log",
  "FOO=1 git status",
  "env FOO=1 git status",
  "git commit -m 'EDITOR note'",
  "git diff main -- clean.ts",
  `git -C ${WT} commit -m x`,
  `git -C ${WT} checkout -b probe`,
  "git switch -c probe",
  "git add -A && git commit -m x",
  "git stash",
  "git stash -u",
  "git stash list",
  "git stash show -p",
  "git stash push -m x",
  "git stash save x",
  "git reset --soft HEAD~1",
  "git reset HEAD file",
  "git cherry-pick abc",
  "git restore file",
  "git branch",
  "git branch -a",
  "git branch probe",
  "git branch --show-current",
  "git tag",
  "git tag -l 'v*'",
  "git config --get user.name",
  "git config --list",
  "git remote -v",
  "git remote get-url origin",
  "git fetch origin",
  `git worktree add ${WORKTREES}/debug-bar -b bar`,
  "git worktree list",
  `git worktree remove ${WT}`,
  "git blame file",
  "git grep push",
  "git --version",
  "echo 'git push is blocked'",
  "bun test",
  "ls",
  "bash -c 'echo hi'",
  "bash ./run.sh",
  "cat file | sh",
]

describe("forbiddenGit", () => {
  test.each(REFUSED)("refuses %j for debug and refactor", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeString()
    expect(forbiddenGit(command, "refactor", context)).toBeString()
  })
  test.each(ALLOWED)("allows %j for debug and refactor", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeUndefined()
    expect(forbiddenGit(command, "refactor", context)).toBeUndefined()
  })
  test("bisect is allowed for debug and refused for refactor", () => {
    expect(forbiddenGit("git bisect start", "debug", context)).toBeUndefined()
    expect(forbiddenGit("git -C wt bisect good", "debug", context)).toBeUndefined()
    expect(forbiddenGit("git bisect start", "refactor", context)).toBeString()
  })
  test("other agents are not guarded", () => {
    expect(forbiddenGit("git push", "build", context)).toBeUndefined()
  })
  test("an unparseable command that mentions git is refused, and one that does not is left alone", () => {
    expect(forbiddenGit("git status 'unterminated", "debug", context)).toBeString()
    expect(forbiddenGit("echo 'unterminated", "debug", context)).toBeUndefined()
  })
})

describe("output options", () => {
  const refused = [
    `git format-patch -o ${CHECKOUT}/out HEAD~1`,
    `git format-patch -o${CHECKOUT}/out HEAD~1`,
    "git format-patch -o /tmp/patches HEAD~1",
    "git format-patch -o ../elsewhere HEAD~1",
    `git format-patch --output-directory=${CHECKOUT}/out HEAD~1`,
    `git format-patch --output-directory ${CHECKOUT}/out HEAD~1`,
    `git format-patch --output-dir=${CHECKOUT}/out HEAD~1`,
    "git format-patch -o",
    `git diff --output=${CHECKOUT}/src/a.ts`,
    `git diff --output ${CHECKOUT}/src/a.ts`,
    `git -C ${CHECKOUT} log --output=src/a.ts`,
    `git show --out=${CHECKOUT}/x HEAD`,
    `git worktree add ${CHECKOUT}/sibling`,
    "git worktree add ../elsewhere",
    `git worktree add -b b ${HOME}/other`,
    `git worktree remove ${CHECKOUT}`,
    `git worktree remove ${WORKTREES}/subagent-x`,
    "git worktree prune",
    "git format-patch HEAD~1",
    "git format-patch -3",
    "git format-patch --cover-letter HEAD~2",
    "git format-patch --root",
    'git diff --output "$OUT"',
    "git diff --output=$HOME/x.patch",
    "git diff --output=`echo x`",
    `git diff --output=${WT}/*.patch`,
    "git diff --output={a,b}.patch",
    "git diff --output=~root/x.patch",
    'git format-patch -o "$OUT" HEAD~1',
    'git worktree add "$TARGET"',
    `git worktree add ${WORKTREES}/debug-*`,
    'git worktree remove "$TARGET"',
    'git bisect run "$SCRIPT"',
    "git bisect run sh $SCRIPT",
    "git bisect run sh ~root/x.sh",
  ]
  const allowed = [
    `git format-patch -o ${WT}/patches HEAD~1`,
    `git format-patch --output-directory=${HOME}/.opencode/debug/p HEAD~1`,
    "git format-patch -o patches HEAD~1",
    `git -C ${WT} format-patch -o patches HEAD~1`,
    `git diff --output=${HOME}/.opencode/debug/d.patch`,
    "git diff --output=out.patch",
    "git log -p",
    "git diff --output-indicator-new=+",
    "git blame --contents notes.txt file.ts",
    `git worktree add ${WORKTREES}/debug-bar -b bar`,
    `git worktree add -f --detach ${WORKTREES}/debug-bar HEAD`,
    `git worktree remove --force ${WT}`,
    "git worktree list",
    "git format-patch --stdout HEAD~1",
    "git format-patch --stdout -3",
    "git diff --output=~/.opencode/debug/d.patch",
    "git worktree add ~/.local/share/opencode/worktree/h1/debug-bar",
    `git -C "$ELSEWHERE" log`,
  ]
  test.each(refused)("refuses %j", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeString()
    expect(forbiddenGit(command, "refactor", context)).toBeString()
  })
  test.each(allowed)("allows %j", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeUndefined()
  })
  test("without a known start directory every output path is refused", () => {
    expect(forbiddenGit("git diff --output=out.patch", "debug", { home: HOME })).toBeString()
  })
})

describe("git bisect run", () => {
  const refused = [
    "git bisect run git push",
    "git bisect run sh -c 'git push'",
    "git bisect run bash -c \"git -C x push\"",
    "git bisect run env GIT_PAGER=evil git log",
    "git bisect run ../outside.sh",
    "git bisect run /tmp/x.sh",
    `git bisect run ${CHECKOUT}/repro.sh`,
    "git bisect run bash /tmp/x.sh",
    "git bisect run python3 /tmp/x.py",
    `git bisect run sh ${CHECKOUT}/repro.sh`,
    "git bisect run python3 -c \"import os; os.system('git push')\"",
    "git bisect run $CMD",
    "git bisect run ./*.sh",
    "git bisect run",
  ]
  const allowed = [
    "git bisect run bun test x",
    "git bisect run npm test",
    "git bisect run ./repro.sh",
    "git bisect run sh ./repro.sh",
    "git bisect run bash repro.sh --flag",
    "git bisect run python3 -m pytest tests/x",
    `git bisect run ${WT}/repro.sh`,
    "git bisect run sh -c 'bun test x'",
    "git bisect start",
    "git bisect good",
    "git bisect reset",
  ]
  test.each(refused)("refuses %j for debug", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeString()
  })
  test.each(allowed)("allows %j for debug", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeUndefined()
  })
  test("a runner script in the user's checkout is refused even with a relative path", () => {
    expect(forbiddenGit("git bisect run ./repro.sh", "debug", { ...context, workdir: CHECKOUT })).toBeString()
  })
})

describe("checkout boundary (debug only)", () => {
  const inCheckout = { ...context, workdir: CHECKOUT }
  const mutating = [
    "git commit -am x",
    "git add -A",
    "git checkout main",
    "git switch main",
    "git reset HEAD~1",
    "git restore f",
    "git stash",
    "git stash push -m x",
    "git cherry-pick abc",
    "git revert abc",
    "git apply p.diff",
    "git am p.mbox",
    "git branch newone",
    "git bisect start",
    "git bisect good",
    "git bisect run bun test x",
    "git bisect reset",
    "git worktree lock somewhere",
  ]
  test.each(mutating)("refuses %j in the user's checkout", (command) => {
    expect(forbiddenGit(command, "debug", inCheckout)).toBeString()
  })
  test.each(mutating.filter((command) => !command.includes("bisect") && !command.includes("worktree")))(
    "allows %j in the scratch worktree and for refactor in the checkout",
    (command) => {
      expect(forbiddenGit(command, "debug", context)).toBeUndefined()
      expect(forbiddenGit(command, "refactor", inCheckout)).toBeUndefined()
    },
  )
  test.each(["git bisect start", "git bisect good", "git bisect reset"])("allows %j in the scratch worktree", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeUndefined()
  })
  test("bisect run is allowed in the scratch worktree", () => {
    expect(forbiddenGit("git bisect run bun test x", "debug", context)).toBeUndefined()
  })
  const redirected = [
    `git -C ${CHECKOUT} commit -m x`,
    `git -C ${CHECKOUT}/src add f`,
    "git -C .. commit -m x",
    `git --work-tree=${CHECKOUT} checkout .`,
    `git --work-tree ${CHECKOUT} checkout .`,
    `git --git-dir=${CHECKOUT}/.git commit -m x`,
    `git --git-dir=${WT}/.git commit -m x`,
    `cd ${CHECKOUT} && git commit -m x`,
    `cd ${CHECKOUT}; git commit -m x`,
    `(cd ${WT} && true); git commit -m x`,
    `(cd ${CHECKOUT} && git commit -m x)`,
    "cd $SOMEWHERE && git commit -m x",
    "cd ~ && git commit -m x",
    "cd .. && git commit -m x",
    `pushd ${CHECKOUT} && git commit -m x`,
    `env -C ${CHECKOUT} git commit -m x`,
    `sh -c 'cd ${CHECKOUT} && git commit -m x'`,
  ]
  test.each(redirected)("refuses %j from the scratch worktree", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeString()
  })
  const scratchTargets = [
    `git -C ${WT} commit -am x`,
    `git -C ${WT}/src add f`,
    `git --work-tree=${WT} reset`,
    `cd ${WT} && git commit -am x`,
    `cd ${WT}/src && git add f && git commit -m x`,
    `git -C ${WT} bisect run bun test x`,
    `env -C ${WT} git commit -m x`,
    `sh -c 'cd ${WT} && git commit -m x'`,
  ]
  test.each(scratchTargets)("allows %j from the user's checkout", (command) => {
    expect(forbiddenGit(command, "debug", inCheckout)).toBeUndefined()
  })
  const readOnly = [
    "git status",
    "git log -p",
    "git diff",
    "git show HEAD",
    "git stash list",
    "git stash show -p",
    "git branch -a",
    "git branch --contains abc",
    "git bisect log",
    "git worktree list",
    "git fetch",
    "git config --get user.name",
    `git -C ${CHECKOUT} log`,
    `git --git-dir=${CHECKOUT}/.git show HEAD`,
    `cd ${CHECKOUT} && git status`,
  ]
  test.each(readOnly)("allows the read-only %j anywhere", (command) => {
    expect(forbiddenGit(command, "debug", inCheckout)).toBeUndefined()
  })
  test("the session's workdir is followed, and a call with no start directory is refused", () => {
    expect(forbiddenGit("git commit -m x", "debug", { home: HOME, startDir: CHECKOUT, workdir: "../.local/share/opencode/worktree/h1/debug-foo" })).toBeUndefined()
    expect(forbiddenGit("git commit -m x", "debug", { home: HOME })).toBeString()
  })
})

describe("symlinks before dot-dot", () => {
  let home = ""
  beforeAll(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "modes-git-")))
    mkdirSync(join(home, "repo/src"), { recursive: true })
    mkdirSync(join(home, ".local/share/opencode/worktree/h1/debug-foo/src"), { recursive: true })
    symlinkSync(join(home, "repo/src"), join(home, ".local/share/opencode/worktree/h1/debug-foo/up"))
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  const real = () => ({ home, startDir: join(home, "repo"), workdir: `${home}/.local/share/opencode/worktree/h1/debug-foo` })

  test("an output path that goes up from a scratch symlink lands in the checkout and is refused", () => {
    const wt = real().workdir
    expect(forbiddenGit(`git diff --output=${wt}/up/../x.patch`, "debug", real())).toBeString()
    expect(forbiddenGit(`git diff --output=${wt}/src/../x.patch`, "debug", real())).toBeUndefined()
  })
  test("a worktree target that goes up from a scratch symlink is refused", () => {
    const wt = real().workdir
    expect(forbiddenGit(`git worktree add ${wt}/up/../debug-bar`, "debug", real())).toBeString()
  })
})

describe("guardShellCall", () => {
  test("an alias tool with an argv-array command is read as the command it becomes", () => {
    expect(guardShellCall("bash", { command: ["git", "-C", "x", "push"] }, "debug")).toBeString()
    expect(guardShellCall("bash", { command: ["bash", "-lc", "git push"] }, "debug")).toBeString()
    expect(guardShellCall("bash", { cmd: "git push" }, "debug")).toBeString()
    expect(guardShellCall("bash", { command: ["git", "status"] }, "debug")).toBeUndefined()
  })
  test("a shell call without a recognisable command is refused", () => {
    expect(guardShellCall("shell", { cmd: "git push" }, "debug")).toBeString()
    expect(guardShellCall("shell", {}, "debug")).toBeString()
    expect(guardShellCall("shell", { command: "  " }, "refactor")).toBeString()
  })
  test("a plain shell command and non-shell tools follow the git rules", () => {
    expect(guardShellCall("shell", { command: "git push" }, "debug")).toBeString()
    expect(guardShellCall("shell", { command: "git status" }, "debug")).toBeUndefined()
    expect(guardShellCall("read", { path: "a" }, "debug")).toBeUndefined()
    expect(guardShellCall("shell", {}, "build")).toBeUndefined()
  })
})
