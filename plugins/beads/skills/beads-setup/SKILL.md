---
name: beads-setup
description: "Use for Beads setup: init, remotes, ledger outside the checkout, separate beads repo, BEADS_DIR or no beads database found."
metadata:
  opencode/autoinvoke: false
---

# Ledger in a separate repo
When the code host cannot store Dolt refs, choose this. When the ledger belongs in a
separate planning repo, choose this too. Initialize or clone that beads repo using the steps below.
Its remote owns `refs/dolt/data`, not the code remote. Then, in the code project's
`.opencode/opencode.json`, add:

```json
{"plugins":[{"package":"github:srobroek/opencode-plugins#main::path:plugins/beads","options":{"store":"/absolute/path/to/ledger/.beads"}}]}
```

Match the inherited package target exactly. This entry REPLACES inherited options.
Copy any options you need to retain. For `bd` in shells, set `mise.local.toml`:

```toml
[env]
BEADS_DIR = "/absolute/path/to/ledger/.beads"
```

The shared OpenCode server does not read mise, so the plugin needs `options.store`
too. Run `mise exec -- bd where` from the code checkout and confirm the ledger
path. See [Project ledger store](../../README.md#project-ledger-store) for path
validation and precedence.

# Claude Code
Install the plugin with these two commands:

```text
/plugin marketplace add srobroek/opencode-plugins
/plugin install beads@srobroek-opencode
```

Its hooks need `bun` on `PATH`. At session start they add `bd prime` and the
session-start advisories to the context and pin `BEADS_DIR` for later Bash calls. Before
each Bash call that names `bd`, `git` or `gh`, they run the shell gates of the OpenCode
plugin. Without `bun`, session start falls back to plain `bd prime` and no gate runs.
For a ledger in a separate repo, set the store in the project's `.claude/settings.json`:

```json
{"env":{"BEADS_DIR":"/absolute/path/to/ledger/.beads"}}
```

An explicit `BEADS_DIR` wins over the pin. Skip `bd setup claude`: its hooks would add
`bd prime` a second time.

# DETECT
When `bd where` exits 0, Beads exists in this project. Skip initialization.
Otherwise, run `git ls-remote origin refs/dolt/data`. When the output is non-empty, the
ledger exists remotely. Run `bd bootstrap --yes`, never `bd init`. If `bd`
warns that `.beads` has permissions 0750, run `chmod 700 .beads`.
# NEW LEDGER
MUST confirm git `origin` exists first: run `git remote -v`.

When `origin` is absent, add or confirm the code remote
with the user's repository URL. Then initialize.

Run `BD_NON_INTERACTIVE=1 bd init --init-if-missing --skip-hooks --skip-agents`.
The issue prefix defaults to the directory name. When the user names another prefix, add `--prefix PREFIX`.
Otherwise, do not add it.

The init command auto-commits `.beads/{.gitignore,README.md,config.yaml,metadata.json}` and
`.gitignore` on the CURRENT branch. Run it on the branch carrying the setup
change. `--skip-agents` prevents writing or committing these files:

- `AGENTS.md`
- `CLAUDE.md`
- `.agents/.codex/.cursor` files

Ignore the `Git upstream not configured / git
remote add upstream` hint. It is a fork-workflow hint, not ledger sync.

The generated `.beads/README.md` shows `bd update ID --status done`. In the setup change, replace that
example with `bd close ID --reason "REASON"`.
# REMOTE
MUST verify `bd dolt remote list` shows `origin git+ssh://git@github.com/OWNER/REPO.git`
(or git+https / git+file). When it prints `No remotes configured.`, run
`bd dolt remote add origin git+ssh://git@github.com/OWNER/REPO.git`.
Use the same repository as the code. Run it only in that case. The ledger lives under `refs/dolt/data`, separate
from branches. NEVER re-add an existing name: `bd dolt remote add` silently
replaces it.
# FIRST PUSH + PROOF
`bd dolt push` MUST print `Push complete.`. Prove it with
`git ls-remote origin refs/dolt/data` returning non-empty output. `bd dolt push` can exit 0 and push nothing when no remote exists.
Exit status is not proof.
# HOOKS
`--skip-hooks` matters when a system hook manager supplies hook binaries: a plain `bd init`
copies them into `.beads/hooks/`, commits them, and points `core.hooksPath` there. That
bypasses the system hooks and bloats the repository. When a repository already has
`core.hooksPath` set to `.beads/hooks`:

1. Run `git config --local --unset core.hooksPath`.
2. Delete `.beads/hooks/`.
3. Add `.beads/hooks/` to `.gitignore`.

# SYNC
MUST keep `export.auto` at its default (off). NEVER commit `.beads/issues.jsonl`: JSONL is
an export, not the ledger. Sync only through the Dolt remote with `bd dolt push` and
`bd dolt pull`.
# BACKUP
For off-machine recovery, run `bd backup init <path>` once. Then run `bd backup sync`. The
path is a local directory or a DoltHub URL. A backup is a Dolt-native copy of the whole
database, with its branches and history. `bd export` is not a backup. It writes only
issue records to JSONL, for migration. Restore with `bd backup restore`.
# VERIFY
Run these commands:

- `bd where`
- `bd dolt status`
- `bd dolt remote list`

When the project owns its git-hook bundle and the hooks directory contains no binary executable, run
`bd hooks install --beads`. Otherwise, retain those hooks.
# NEVER
Without explicit user direction, NEVER use any of these `bd init` flags:

- `--reinit-local`
- `--force`
- `--discard-remote`
- `--destroy-token`
- `--from-jsonl`

NEVER use `--server`, `bd dolt start`, or any Dolt server.

NEVER use these commands for ledger sync. They mirror issues to external trackers:

- `bd github`
- `bd jira`
- `bd linear`
- `bd ado`
- `bd federation`

# COMMAND DISCOVERY
When an operation is not covered by `bd prime`, the `beads-ledger` skill, or this
skill, read `bd COMMAND --help` for that command. Do not browse top-level
`bd --help` or try integration commands.
