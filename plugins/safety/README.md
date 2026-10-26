# safety

Guards for the shell tool in OpenCode V2: hard gates for commands that should never run unreviewed,
permission checks for commands that destroy work, a PR close-keyword rewrite, and a package-vetting
advisory. Ported from the omp-plugins `safety` package.

Every check reads the command with the shared shell parser (`@srobroek/opencode-lib`), not a regex
over the tool call. A hazard quoted as data (`grep 'rm -rf $X'`, a commit message, a here-document
written to a file, a `bun -e` fixture) never trips a check. One run through `sudo`, `env`,
`timeout`, `bash -c`, `eval`, `xargs`, a here-document fed to a shell, or a command substitution does.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/safety'
```

Needs `git` on `PATH`. The branch check also uses `gh`. Without `gh`, the merged-PR signal is
absent, so a squash-merged branch asks instead of passing.

## Hard gates

These run in `tool.hook("execute.before")` and throw. The model gets the message as the tool error,
and the command does not run.

| Id | Refuses |
| --- | --- |
| `indirection` | `rm`, `rmdir`, `dd`, `shred`, `truncate`, `unlink`, `wipefs` or `mkfs*` whose operand is `$VAR`, `${VAR}`, `$(…)` or a backtick expression. The one exception: a quoted variable after a bare `--` (`rm -r -- "$tmp_dir"`). Substitutions are never exempt. |
| `remote-exec` | A fetch (`curl`, `wget`, `fetch`, `http`, `xh`) piped into `sh`/`bash`/`zsh`/… at any later pipeline stage. A shell, `source`, `.` or `eval` running a fetch's output (`bash -c "$(curl …)"`, `bash <(curl …)`, `eval "$(curl …)"`). `nc`/`ncat` with `-e`, `--exec` or `--sh-exec`. |
| `attribution` | `git commit` (or `dgit commit`) whose `-m`, `--message`, `--trailer` or `-F`/`--file` message names an AI assistant. That covers a `Co-authored-by` trailer naming Claude, Codex, GPT, Copilot, Cursor, Devin, Gemini, Anthropic or OpenAI, a `Generated with …` line, and an `@anthropic.com`/`@openai.com` noreply address. A `-F` file is read from disk, and the gate also reads what earlier commands in the same call wrote into it. `-F -` reads the command's here-document. |
| `worktree-tmp` | `git worktree add` with a path under `/tmp` or `/private/tmp`. Relative paths resolve against the call's directory. Also `wt switch\|new\|co\|agent` naming such a path. |
| `git-defender` | The Git Defender CLI (`git defender …`, `git-defender`) in any command position. Only the user runs it. |

## Permission checks

`execute.before` reviews the call and keeps the decision, keyed by tool call id.
`permission.hook("evaluate")` then applies that decision to the call's `shell` evaluation. An
evaluation that arrives without a matching call is reviewed from its resources. A decision only
tightens: `allow` becomes `ask` or `deny`, `ask` gains the message, and a configured `deny` stays.

| Id | Effect | When |
| --- | --- | --- |
| `force-push` | deny | `git push` with `--force`, `-f` (in any short cluster, such as `-uf`) or a `+refspec`. The message says to use `--force-with-lease`. `--force-with-lease` and `--force-if-includes` pass. |
| `sudo-destructive` | ask | A destructive verb under `sudo`/`doas`. This includes `chmod`, `chown` and `chgrp` with `-R`. |
| `worktree-destruction` | ask / deny | Commands that discard work, unless git proves nothing is lost. See below. |

`worktree-destruction` covers these cases:

- **Branch force-delete** (`git branch -D`, `--delete --force`, `-d -f`, `wt remove -D`/`--force-delete`).
  - Passes when every tip is an ancestor of `origin/HEAD` (else `origin/main` or `origin/master`).
  - Also passes when `gh pr list --state merged --head NAME` reports a merged PR at that exact tip.
    That covers squash merges.
  - Otherwise asks, with the commits not in the default branch, whether a remote still holds the
    tip, and the `git branch NAME SHA` restore command.
  - Denies a delete it cannot read with certainty: expanded targets, a missing branch, a
    remote-tracking delete, a `GIT_*` override, or a directory change it cannot follow.
  - Asks when a delete is spelled inside another command's text (`echo`, a commit message).
- **Worktree removal** (`git worktree remove`, `wt remove`).
  - Denies a removal that would orphan a detached commit, and names the
    `git branch recovered/NAME SHA` rescue.
  - Denies several targets in one call, or targets built by a wrapper or an expansion.
  - A forced removal of a checkout with uncommitted or untracked files asks and lists the files.
  - A removal without `--force` passes, because git and wt refuse a dirty checkout themselves.
- **`git stash drop` / `git stash clear`** ask. The message gives each entry's SHA and
  `git stash store` to restore it.
- **`git reset --hard`** passes when the tracked tree is clean and the target already contains HEAD
  (a no-op or a fast-forward). Otherwise it asks, with the dirty files, the commits lost, and
  `git reset --hard <old HEAD>`.
- **`git reflog expire|delete`** and **`git clean -f`** without `-n` ask.

Git and gh probes are bounded: 10 s per call, 25 s per decision, 8 s per gh call. A timeout asks
rather than passes.

## Rewrite and advisory

- **close-keywords** (`execute.before`): in `gh pr create|edit --body …`, `Fixes #1, #2` becomes
  `Fixes #1, fixes #2`, so GitHub closes every listed issue. Only a literal body is rewritten. A
  body with an expansion or other unsupported syntax is left alone. The permission check sees the
  rewritten command.
