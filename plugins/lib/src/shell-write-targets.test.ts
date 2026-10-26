import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import { lexicalAbs, shellWriteTargets, under } from "./shell-write-targets.ts"

const HOME = homedir()
const CWD = join(HOME, "projects", "app")
const ZSHRC = join(HOME, ".zshrc")

describe("under / lexicalAbs", () => {
  test("under treats identity and descendants", () => {
    expect(under(CWD, CWD)).toBe(true)
    expect(under(join(CWD, "x"), CWD)).toBe(true)
    expect(under("/tmp/x", CWD)).toBe(false)
    expect(under("/tmp/x", "")).toBe(false)
  })

  test("lexicalAbs expands ~ and resolves relatives", () => {
    expect(lexicalAbs("~/.zshrc", CWD)).toBe(ZSHRC)
    expect(lexicalAbs("foo/../bar", "/abs/cwd")).toBe("/abs/cwd/bar")
  })
})

describe("shellWriteTargets", () => {
  test("an unquoted here-document body is data, not commands", () => {
    expect(shellWriteTargets("cat > /tmp/notes <<EOF\ncp a ~/.zshrc\nEOF", HOME)).toEqual(["/tmp/notes"])
    expect(shellWriteTargets("gh pr create --body-file - <<EOF\nRun: echo x >> ~/.zshrc\nEOF", HOME)).toEqual([])
  })

  test("a substitution in an unquoted here-document body still runs", () => {
    expect(shellWriteTargets("cat <<EOF\n$(cp a ~/.zshrc)\nEOF", HOME)).toEqual([ZSHRC])
    expect(shellWriteTargets("cat <<EOF\nnote `printf x > ~/.zshrc`\nEOF", HOME)).toEqual([ZSHRC])
    expect(shellWriteTargets("cat <<EOF\n\\$(cp a ~/.zshrc) and \\`cp a ~/.zshrc\\`\nEOF", HOME)).toEqual([])
    expect(shellWriteTargets("cat <<EOF\n$(cd /tmp; printf x > .zshrc)\nEOF\nprintf x > .zshrc", HOME)).toEqual([
      "/tmp/.zshrc",
      ZSHRC,
    ])
  })

  test("a quoted target attached to a redirect operator is a redirect", () => {
    expect(shellWriteTargets('echo x >"$HOME/.zshrc"', "/tmp")).toEqual([ZSHRC])
    expect(shellWriteTargets(`printf x >>"${ZSHRC}"`, "/tmp")).toEqual([ZSHRC])
    expect(shellWriteTargets('echo ">" ~/.zshrc', "/tmp")).toEqual([])
  })

  test.each([
    "printf x > ~/.zshrc",
    "printf x >>~/.zshrc",
    "echo x 2>/dev/null >$HOME/.zshrc",
    "echo x | tee -a ~/.zshrc",
    "cp /tmp/x ~/.zshrc",
    "cp /tmp/.zshrc ~",
    "cp -t ~ /tmp/.zshrc",
    "mv /tmp/x ~/.zshrc",
    "perl -pi -e 's/a/b/' ~/.zshrc",
    "perl -i.bak -pe 's/a/b/' ~/.zshrc",
    "sudo sed -i s/a/b/ ~/.zshrc",
    "sudo -u root tee ~/.zshrc",
    "gsed -i s/a/b/ ~/.zshrc",
    "sed -i '' s/a/b/ ~/.zshrc",
    "cd ~ && sed -i s/a/b/ .zshrc",
    "cd /tmp; cd ~; printf x > .zshrc",
    "/usr/bin/sudo tee ~/.zshrc",
    "doas -u root tee ~/.zshrc",
    "nice -n 5 tee ~/.zshrc",
    "nice -5 cp /tmp/x ~/.zshrc",
    "timeout 5 tee ~/.zshrc",
    "timeout -s KILL 5 cp /tmp/x ~/.zshrc",
    "timeout --preserve-status 5s sed -i s/a/b/ ~/.zshrc",
    "stdbuf -oL tee ~/.zshrc",
    "stdbuf -o L tee ~/.zshrc",
    "exec -a name tee ~/.zshrc",
    "env -S 'tee -a ~/.zshrc'",
    "env -i -S'cp /tmp/x ~/.zshrc'",
    "sudo nice -n 5 timeout 5 tee ~/.zshrc",
  ])("finds the write target: %s", (command) => {
    expect(shellWriteTargets(command, CWD)).toContain(ZSHRC)
  })

  test("resolves a relative target against cwd", () => {
    expect(shellWriteTargets("sed -i s/a/b/ .zshrc", HOME)).toEqual([ZSHRC])
  })

  test.each([
    "env -C ~ tee .zshrc",
    "env --chdir=$HOME cp x .zshrc",
    "sudo -D ~ sed -i s/a/b/ .zshrc",
    "sudo --chdir ~ perl -pi -e 's/a/b/' .zshrc",
    `env -C ${dirname(HOME)} env -C ${basename(HOME)} tee .zshrc`,
    "env -C /tmp printf x > .zshrc",
  ])("resolves a wrapped command's paths in the wrapper's directory, redirects in the shell's: %s", (command) => {
    expect(shellWriteTargets(command, command.includes("> .zshrc") ? HOME : "/tmp")).toContain(ZSHRC)
  })

  test.each([
    "env -C /tmp tee .zshrc",
    "env -C ~ printf x > .zshrc",
    'env -C "$DIR" tee .zshrc',
    "timeout 5 cat ~/.zshrc",
    "command -v tee",
    "stdbuf -oL grep x ~/.zshrc",
  ])("a wrapped command that does not write the target: %s", (command) => {
    expect(shellWriteTargets(command, command.startsWith("env -C ~") ? "/tmp" : HOME)).not.toContain(ZSHRC)
  })

  test.each([
    "cd /tmp; sed -i s/a/b/ .zshrc",
    "cd /tmp && printf x > .zshrc",
    "(cd /tmp; printf x > .zshrc)",
    'cd "$DIR"; printf x > .zshrc',
    "cat ~/.zshrc",
    "cp ~/.zshrc /tmp/backup",
    "echo '> ~/.zshrc'",
    "grep x ~/.zshrc 2>&1",
    "sed s/a/b/ ~/.zshrc",
    "cat <<'EOF' > /tmp/notes\ncp a ~/.zshrc\nEOF",
    "cat > /tmp/notes <<EOF\ncp a ~/.zshrc\nEOF",
    "gh pr create --body-file - <<EOF\nRun: echo x >> ~/.zshrc\nEOF",
    'echo ">" ~/.zshrc',
  ])("a command that does not write the target: %s", (command) => {
    expect(shellWriteTargets(command, HOME)).not.toContain(ZSHRC)
  })
})
