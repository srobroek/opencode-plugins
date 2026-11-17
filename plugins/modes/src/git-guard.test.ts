import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { forbiddenGit, guardShellCall, inspectGit } from "./git-guard.ts"

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
  "git commit -m x",
  "git switch -c debug/probe",
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
  "git branch --show-current",
  "git tag",
  "git tag -l 'v*'",
  "git config --get user.name",
  "git config --list",
  "git remote -v",
  "git remote get-url origin",
  "git worktree list",
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
    expect(forbiddenGit("git bisect good", "debug", context)).toBeUndefined()
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
    `git diff --output=${HOME}/.opencode/debug/d.patch`,
    "git diff --output=out.patch",
    "git log -p",
    "git diff --output-indicator-new=+",
    "git blame --contents notes.txt file.ts",
    `git worktree add -b debug-bar ${WORKTREES}/debug-bar`,
    `git worktree add --detach ${WORKTREES}/debug-bar origin/main`,
    `git worktree remove --force ${WT}`,
    "git worktree list",
    "git format-patch --stdout HEAD~1",
    "git format-patch --stdout -3",
    "git diff --output=~/.opencode/debug/d.patch",
    "git worktree add --detach ~/.local/share/opencode/worktree/h1/debug-bar",
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
    "git checkout --detach origin/main",
    "git switch --detach origin/main",
    "git reset HEAD~1",
    "git restore f",
    "git stash",
    "git stash push -m x",
    "git cherry-pick abc",
    "git revert abc",
    "git apply p.diff",
    "git am p.mbox",
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
    `git -C ${WT} commit -am x`,
    `git -C ${WT}/src add f`,
    "git -C .. commit -m x",
    "git -C . commit -m x",
    `git --work-tree=${CHECKOUT} checkout .`,
    `git --work-tree ${CHECKOUT} checkout .`,
    `git --work-tree=${WT} reset`,
    `git --git-dir=${CHECKOUT}/.git commit -m x`,
    `git --git-dir=${WT}/.git commit -m x`,
    "git --namespace=x commit -m x",
    `git -C ${WT} bisect run bun test x`,
    `cd ${CHECKOUT} && git commit -m x`,
    `cd ${WT} && git commit -am x`,
    `cd ${WT}/src && git add f && git commit -m x`,
    `cd ${CHECKOUT}; git commit -m x`,
    `(cd ${WT} && true); git commit -m x`,
    `(cd ${CHECKOUT} && git commit -m x)`,
    "cd $SOMEWHERE && git commit -m x",
    "cd ~ && git commit -m x",
    "cd .. && git commit -m x",
    `pushd ${CHECKOUT} && git commit -m x`,
    `env -C ${CHECKOUT} git commit -m x`,
    `env -C ${WT} git commit -m x`,
    `env -C ${CHECKOUT} sh -c 'git commit -m x'`,
    `sudo -D ${CHECKOUT} git commit -m x`,
    "sh -c 'git commit -m x'",
    "bash -lc 'git add -A'",
    `sh -c 'cd ${WT} && git commit -m x'`,
    "eval 'git commit -m x'",
    "echo x | xargs git commit -m",
    "find . -exec git add {} ';'",
    "echo $(git commit -m x)",
    `GIT_DIR=${CHECKOUT}/.git git commit -m x`,
    `GIT_WORK_TREE=${CHECKOUT} git add -A`,
  ]
  test.each(redirected)("refuses %j even from the scratch workdir", (command) => {
    expect(forbiddenGit(command, "debug", context)).toBeString()
  })
  test("the refusal tells the agent to set workdir", () => {
    expect(forbiddenGit(`git -C ${WT} commit -m x`, "debug", inCheckout)).toContain("workdir")
    expect(forbiddenGit("git commit -m x", "debug", inCheckout)).toContain("workdir")
  })
  test.each([`git -C ${WT} commit -am x`, `cd ${WT} && git commit -am x`, `env -C ${WT} git commit -m x`, "sh -c 'git commit -m x'"])(
    "leaves refactor free to run %j",
    (command) => {
      expect(forbiddenGit(command, "refactor", inCheckout)).toBeUndefined()
    },
  )
  test.each(["git status", "git log -p", "git diff", `git -C ${CHECKOUT} log`, `cd ${CHECKOUT} && git status`, `git -C ${WT} diff`])(
    "allows the read-only %j with -C, cd or a checkout workdir",
    (command) => {
      expect(forbiddenGit(command, "debug", inCheckout)).toBeUndefined()
      expect(forbiddenGit(command, "debug", context)).toBeUndefined()
    },
  )
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