- **package-investigate** (`execute.after`): when a command adds or installs a named package (for
  example `npm i -D x`, `bun add x`, `uv add x`, `pip install x`, `cargo add x`, `go get x`,
  `composer require x`), the vetting instruction is appended to the result. It is sent once per
  package per session and never blocks. These do not trigger it:
  - lockfile restores such as `bun install` and `npm install`;
  - read-only lookups such as `npm view` and `cargo search`.

## Commit-msg hook

The `attribution` gate only sees commits the agent makes. `hooks/commit-msg` applies the same
matcher to every commit in a repository, including the ones you make in your own terminal. It
ignores comment lines and the `git commit -v` diff below the scissors line. It needs `bun` on
`PATH`. Without `bun`, it warns and lets the commit through. Use `git commit --no-verify` to skip
it once.

Install it per repository. Nothing is installed until you run this:

```sh
bun <safety>/dist/commit-msg.js install [--repo DIR] [--behind-hooks-path]
bun <safety>/dist/commit-msg.js uninstall [--repo DIR]
```

`<safety>` is this plugin's directory, such as a clone's `plugins/safety`. `install` writes
`<git-common-dir>/hooks/commit-msg` and copies the bundled checker next to it as
`safety-commit-msg.js`, so the hook still works after the plugin moves. Linked worktrees share
the hook. `install` never overwrites a hook it did not write:

| Existing `commit-msg` | `install` |
| --- | --- |
| none | writes the hook |
| the safety hook | refreshes it |
| a plain script | renames it to `commit-msg.chained`, which runs after the check passes; `uninstall` restores it |
| a binary (Mach-O, ELF) | refuses and leaves it alone |
| a hook framework's shim (pre-commit, prek, husky, lefthook, beads) | refuses and prints the snippet below |

If `core.hooksPath` sends git to another directory, git ignores `.git/hooks`. `install` then
refuses and names the setting and its scope. There are two exceptions:

- Git Defender's `/usr/local/amazon/var/git-defender/hooks` runs the repository's `.git/hooks`
  after its own hooks, so `install` goes ahead.
- `--behind-hooks-path` tells `install` that some other dispatcher does the same.

Otherwise, call `<safety>/hooks/commit-msg "$@"` from that directory's `commit-msg`.

For pre-commit or prek, register the check as a local hook in `.pre-commit-config.yaml`.
Install the `commit-msg` hook type too, for example `prek install --hook-type commit-msg`:

```yaml
repos:
  - repo: local
    hooks:
      - id: no-ai-attribution
        name: no AI attribution
        entry: bun <safety>/dist/commit-msg.js check
        language: system
        stages: [commit-msg]
```

### Every repository at once

`hooks/commit-msg` also works from a shared `core.hooksPath`. After the check it runs the
repository's own `.git/hooks/commit-msg`, so per-repository commit-msg hooks keep working:

```sh
mkdir -p ~/.config/git/hooks
ln -s <safety>/hooks/commit-msg ~/.config/git/hooks/commit-msg
git config --global core.hooksPath ~/.config/git/hooks
```

A global `core.hooksPath` replaces `.git/hooks` for every hook type. Without a matching
pass-through script for each hook type, a repository's `pre-commit`, `pre-push` and other hooks
stop running. A global setting also overrides a system one, such as Git Defender's. On a machine
where something else already owns `core.hooksPath`, do not set it globally. Install per repository
behind that owner instead. If your dotfiles manage git hooks (for example a chezmoi-managed prek
setup), add the pre-commit snippet above to the template your dotfiles install. Do not run a second
installer.

## Options

| Option | Default | Effect |
| --- | --- | --- |
| `disable` | `[]` | Feature ids to turn off: `indirection`, `remote-exec`, `attribution`, `worktree-tmp`, `git-defender`, `force-push`, `sudo-destructive`, `worktree-destruction`, `close-keywords`, `package-investigate`. |

```jsonc
{ "plugins": [{ "package": "...", "options": { "disable": ["git-defender"] } }] }
```

## Static permission rules (optional)

If you prefer configuration to a plugin, the plainly spelled cases fit permission rules. Put them
after any broad `allow`, because the last match wins. OpenCode checks one resource per command,
with any leading `cd` dropped. These rules therefore cannot see a pipe into a shell, a wrapper, a
nested script, or the git state that lets the plugin pass a landed branch.

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "git push --force *", "effect": "deny" },
    { "action": "shell", "resource": "git push -f *", "effect": "deny" },
    { "action": "shell", "resource": "git push * --force *", "effect": "deny" },
    { "action": "shell", "resource": "git push * -f *", "effect": "deny" },
    { "action": "shell", "resource": "git branch -D *", "effect": "ask" },
    { "action": "shell", "resource": "git worktree remove *", "effect": "ask" },
    { "action": "shell", "resource": "git stash drop *", "effect": "ask" },
    { "action": "shell", "resource": "git stash clear", "effect": "ask" },
    { "action": "shell", "resource": "git reset --hard *", "effect": "ask" },
    { "action": "shell", "resource": "git reflog expire *", "effect": "ask" },
    { "action": "shell", "resource": "git clean -f*", "effect": "ask" },
    { "action": "shell", "resource": "sudo rm *", "effect": "ask" },
    { "action": "shell", "resource": "git defender *", "effect": "deny" },
    { "action": "shell", "resource": "git-defender *", "effect": "deny" },
  ],
}
```

## Limits

- Every check is lexical. A script, Makefile target, git alias or hook, or a command assembled at
  run time is not seen. These checks reduce mistakes; they are not a security boundary.
- The omp text rules (`ask-pr-after-branch-push`, `delegated-data-not-instructions`) and the omp
  extensions `spawn-budget`, `quota-notice-resume` and `quality-edit-advisory` are not ported.
- The attribution gate covers agent commits only. Commits made elsewhere need the opt-in
  [commit-msg hook](#commit-msg-hook).