const verdict = (agents: string[], command: string, expected: "refused" | "allowed") => {
  for (const agent of agents) {
    const reason = forbiddenGit(command, agent, context)
    if (expected === "refused") expect({ agent, command, reason }).toEqual({ agent, command, reason: expect.any(String) })
    else expect({ agent, command, reason }).toEqual({ agent, command, reason: undefined })
  }
}

describe("fetch", () => {
  test.each(["git fetch", "git fetch origin", "git fetch --all", "git fetch --update-head-ok origin +main:main", "git fetch origin main:refs/heads/x"])(
    "debug may not run %j",
    (command) => verdict(["debug"], command, "refused"),
  )
  test.each([
    "git fetch --update-head-ok origin main:main",
    "git fetch --update-head-o origin main:main",
    "git fetch -u origin main:main",
    "git fetch origin +main:main",
    "git fetch origin +refs/heads/*:refs/remotes/o/*",
    "git fetch origin main:refs/heads/x",
    "git fetch origin main:x",
    "git fetch origin refs/heads/main:refs/heads/main",
    "git fetch --refmap=+refs/heads/*:refs/heads/* origin main",
  ])("refactor may not run %j", (command) => verdict(["refactor"], command, "refused"))
  test.each(["git fetch", "git fetch origin", "git fetch origin main", "git fetch origin refs/heads/main:refs/remotes/origin/main", "git fetch --prune origin"])(
    "refactor may run %j",
    (command) => verdict(["refactor"], command, "allowed"),
  )
})

describe("apply", () => {
  test.each(["git apply --unsafe-paths p.diff", "git apply --unsafe p.diff", "git apply --directory=../x p.diff", "git apply --directory ../x p.diff", "git apply --dir=x p.diff"])(
    "refuses %j",
    (command) => verdict(["debug", "refactor"], command, "refused"),
  )
  test.each(["git apply p.diff", "git apply --check p.diff", "git apply --3way -p2 p.diff", "git apply --stat p.diff"])("allows %j", (command) =>
    verdict(["debug", "refactor"], command, "allowed"),
  )
})

describe("worktree", () => {
  test.each(["git worktree lock x", "git worktree unlock x", "git worktree move x y", "git worktree repair", "git worktree prune", "git worktree"])(
    "%j is refused for both",
    (command) => verdict(["debug", "refactor"], command, "refused"),
  )
  test.each([`git worktree add -b debug-bar ${WORKTREES}/debug-bar`, `git worktree remove ${WT}`])("debug may run %j", (command) =>
    verdict(["debug"], command, "allowed"),
  )
  test.each([`git worktree add -b debug-bar ${WORKTREES}/debug-bar`, `git worktree remove ${WT}`])("refactor may not run %j", (command) =>
    verdict(["refactor"], command, "refused"),
  )
  test("worktree list is allowed for both", () => verdict(["debug", "refactor"], "git worktree list", "allowed"))
})

describe("remote", () => {
  test.each([
    "git remote -v add o url",
    "git remote --verbose set-url o url",
    "git remote -v remove o",
    "git remote -v rename a b",
    "git remote -v prune o",
    "git remote -v update",
    "git remote show origin",
    "git remote show -n origin extra",
    "git remote get-url",
    "git remote get-url a b",
    "git remote get-url --all",
    "git remote add o url",
    "git remote prune origin",
    "git remote update",
    "git remote set-head origin -a",
    "git remote -v -v set-url o url",
  ])("%j is refused", (command) => verdict(["debug", "refactor"], command, "refused"))
  test.each(["git remote", "git remote -v", "git remote --verbose", "git remote get-url origin", "git remote -v get-url origin", "git remote show -n origin"])(
    "%j is allowed",
    (command) => verdict(["debug", "refactor"], command, "allowed"),
  )
})

describe("interpreters", () => {
  test.each([
    "python3 -m pytest tests/test_git.py",
    "python -c 'print(1)'",
    "bun test git-guard.test.ts",
    "node scripts/check-git.js",
    "perl script-git.pl",
    "ruby lib/git_helper.rb",
    "bun run check:git",
    "deno test git.test.ts",
    "awk '{print $1}' .gitignore",
    "node --check git.js",
    "python3 -c 'import sys; print(sys.argv)' .gitignore",
  ])("running %j is not flagged", (command) => verdict(["debug", "refactor"], command, "allowed"))
  test.each([
    'python3 -c "import subprocess; subprocess.run([\'git\',\'push\'])"',
    'python3 -c"import os; os.system(\'git push\')"',
    'node -e "require(\'child_process\').execSync(\'git push\')"',
    'node --eval "require(\'child_process\').execSync(\'git push\')"',
    'node -p "require(\'child_process\').execSync(\'git push\')"',
    "perl -e 'system(\"git push\")'",
    "ruby -e 'system(\"git push\")'",
    "php -r 'system(\"git push\");'",
    'bun -e "Bun.spawn([\'git\',\'push\'])"',
    'bun --eval "Bun.spawn([\'git\',\'push\'])"',
    'deno eval "new Deno.Command(\'git\', {args:[\'push\']})"',
    "awk 'BEGIN{system(\"git push\")}'",
    "awk -F: 'BEGIN{system(\"git push\")}' file",
    'lua -e "os.execute(\'git push\')"',
  ])("inline code in %j that mentions git is refused", (command) => verdict(["debug", "refactor"], command, "refused"))

  // The interpreter stops reading its own options at the module, the script or the subcommand.
  test.each([
    "python3 -m pytest -c .github/pytest.ini",
    "python3 -m pytest -c git.ini",
    "python3 script.py -c 'import os; os.system(\"git push\")'",
    "python3 -u script.py -c git",
    "python3 -- script.py -c git",
    "node script.js -e x",
    "node script.js -e 'git push'",
    "node -r ts-node/register script.js -p git",
    "bun test -e git",
    "bun run lint -e git",
    "deno run -A main.ts -e git",
    "deno test --filter git",
    "perl script.pl -e git",
    "perl -I lib script.pl -e git",
    "ruby script.rb -e git",
    "ruby -I lib script.rb -e git",
    "php -f script.php -r git",
    "lua script.lua -e git",
  ])("arguments after the boundary in %j are not inline code", (command) => verdict(["debug", "refactor"], command, "allowed"))
  test.each([
    "python3 -u -c 'import os; os.system(\"git push\")'",
    "python3 -W ignore -c 'import os; os.system(\"git push\")'",
    "python3 -I -B -c 'import os; os.system(\"git push\")'",
    "node -r ts-node/register -e \"require('child_process').execSync('git push')\"",
    "node --require x --print \"require('child_process').execSync('git push')\"",
    "node --input-type module -e \"import 'child_process'; // git push\"",
    "bun --cwd x -e \"Bun.spawn(['git','push'])\"",
    "perl -I lib -e 'system(\"git push\")'",
    "perl -e 1 -e 'system(\"git push\")'",
    "perl -w -E 'say `git push`'",
    "ruby -I lib -e 'system(\"git push\")'",
    "ruby -w -e 'system(\"git push\")'",
    "php -d display_errors=1 -r 'system(\"git push\");'",
    "lua -l mod -e \"os.execute('git push')\"",
    "deno eval -q \"new Deno.Command('git')\"",
  ])("inline code before the boundary in %j is refused", (command) => verdict(["debug", "refactor"], command, "refused"))
})

describe("branch changes are exact forms (debug only)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567"
  const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  const allowed = [
    "git switch -c debug/x",
    "git switch -c debug-x",
    "git switch --create debug/x",
    "git switch -c debug/x.y_z-1",
    `git switch -c debug/x ${SHA}`,
    `git switch -c debug-x ${SHA256}`,
    "git switch -c debug/x origin/main",
    "git switch -c debug/x origin/feature/a-b",
    "git switch debug/x",
    "git switch debug-x",
    "git switch --detach",
    `git switch --detach ${SHA}`,
    "git switch --detach origin/main",
    "git checkout --detach",
    `git checkout --detach ${SHA}`,
    "git checkout --detach origin/main",
    "git checkout debug/x",
    "git checkout debug-x",
    "git branch",
    "git branch -a",
    "git branch --list 'main*'",
    "git branch --contains abc1234",
    "git bisect reset",
    "git bisect reset debug-x",
    `git bisect reset ${SHA}`,
    "git restore -- src/a.ts",
    "git restore --source=HEAD~1 -- src/a.ts",
    "git restore --staged -- src/a.ts",
    "git restore --worktree --source=origin/main -- src/a.ts",
    `git worktree add --detach ${WORKTREES}/debug-bar`,
    `git worktree add --detach ${WORKTREES}/debug-bar ${SHA}`,
    `git worktree add --detach ${WORKTREES}/debug-bar origin/main`,
    `git worktree add -b debug-bar ${WORKTREES}/debug-bar`,
    `git worktree add -b debug/bar ${WORKTREES}/debug-bar origin/main`,
  ]
  test.each(allowed)("debug may run %j", (command) => verdict(["debug"], command, "allowed"))

  const refused = [
    // abbreviations, clusters and attached values
    "git switch -qCmain debug/x",
    "git switch --cr main",
    "git switch --crea debug/x",
    "git switch -cdebug/x",
    "git switch -C debug/x",
    "git switch --force-create debug/x",
    "git switch -qc debug/x",
    "git switch --det",
    "git switch -d",
    "git checkout -Bmain",
    "git checkout -b debug/x",
    "git checkout -B debug/x",
    "git checkout --det",
    "git checkout -d",
    "git checkout --orphan debug/x",
    "git switch --orphan debug/x",
    // other options and extra operands
    "git switch -f debug/x",
    "git switch --force debug/x",
    "git switch --discard-changes debug/x",
    "git switch --merge debug/x",
    "git switch --track debug/x",
    "git switch --guess debug/x",
    "git switch -c debug/x main",
    "git switch -c debug/x origin/main extra",
    "git switch -c debug/x abc1234",
    "git switch debug/x extra",
    "git switch --detach main",
    "git switch --detach origin/main extra",
    "git checkout --detach main",
    "git checkout --detach HEAD~1",
    "git checkout --detach @{-1}",
    "git checkout --detach origin/../x",
    "git checkout --ignore-other-worktrees debug/x",
    "git switch --ignore-other-worktrees main",
    // names that are not exactly debug/<slug> or debug-<slug>
    "git switch main",
    "git switch debug",
    "git switch debug/",
    "git switch debug/a/b",
    "git switch debug/a:b",
    "git switch -c debug/x~1",
    "git switch -c debugger",
    "git switch -",
    "git switch @{-1}",
    "git checkout main",
    "git checkout origin/main",
    "git checkout HEAD",
    "git checkout HEAD~1",
    "git checkout @{-1}",
    "git checkout -",
    "git checkout deadbeef",
    `git checkout ${SHA}`,
    "git checkout abc1234",
    "git checkout feature/x",
    "git checkout v1.0",
    // file restores go through git restore
    "git checkout -- src/a.ts",
    "git checkout main -- src/a.ts",
    "git checkout debug/x -- src/a.ts",
    "git checkout --detach -- src/a.ts",
    "git checkout src/a.ts",
    // branch creation goes through switch -c
    "git branch debug-x",
    "git branch debug/x origin/main",
    "git branch main-copy",
    "git bisect reset main",
    "git bisect reset HEAD~1",
    // worktree add
    "git worktree add -f ../x",
    `git worktree add --force ${WORKTREES}/debug-bar`,
    `git worktree add -f --detach ${WORKTREES}/debug-bar`,
    `git worktree add ${WORKTREES}/debug-bar`,
    `git worktree add ${WORKTREES}/debug-bar main`,
    `git worktree add ${WORKTREES}/debug-bar debug-baz`,
    `git worktree add --detach ${WORKTREES}/debug-bar main`,
    `git worktree add --detach ${WORKTREES}/debug-bar ${SHA} extra`,
    `git worktree add -b main ${WORKTREES}/debug-bar`,
    `git worktree add -B debug-bar ${WORKTREES}/debug-bar`,
    `git worktree add -bdebug-bar ${WORKTREES}/debug-bar`,
    `git worktree add -b debug-bar --detach ${WORKTREES}/debug-bar`,
    `git worktree add -b debug-bar ${WORKTREES}/debug-bar main`,
    `git worktree add --orphan -b debug-bar ${WORKTREES}/debug-bar`,
    `git worktree add --detach --lock ${WORKTREES}/debug-bar`,
    `git worktree add --detach ${WORKTREES}/debug-bar/sub`,
    `git worktree add --detach ${CHECKOUT}/sibling`,
  ]
  test.each(refused)("debug may not run %j", (command) => verdict(["debug"], command, "refused"))

  test("refactor works on the user's branches by design", () => {
    for (const command of ["git checkout main", "git switch main", "git switch -c feature/x", "git branch feature/x", "git checkout --ignore-other-worktrees main", "git checkout -- src/a.ts"])
      verdict(["refactor"], command, "allowed")
  })

  describe("one call, one branch change", () => {
    const mixed = [
      "git switch -c debug/x && git commit -am x",
      "git switch --detach && git add -A",
      "git commit -am x && git switch debug/x",
      "git add -A; git switch --detach",
      "git switch --detach && git switch -c debug/x",
      "git switch -c debug/x\ngit commit -am x",
      `git worktree add --detach ${WORKTREES}/debug-bar && git commit -am x`,
      "git switch debug/x && git bisect start",
      "git switch debug/x && git bisect run bun test x",
    ]
    test.each(mixed)("%j is refused with a pointer to a separate call", (command) => {
      const reason = forbiddenGit(command, "debug", context)
      expect(reason).toContain("its own call")
    })
    test("a branch change with only read-only git is fine", () => {
      verdict(["debug"], "git switch -c debug/x && git status", "allowed")
      verdict(["debug"], "git log -1 && git switch --detach", "allowed")
    })
    test("mutating commands may share a call when none changes the branch", () => {
      verdict(["debug"], "git add -A && git commit -am x", "allowed")
    })
    test("refactor is not limited", () => {
      verdict(["refactor"], "git switch -c feature/x && git commit -am x", "allowed")
    })
  })

  describe("which commands need the HEAD check", () => {
    const needs = (command: string) => inspectGit(command, "debug", context).mutates
    test("a branch change is exempt, because it can only reach a debug branch or a detached HEAD", () => {
      expect(needs("git switch -c debug/x")).toBe(false)
      expect(needs("git switch --detach")).toBe(false)
      expect(needs("git checkout debug-x")).toBe(false)
      expect(needs(`git worktree add --detach ${WORKTREES}/debug-bar`)).toBe(false)
    })
    test("every other mutating command needs it", () => {
      for (const command of ["git commit -am x", "git add -A", "git reset HEAD~1", "git stash", "git restore -- a", "git bisect start", "git cherry-pick abc1234"])
        expect({ command, needs: needs(command) }).toEqual({ command, needs: true })
    })
    test("read-only commands never need it", () => {
      for (const command of ["git status", "git log -p", "git diff", "git switch -c debug/x && git status"])
        expect({ command, needs: needs(command) }).toEqual({ command, needs: false })
    })
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
