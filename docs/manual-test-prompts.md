# Manual test prompts

Copy-paste prompts for testing every plugin in this repository by hand in a live
OpenCode session. `lib` and `example` are not plugins and are skipped.

Each entry has three parts:

- the prompt, in a code block, to paste into the session (or a shell command for you to run);
- **Expect:** what should happen;
- **If not:** where to look first.

A prompt that says "run exactly" wants the agent to make that one `shell` call
unchanged. When the agent rewrites the command, reply "run it exactly as written".
Before you debug a section, check that the plugin loaded: its skills show in the
skill listing, its agents in the `@` picker, and its tools in a Code Mode `search`.

## Contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Scratch repository](#scratch-repository)
- [Smoke test in 5 minutes](#smoke-test-in-5-minutes)
- Plugins:
  [agent-coder](#agent-coder) ·
  [agent-efficiency](#agent-efficiency) ·
  [agent-mechanic](#agent-mechanic) ·
  [agent-researcher](#agent-researcher) ·
  [agent-reviewer](#agent-reviewer) ·
  [agent-seance](#agent-seance) ·
  [architecture](#architecture) ·
  [aws](#aws) ·
  [beads](#beads) ·
  [build](#build) ·
  [chezmoi](#chezmoi) ·
  [debate](#debate) ·
  [delivery](#delivery) ·
  [dep-update](#dep-update) ·
  [design](#design) ·
  [eli5](#eli5) ·
  [find-tools](#find-tools) ·
  [goal](#goal) ·
  [journeys](#journeys) ·
  [lang-go, lang-python, lang-typescript](#lang-go-lang-python-lang-typescript) ·
  [lang-rust](#lang-rust) ·
  [lsp](#lsp) ·
  [model-roles](#model-roles) ·
  [parley](#parley) ·
  [project](#project) ·
  [quality](#quality) ·
  [safety](#safety) ·
  [session](#session) ·
  [speckit](#speckit) ·
  [statusline](#statusline) ·
  [subagent-worktree](#subagent-worktree) ·
  [toolchain](#toolchain) ·
  [trunk-dev](#trunk-dev) ·
  [whats-new](#whats-new) ·
  [worktrunk](#worktrunk)
- [Cleanup](#cleanup)

## Prerequisites

| Need | For |
| --- | --- |
| OpenCode 2.1.4 or later | every plugin |
| `git` | safety, trunk-dev, worktrunk, subagent-worktree, delivery, beads |
| `bun` | beads (write-lock runner), trunk-dev flag cleanup, safety commit-msg hook |
| `bd` 1.3 or later | beads, speckit, design formulas, journeys formulas, trunk-dev flag cleanup |
| `wt` (Worktrunk) | worktrunk, subagent-worktree merges |
| `gh` (signed in) and a throwaway GitHub repo | delivery landing, pr-bead-link gate, trunk-dev PR advisories, safety close-keywords, agent-reviewer `pr-reviewer` |
| `chezmoi` with at least one managed file | chezmoi |
| `specify` (spec-kit CLI) | speckit `speckit_setup` |
| `python3` 3.11+ | worktrunk-preflight, beads-preflight, journeys `journeys_index` |
| lsp-tools-mcp as MCP server `lsp`, plus `typescript-language-server` | lsp |
| `uv` / `uvx` and the AWS MCP servers in config | aws (optional) |
| `npx` and network access | design `design_impeccable_scan`, dep-update, find-tools |
| Two vendors in the model catalog (for example Bedrock Claude and Bedrock or ChatGPT GPT) | model-roles reviewer vendor flip |
| A premium model (input price at or above $8 per million tokens) | model-roles guard |

## Install

Every server plugin installs from `main` with one command:

```sh
opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/<name>'
```

All of them at once (statusline is TUI-only, see below):

```sh
for p in agent-coder agent-efficiency agent-mechanic agent-researcher agent-reviewer \
  agent-seance architecture aws beads build chezmoi debate delivery dep-update design \
  eli5 find-tools goal journeys lang-go lang-python lang-typescript lang-rust lsp \
  model-roles parley project quality safety session speckit subagent-worktree toolchain \
  trunk-dev whats-new worktrunk; do
  opencode plugin add "github:srobroek/opencode-plugins#main::path:plugins/$p"
done
```

Options go on the plugin's entry in the global `~/.config/opencode/opencode.json`. A
second entry for the same plugin in a project config replaces these options instead of
merging with them. The options these tests use:

```jsonc
{
  "plugins": [
    {
      "package": "github:srobroek/opencode-plugins#main::path:plugins/model-roles",
      "options": { "guard": true }
    },
    {
      "package": "github:srobroek/opencode-plugins#main::path:plugins/parley",
      "options": { "fallback": "question" }
    }
  ],
  "permissions": [
    { "action": "journeys_index", "resource": "prune *", "effect": "ask" },
    { "action": "journey_install_formulas", "resource": "*", "effect": "ask" }
  ]
}
```

The statusline is a TUI plugin, configured in `~/.config/opencode/cli.json`:

```json
{ "plugins": ["github:srobroek/opencode-plugins#main::path:plugins/statusline"] }
```

parley and model-roles also have a TUI entry (`./tui`). It loads from the same install.

## Scratch repository

Run destructive tests here, never in a real checkout. The directory sits in the
OpenCode temp directory, so OpenCode archives the project once you delete it.

```sh
export SCRATCH="${TMPDIR%/}/opencode/manual-tests"
rm -rf "$SCRATCH" && mkdir -p "$SCRATCH" && cd "$SCRATCH"
git init -q --bare origin.git
git init -q -b main repo && cd repo
git remote add origin ../origin.git
echo '{ "branches": ["main"] }' > .releaserc.json
printf '{\n  "name": "probe",\n  "version": "0.0.0",\n  "dependencies": { "left-pad": "1.1.0" }\n}\n' > package.json
mkdir -p migrations src
echo 'CREATE TABLE a (id INTEGER);' > migrations/0001_init.sql
echo 'CREATE TABLE b (id INTEGER);' > migrations/0002_b.sql
echo 'export const add = (a: number, b: number) => a + b' > src/math.ts
git add -A
GIT_AUTHOR_DATE="3 days ago" GIT_COMMITTER_DATE="3 days ago" git commit -q -m "chore: init scratch repo"
git push -q -u origin main && git remote set-head origin main
git branch epic
git switch -q -c feature && git commit -q --allow-empty -m "feat: probe" && git switch -q main
git branch doomed feature
bd init --skip-hooks
unset BEADS_ACTOR BD_ACTOR
opencode
```

What the scratch repo gives the tests:

- `.releaserc.json` makes it a release repository, so the trunk-dev gates apply.
- `origin` is a local bare repository: pushes are harmless, and `delivery_land` sees an
  unknown forge.
- `main` is three days old, so a branch push earns the trunk-dev branch-age advisory.
- `epic` is a non-default merge target for the worktrunk gate.
- `doomed` holds a commit that is not on `main`, for the safety branch-delete check.
- `.beads/` is a live ledger. `BEADS_ACTOR` is unset, so the actor gate fires.

## Smoke test in 5 minutes

Run these in the scratch repository with every plugin installed. Each one exercises a
different hook path.

**1. safety: a force push is denied**

```text
Run exactly: git push --force origin feature
```

**Expect:** denied with `Denied by safety (force-push): ...`, which suggests `--force-with-lease`.
**If not:** `plugins/safety/src/permission.ts` (`force-push`); check `disable` in the safety options.

**2. trunk-dev: a non-conventional commit is refused**

```text
Run exactly: git commit --allow-empty -m "update stuff"
```

**Expect:** refused with ``trunk-dev: Use a Conventional Commit subject such as `feat(scope): summary`...``.
**If not:** `plugins/trunk-dev/src/commit-gate.ts`; the repo needs `.releaserc.json` at its root.

**3. beads: `bd edit` is refused**

```text
Run exactly: bd edit probe-1
```

**Expect:** refused with `` `bd edit` opens $EDITOR and hangs a non-interactive session; ... ``, ending `Disable: set the srobroek.beads plugin option gates.bd-editor-gate.enabled=false`.
**If not:** `plugins/beads/src/shell-gates.ts`; `bd` must be on `PATH`.

**4. model-roles: the tier report**

```text
Call model_roles_check and show me the reviewer tier and which model code-reviewer resolves to.
```

**Expect:** a report listing `cheap`, `standard`, `strong` and `reviewer` with candidate statuses, and `code-reviewer` on a reviewer-tier model.
**If not:** `plugins/model-roles/src/check.ts`; an empty tier means `ctx.model.list()` returned nothing usable.

**5. agent-reviewer: a local review with a verdict**

```text
Create src/div.ts exporting div(a, b) = a / b with no zero check, stage it, then use the code-reviewer agent to review my staged changes.
```

**Expect:** the child reply starts with `VERDICT: APPROVE|REQUEST-CHANGES|COMMENT` and cites `src/div.ts:<line>`.
**If not:** `plugins/agent-reviewer/agents/code-reviewer.md`; its shell is limited to `git diff`, `git log` and `git show`.

**6. lang-rust: the router loads a hidden member**

```text
I'm adding a numbered sqlx migration to a Rust SQLite repository. What are the rules?
```

**Expect:** the agent loads `lang-rust`, then `lang-rust-persistence` by id, and answers from it.
**If not:** the router table in `plugins/lang-rust/skills/lang-rust/SKILL.md`.

**7. safety: the migration gate**

```text
Use the edit tool to change migrations/0001_init.sql so table a gets a name TEXT column.
```

**Expect:** refused with `Blocked by safety (migration-edit): '.../migrations/0001_init.sql' is a migration that has shipped (it is on the default branch)...`, asking for a new migration.
**If not:** `plugins/safety/src/migrations.ts`.

**8. worktrunk: the merge gate**

```text
Run exactly: wt merge epic
```

**Expect:** refused with `worker-to-epic merges must preserve history; retry with wt merge epic --no-squash --no-ff`.
**If not:** `plugins/worktrunk/src/merge-gate.ts`; `git symbolic-ref refs/remotes/origin/HEAD` must print `origin/main`.

**9. goal: the slash command answers**

```text
/goal show
```

**Expect:** `No goal is set for this session.`
**If not:** `plugins/goal/src/index.ts` (command registration).

**10. statusline: the row renders**

Look above the composer.

**Expect:** one row with the session id, host, model, agent, path, `main` and the context percentage.
**If not:** `~/.config/opencode/cli.json` must list the statusline package; restart the TUI.

---

## agent-coder

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/agent-coder'`. No
options. Install the lang-<language> plugins, quality and toolchain too so its skill allowlist has content.

### Agent `coder`

```text
Use the coder agent to add a sub(a, b) function to src/math.ts next to add, with a matching test, and run the tests.
```

**Expect:** the reply starts with `VERDICT: DONE|PARTIAL|BLOCKED` and lists the changed paths and each check's result.
**If not:** `plugins/agent-coder/agents/coder.md` (permission allowlist; it may spawn only `explore` and `mechanic`).

```text
Use the coder agent to find new tools for parsing YAML with find_tools_scan.
```

**Expect:** the agent cannot call `find_tools_scan` (denied) and reports that, or returns `BLOCKED`.
**If not:** the `find_tools_scan` deny in `plugins/agent-coder/agents/coder.md`.

```text
Use the coder agent to plan tests for div in src/div.ts (zero, negative, fractional inputs). Load the testing guidance first and report which skills you loaded.
```

**Expect:** the child loads `quality-testing` (and possibly `lang-typescript`, then `lang-typescript-quality`) and names them. A design or journeys skill is denied.
**If not:** the skill allowlist in `plugins/agent-coder/agents/coder.md`; routers must be allowed next to their hidden members.

## agent-efficiency

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/agent-efficiency'`.
Options: `bashAlias`, `explore`, `leanSubagents` and `leanDrop`, all on by default. `leanDrop`
defaults to `global-instructions`, `identity` and `worktree`. Add `project-instructions` (or use
`instructions` for both) to drop the project `AGENTS.md` too.

### Hook: bash alias

```text
Call the tool named "bash" (not "shell") with {"command": "echo alias-ok"}.
```

**Expect:** the call runs as `shell` and prints `alias-ok`, with no "No tool named bash" error. A model that refuses to call an unlisted tool makes this test inconclusive.
**If not:** `plugins/agent-efficiency/src/index.ts` (`routeShellAlias`); check that no other plugin registers a real `bash` tool.

### Agent shape: lean explore

```text
Use the explore agent to run `ls` in a shell and report the output.
```

**Expect:** explore says it has no shell, and offers `glob` or `read` results instead.
**If not:** `plugins/agent-efficiency/src/explore.ts` (`EXPLORE_PERMISSIONS`); `explore: false` turns it off.

```text
Use the explore agent to find where add is defined in this repo.
```

**Expect:** a report with Summary, Files (`/abs/path:start-end`), Architecture and Sources.
**If not:** `EXPLORE_PROMPT` in `plugins/agent-efficiency/src/explore.ts`.

### Hook: lean subagents

Add a project `AGENTS.md` to the scratch repo first: `echo '# Probe rules' > AGENTS.md`.

```text
Use the adversarial-challenger agent to answer: does your system prompt contain any "Instructions from:" AGENTS.md blocks or a "# Your Model" section? Quote the headings and file paths you see.
```

**Expect:** no block for the global `~/.config/opencode/AGENTS.md` and no `# Your Model` section. The scratch repo's own `AGENTS.md` block is still there, as are the environment block and the date.
**If not:** `plugins/agent-efficiency/src/lean.ts` (`DEFAULT_LEAN_AGENTS`, `DEFAULT_DROP`); a global/project split that misfires shows up as both blocks gone or both kept.

## agent-mechanic

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/agent-mechanic'`.

### Agent `mechanic`

```text
Use the mechanic agent to rename the function add to sum everywhere in this repo, then run `git grep -n "add("`.
```

**Expect:** a reply of at most 120 words that starts with `VERDICT: DONE|PARTIAL|BLOCKED` and lists the changed paths and the check result.
**If not:** `plugins/agent-mechanic/agents/mechanic.md`.

## agent-researcher

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/agent-researcher'`.

### Agent `researcher`

```text
Use the researcher agent to answer: what is the default merge method of `gh pr merge` when none is given? Cite sources.
```

**Expect:** starts with `VERDICT: DONE|BLOCKED`, each claim marked observation or inference with a URL, and a fenced `json` block (`verdict`, `answer`) at the end.
**If not:** `plugins/agent-researcher/agents/researcher.md`. With delivery installed, make sure only one `researcher` registered (`plugins/lib/src/agent-fallback.ts`).

## agent-reviewer

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/agent-reviewer'`.
`pr-reviewer` needs `gh` and a GitHub PR.

### Agent `code-reviewer`

```text
Use the code-reviewer agent to review the diff between main and feature.
```

**Expect:** first line `VERDICT: APPROVE|REQUEST-CHANGES|COMMENT`, with findings cited as `path:line` and no reprinted code.
**If not:** `plugins/agent-reviewer/agents.src/code-reviewer.md` and `plugins/lib/src/review-core.md`.

### Agent `security-reviewer`

```text
Write src/run.ts that passes process.argv[2] to child_process.exec, then use the security-reviewer agent to review src/.
```

**Expect:** first line `VERDICT: PASS|MINOR|MAJOR`, with a CWE-78 command-injection finding at `src/run.ts:<line>`.
**If not:** `plugins/agent-reviewer/agents/security-reviewer.md`; it has no shell and no web access by design.

### Agent `adversarial-challenger`

```text
Use the adversarial-challenger agent to poke holes in this plan: "store session tokens in localStorage to avoid cookie CSRF issues".
```

**Expect:** first line `VERDICT: HOLDS|WEAKENED|REFUTED` (likely WEAKENED or REFUTED), with evidence-backed counter-arguments.
**If not:** `plugins/agent-reviewer/agents/adversarial-challenger.md`.

### Agent `pr-reviewer` (hidden)

```text
Use the pr-reviewer agent to review PR #<n> in <owner>/<repo>.
```

**Expect:** first line `VERDICT: APPROVE|REQUEST-CHANGES|COMMENT`. It runs only `gh pr view` and `gh pr diff`. It does not show in the `@` picker.
**If not:** `plugins/agent-reviewer/agents/pr-reviewer.md` (`hidden: true`, shell allowlist).

### Skill `review-security` (hidden, by id)

```text
Load the review-security skill and use it to trace untrusted input to sinks in src/run.ts.
```

**Expect:** the skill loads by id, and the answer maps entry points to sinks in a CWE table.
**If not:** `plugins/agent-reviewer/skills/review-security/SKILL.md` (`opencode/autoinvoke: false`, so it only loads by id).

## agent-seance

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/agent-seance'`.
Needs at least one earlier session in the project.

### Tool `seance_read`

```text
Call seance_read with no arguments.
```

**Expect:** this project's top-level sessions, newest first (up to 15), ending with a token estimate.
**If not:** `plugins/agent-seance/src/read.ts` (`listSessions`).

```text
Call seance_read with session set to the newest session id from that list and max_chars 4000.
```

**Expect:** turns oldest first: user requests, assistant prose, one-line tool results, and child sessions with their agent.
**If not:** `readSession` in `plugins/agent-seance/src/read.ts`. A session outside the project asks for `external_directory`.

### Agent `seance`

```text
Use the seance agent to tell me what the previous session in this project changed and why.
```

**Expect:** first line `VERDICT: ANSWERED|PARTIAL|NOT_FOUND`, `ses_…[turn]` evidence, and gaps, in at most 250 words.
**If not:** `plugins/agent-seance/agents/seance.md`; it reaches `seance_read` through Code Mode `execute`.

## architecture

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/architecture'`.

### Skill `architecture-guide` (router) → `architecture-top-level`

```text
Should this repo have apps/ and libs/ at the top level, or a capability-first layout?
```

**Expect:** loads `architecture-guide`, then `architecture-top-level`.
**If not:** the router table in `plugins/architecture/skills/architecture-guide/SKILL.md`.

### → `architecture-ownership`

```text
Where should a generated API client and its OpenAPI schema live in this repo?
```

**Expect:** loads `architecture-guide`, then `architecture-ownership`.
**If not:** same router table.

### → `architecture-docs-files`

```text
Infer this project's architecture and stack, and write it down as a durable knowledge file under docs/.
```

**Expect:** loads `architecture-guide`, then `architecture-docs-files`.
**If not:** same router table.

### Agent `architect`

```text
Use the architect agent to design a plugin system for this repo's math module, with an ordered implementation plan.
```

**Expect:** first line `VERDICT: DESIGNED|PARTIAL|BLOCKED`. It makes no edits and runs no shell commands.
**If not:** `plugins/architecture/agents/architect.md`. Its `explore` spawns need `experimental.subagent_depth` of 2 or more.

## aws

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/aws'`. Optional:
the `aws-mcp` and `aws-pricing` servers from `plugins/aws/README.md`, `uv`, and AWS credentials.

### Skill `aws-guidance`

```text
How do I create an S3 bucket with versioning using the AWS CLI, and what will it cost per month for 100 GB?
```

**Expect:** loads `aws-guidance`, searches the AWS MCP server first, and prices with `aws-pricing`. Without the servers, it says which checks it could not run.
**If not:** `plugins/aws/skills/aws-guidance/SKILL.md`; check the MCP server config.

## beads

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/beads'`. Needs
`bd` and `bun`. Every gate is on by default (`{ "gates": { "<gate>": { "enabled": false } } }`).
Unset `BEADS_ACTOR` and `BD_ACTOR` before you start OpenCode, so the actor gate fires.

First create a bead to test against, and note its id as `<id>`:

```text
Run exactly: BEADS_ACTOR=manual/test bd create "probe" -t task --json
```

**Expect:** a JSON issue. The command runs under `bd-embedded-write-runner` (visible when your shell permission asks).
**If not:** `plugins/beads/src/bd-embedded-write-lock.ts`; `bun` must be on `PATH`.

### Gate `bd-editor-gate`

```text
Run exactly: bd edit <id>
```

**Expect:** refused, because `bd edit` opens `$EDITOR`. The message names `bd update ID --<field>` and `bd comment`.
**If not:** `plugins/beads/src/shell-gates.ts`.

### Gate `bd-update-close-gate`

```text
Run exactly: BEADS_ACTOR=manual/test bd update <id> --status closed
```

**Expect:** refused with ``Use `bd close ID --reason "<factual reason>"` instead.``
**If not:** `plugins/beads/src/bd-update-close-gate.ts`.

### Gate `bd-unclaim-gate`

```text
Run exactly: BEADS_ACTOR=manual/test bd unclaim <id>
```

**Expect:** refused with `bd unclaim requires a non-empty --if-assignee compare-and-swap guard`.
**If not:** `plugins/beads/src/bd-unclaim-gate.ts`.

### Gate `bd-actor-gate`

```text
Run exactly: bd create "no actor" -t task
```

**Expect:** refused with ``bd create / `bd new` / `bd create-form` without BEADS_ACTOR or BD_ACTOR records the invoking human's git identity...``.
**If not:** `plugins/beads/src/bd-actor-gate.ts`; check that `BEADS_ACTOR` is not set in OpenCode's environment.

```text
Run exactly: bd update <id> --claim
```

**Expect:** refused, because a claim without an actor creates dead claims.
**If not:** same file.

### Gate `binary-git-hooks`

In your own terminal: `cp /bin/echo "$SCRATCH/repo/.git/hooks/pre-commit"`. Then:

```text
Run exactly: bd hooks install
```

**Expect:** refused, because an existing hook is a binary. Afterwards, `rm "$SCRATCH/repo/.git/hooks/pre-commit"`.
**If not:** `plugins/beads/src/binary-hooks.ts`.

### Gate `bd-close-gate`

Run the [design](#design) `design_setup` test first, so the formulas exist. Then:

```text
Run `BEADS_ACTOR=manual/test bd mol pour design-touch --var surface=/ --var scope=src`, then `bd gate list`, then run exactly `BEADS_ACTOR=manual/test bd close <gate-id> --reason probe` on the first gate.
```

**Expect:** the close is refused with `blocked by beads (a gate bead is resolved, never closed): <gate-id> is a gate...`.
**If not:** `plugins/beads/src/bd-close-gate.ts` (looks the bead up with `bd show`).

### Gate `bead-agent-routing` (FO-5)

```text
Run exactly: BEADS_ACTOR=manual/test bd create "route probe" -t task --metadata '{"execution_agent_type":"researcher"}' --json
```

Then, with the new id:

```text
Use the mechanic agent to work on bead <new-id>.
```

**Expect:** the spawn is refused with `FO-5: the spawn goes to 'mechanic', but the bead it names routes elsewhere: ...`.
**If not:** `plugins/beads/src/subagent-routing.ts`; the id must carry the ledger prefix.

```text
Use the implementer-high agent to answer one question about bead <id>: what is its title?
```

**Expect:** the spawn runs, and its result carries an advisory to use `implementer` unless the brief states an implementer-high criterion. Needs delivery.
**If not:** `HIGH_TIER_AGENT` in `plugins/beads/src/subagent-routing.ts`.

### Gate `pr-bead-link-gate` (needs a GitHub repo with a live ledger)

```text
In my GitHub sandbox repo, run exactly: gh pr create --title "fix: probe" --body "no trailer here"
```

**Expect:** refused with `This PR names no bead. A live ledger requires a Bead: <id>, Closes-Bead: <id>, or Bead-Id: <id> trailer...`.
**If not:** `plugins/beads/src/pr-bead-link-gate.ts` (needs write permission on the repo).

### Hook: `bd prime` context

```text
Without running any command, tell me how your instructions say a bead should be closed.
```

**Expect:** the answer follows `bd prime` (`bd close <id> --reason ...`), which shows the prime text is in the system prompt.
**If not:** the `beads-prime` gate in `plugins/beads/src/prime.ts`.

### Hook: subagent actor

```text
Use the general agent to run `bd create "child probe" -t task --json` and report the created_by field.
```

**Expect:** `created_by` is `opencode/<root>/general/<session>`, and the actor gate does not fire.
**If not:** `plugins/beads/src/shell-gates.ts` (`export BEADS_ACTOR=` prefix).

### Lifecycle: stop nudge and release

```text
Run exactly: BEADS_ACTOR=manual/test bd update <id> --claim
Then stop and do nothing else.
```

**Expect:** after the turn ends, a queued message lists the claim with its guarded release command, and the session resumes. If it stops again still holding the claim, a later message reports the claim released.
**If not:** `plugins/beads/src/lifecycle.ts` and the `beads-stop-nudge` gate. Goal mode suppresses the nudge.

### Skill `beads-guide` (router) → `beads-setup`

```text
bd says "no beads database found" in a fresh clone. How do I set up the ledger and its Dolt remote?
```

**Expect:** loads `beads-guide`, then `beads-setup`.
**If not:** the router table in `plugins/beads/skills/beads-guide/SKILL.md`.

### → `beads-preflight`

```text
Run a beads preflight on this repo before I start ledger work.
```

**Expect:** loads `beads-preflight` and runs its read-only `preflight.py`.
**If not:** `plugins/beads/skills/beads-preflight/preflight.py`; needs `python3`.

### → `beads-ledger`

```text
Plan three beads for adding a sub function: acceptance criteria, metadata and dependencies.
```

**Expect:** loads `beads-ledger` before it proposes any `bd create`.
**If not:** same router table.

### → `beads-evidence`

```text
What evidence do I need before I close bead <id>?
```

**Expect:** loads `beads-evidence`.
**If not:** same router table.

### → `beads-contention-retry`

```text
bd dolt push failed with "lock busy". What now?
```

**Expect:** loads `beads-contention-retry`.
**If not:** same router table.

## build

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/build'`.

### Agent `external-repo-worker`

```text
Use the external-repo-worker agent to clone https://github.com/srobroek/opencode-plugins, and report the check command its AGENTS.md lists. Do not commit or push.
```

**Expect:** it clones under `/tmp/agentic/external-repos/opencode-plugins-XXXXXX` (asking for `external_directory`) and replies with changed files (none), the verification line and no publish steps.
**If not:** `plugins/build/agents/external-repo-worker.md`. The safety `worktree-tmp` gate does not apply to clones.

## chezmoi

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/chezmoi'`. Needs
`chezmoi`. Pick a managed file from `chezmoi managed --path-style=absolute | head`. If the
guard fails and the write lands, restore the file with `chezmoi apply <file>`.

### Guard: edit tool

```text
Use the edit tool to append the line "# probe" to <managed file>.
```

**Expect:** refused with `'<file>' is a chezmoi-managed target, not the source; the next chezmoi apply overwrites it. Edit the source at '<source path>'...`.
**If not:** `plugins/chezmoi/src/guard.ts`; `chezmoi managed` must answer within 2 s.

### Guard: shell write

```text
Run exactly: echo '# probe' >> <managed file>
```

**Expect:** the same refusal, from the redirect target.
**If not:** `writtenPaths` in `plugins/lib/src/tool-targets.ts`.

### Skill `chezmoi-editor`

```text
Change my global git config to set pull.rebase=true. My dotfiles are managed with chezmoi.
```

**Expect:** loads `chezmoi-editor`, edits the source file (`chezmoi source-path`), then runs `chezmoi apply`.
**If not:** `plugins/chezmoi/skills/chezmoi-editor/SKILL.md`.

## debate

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/debate'`. With
parley installed, question rounds open in the parley panel.

### Skill `debate`

```text
Debate it: should this project use SQLite or Postgres for its first release?
```

**Expect:** loads `debate`, argues both sides and gives a conditional verdict.
**If not:** `plugins/debate/skills/debate/SKILL.md`.

### Skill `grilling`

```text
Grill me on my plan to rewrite the CLI in Rust.
```

**Expect:** loads `grilling` and asks numbered rounds (in the parley panel when it is installed).
**If not:** `plugins/debate/skills/grilling/SKILL.md`.

### Skill `to-questionnaire`

```text
Write a questionnaire for my product manager about which login providers we must support.
```

**Expect:** loads `to-questionnaire` and writes the questionnaire to a named path or `~/tmp`.
**If not:** `plugins/debate/skills/to-questionnaire/SKILL.md`.

## delivery

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/delivery'`.
Options: `confirm`, `receiptsDirectory`, `agents`, `models`, `fanOut` and `verdicts`. Nested
spawns need `experimental.subagent_depth` of 2 or more. A real landing needs `gh` and a
GitHub sandbox repo.

### Tool `delivery_land` (scratch: unknown forge)

```text
Call delivery_land with pr 1 in this repo.
```

**Expect:** refused with `repo.forge: observed "unknown" for remote origin at ..., expected "github" or "gitlab"`, with no permission prompt, because the refusal comes before any write.
**If not:** `plugins/delivery/src/land.ts`.

### Tool `delivery_land` (GitHub sandbox)

```text
Call delivery_land for PR #<n> with merge_method squash, expectHeadSha <head sha>, requireGreenChecks false.
```

**Expect:** a permission prompt for `delivery_land` on `<owner>/<repo>#<n>`, then a merge and a receipt under `~/.omp/receipts/<repo-key>/`.
**If not:** `plugins/delivery/src/land.ts` and `approval.ts`; `confirm: false` skips the prompt.

### Tool `delivery_cleanup`

```text
Call delivery_cleanup for the receipt delivery_land just wrote.
```

**Expect:** a permission prompt for `delivery_cleanup` with the worktree path, then `git worktree remove` and `git branch -d`. Called from inside that worktree, it refuses.
**If not:** `plugins/delivery/src/cleanup.ts`.

### Hook: fan-out instructions

```text
Without loading any skill, what do your instructions say about splitting work across subagents?
```

**Expect:** the answer quotes the "Fan-out delivery" summary and names the `delivery-fan-out` skill.
**If not:** `plugins/delivery/instructions/delivery-fan-out.md`; `fanOut: false` turns it off.

### Hook: verdict parsing

```text
Use the operator agent to run `git log --oneline -1` and report it. Then tell me the verdict the subagent tool result recorded in metadata.delivery.
```

**Expect:** `VERDICT: DONE` and a fenced `json` block in the reply; `metadata.delivery.verdict` is `DONE`. A reply that breaks the format is `MALFORMED`, with a note naming the session to continue.
**If not:** `plugins/delivery/src/verdict.ts`; `verdicts: false` turns it off.

### Agent `implementer`

```text
Use the implementer agent to add a mul(a, b) function to src/math.ts in its own worktree and report its branch head.
```

**Expect:** `VERDICT: DONE|BLOCKED|SPLIT` and a closing `json` block with the branch head. With subagent-worktree installed, it runs in a fresh worktree.
**If not:** `plugins/delivery/agents/implementer.md`.

### Agent `implementer-high`

```text
Use the implementer-high agent to find the root cause of why 0.1 + 0.2 !== 0.3 would break a money total in src/math.ts, and fix it.
```

**Expect:** `VERDICT: DONE|BLOCKED|SPLIT` on the `strong` tier (or Opus `#high` without model-roles).
**If not:** `plugins/delivery/agents/implementer-high.md`.

### Agent `operator`

```text
Use the operator agent to run exactly `git status --short` and record the result.
```

**Expect:** `VERDICT: DONE|BLOCKED` on the `cheap` tier (or Haiku without model-roles).
**If not:** `plugins/delivery/agents/operator.md`.

### Agent `shepherd`

```text
Use the shepherd agent to land PR #<n> in my GitHub sandbox repo.
```

**Expect:** it requires exact-head approval and green checks, calls `delivery_land`, closes beads, runs `delivery_cleanup`, and replies `VERDICT: COMPLETE|BLOCKED`.
**If not:** `plugins/delivery/agents/shepherd.md`.

### Agents `researcher` and `pr-reviewer` (fallback copies)

Uninstall agent-researcher and agent-reviewer, restart, then rerun the
[researcher](#agent-researcher) and [pr-reviewer](#agent-pr-reviewer-hidden) prompts.

**Expect:** the same verdict formats, now from delivery's copies with their fallback models.
**If not:** `FALLBACK_AGENTS` in `plugins/delivery/src/agents.ts`.

### Skill `delivery-git-workflow`

```text
Which merge method should I use for this PR, and what is the order of land, bead close and cleanup?
```

**Expect:** loads `delivery-git-workflow`.
**If not:** `plugins/delivery/skills/delivery-git-workflow/SKILL.md`.

### Skill `delivery-fan-out` (hidden, by id)

```text
Load the delivery-fan-out skill, then split "add sub, mul and div to src/math.ts with tests" into units and briefs. Do not dispatch.
```

**Expect:** the skill loads by id, and the plan names independent units, briefs, tiers and one worktree per writer.
**If not:** `plugins/delivery/skills/delivery-fan-out/SKILL.md`.

## dep-update

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/dep-update'`.
Option `confirm` (default `true`). The scratch `package.json` pins `left-pad` `1.1.0`.

### Tool `dep_scan`

```text
Call dep_scan on this repo.
```

**Expect:** `left-pad` 1.1.0 classified with a newer version (`MINOR-CHECK` for 1.3.0); the scan is read-only.
**If not:** `plugins/dep-update/src/index.ts`; needs network access to npm.

### Tool `dep_apply` (permission prompt)

```text
Call dep_apply with ecosystem npm, name left-pad, version 1.3.0.
```

**Expect:** a permission prompt for `dep_apply` on `left-pad@1.3.0`, even after an earlier "allow always". Approve it, and `package.json` pins 1.3.0.
**If not:** `plugins/dep-update/src/bump.ts`; `DEP_UPDATE_PKG_MANAGER` picks the package manager.

### Hook: scanner-install advisory

```text
Run exactly: uv tool install pip-audit
```

**Expect:** the result ends with `dep-update: this command installed a CVE scanner persistently...`, suggesting `uvx pip-audit`. Afterwards, `uv tool uninstall pip-audit`.
**If not:** `plugins/dep-update/src/scanner-install.ts`.

### Skill `dep-update`

```text
Upgrade this project's dependencies safely.
```

**Expect:** loads `dep-update`, runs `dep_scan`, and applies patch and minor bumps one at a time, each behind a prompt.
**If not:** `plugins/dep-update/skills/dep-update/SKILL.md`.

## design

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/design'`.
Option `confirmScan` (default `true`). `design_setup` needs `.beads/`; the scan needs `npx`.
The browser steps need the desktop browser tools, a browser MCP server or Playwright.

### Tool `design_setup`

```text
Call design_setup for this repo.
```

**Expect:** nine formulas copied into `.beads/formulas/`, and `bd formula list` shows them. The tool checks the `design_setup` permission on the repository path, so it prompts only when a rule asks.
**If not:** `plugins/design/src/formulas.ts`; a divergent copy needs `force=true`.

### Tool `design_impeccable_scan`

```text
Write src/index.html with a centered purple gradient hero, then call design_impeccable_scan on src/index.html.
```

**Expect:** a permission prompt before every run, then the detector's JSON (exit 2 means findings).
**If not:** `plugins/design/src/impeccable.ts`; `confirmScan: false` skips the prompt.

### Skill `design-guide` (router) and its members

Each prompt should load `design-guide`, then the named member. If one does not, check the
router table in `plugins/design/skills/design-guide/SKILL.md`.

```text
Write a DESIGN.md for this project.
```

**Expect:** `design-md`.

```text
What tokens does this project use for color and spacing?
```

**Expect:** `design-system-audit`.

```text
Prototype a settings page for this app: what's the best way to produce it?
```

**Expect:** `design-prototype`.

```text
Mock up a confirm-delete dialog as an inline SVG wireframe.
```

**Expect:** `wireloom`.

```text
Add a fade-in animation to the toast component that respects reduced motion.
```

**Expect:** `motion-design`.

```text
Fix the wording of this error: "Error 500: operation failed".
```

**Expect:** `ui-microcopy`.

```text
Review this UI: http://localhost:3000/settings
```

**Expect:** `ui-review`.

```text
Is this page accessible? Check it against WCAG: src/index.html
```

**Expect:** `accessibility-audit`.

```text
Critique src/index.html: does it look AI-generated, and which interaction states are missing?
```

**Expect:** `design-no-slop`.

```text
Is the submit button on src/index.html visible at 375 px wide? Prove it.
```

**Expect:** `design-evidence`.

```text
Style the hero in src/index.html with a new #7a3cff accent and 18px padding.
```

**Expect:** `design-token-discipline`.

```text
Write a Storybook story for the Button component with every variant prop.
```

**Expect:** `design-component-truth`.

```text
Before you route this to an upstream design skill, check what needs installing: produce a slide deck for the design review.
```

**Expect:** `design-upstream-preflight` (next to `design-prototype`).

### Agent `ui-ux-specialist`

```text
Use the ui-ux-specialist agent to redesign the settings flow in src/ (three screens).
```

**Expect:** phased work (GROUND, GATE INTENT, …), spawns only `design-critic`, `a11y-auditor`, `explore` or `general`, and replies `VERDICT: COMPLETE|PARTIAL|BLOCKED`.
**If not:** `plugins/design/agents/ui-ux-specialist.md`; nested spawns need `experimental.subagent_depth` of 2 or more.

### Agent `ui-implementer`

```text
Use the ui-implementer agent to build a small card component in src/card.html on the project's tokens.
```

**Expect:** verified at 1440, 768 and 375 px, with `VERDICT: COMPLETE|PARTIAL|ESCALATE|BLOCKED`.
**If not:** `plugins/design/agents/ui-implementer.md`.

### Agent `design-critic`

```text
Use the design-critic agent to critique src/index.html.
```

**Expect:** read-only, first line `VERDICT: PASS|MINOR|MAJOR`.
**If not:** `plugins/design/agents.src/design-critic.md`.

### Agent `a11y-auditor`

```text
Use the a11y-auditor agent to audit src/index.html against WCAG 2.2 AA.
```

**Expect:** measured values (contrast ratios, target sizes), first line `VERDICT: PASS|MINOR|MAJOR`.
**If not:** `plugins/design/agents.src/a11y-auditor.md`; the primary route is the `accessibility-scanner` MCP server.

## eli5

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/eli5'`.

### Skill `eli5`

```text
ELI5: how does a git rebase work?
```

**Expect:** loads `eli5` and starts from a metaphor. A plain "explain rebase" should not load it.
**If not:** `plugins/eli5/skills/eli5/SKILL.md`.

## find-tools

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/find-tools'`.
Options `guardInstalls` (default `true`) and `skillCatalogs`. The `github` source needs
`gh`; `smithery` needs `SMITHERY_API_KEY`.

### Tool `find_tools_scan`

```text
Call find_tools_scan with query "postgres schema migration".
```

**Expect:** per-source statuses (`ok`, `empty`, `partial`, `skipped`, `failed`) for local, catalog, mcp_registry, npm, github, awesome_opencode, smithery and skills_cli, plus gaps and a coverage count. Nothing is installed.
**If not:** `plugins/find-tools/src/scan.ts`.

### Guard: install prompt

```text
Run exactly: npx skills add some-org/some-skill
```

**Expect:** a permission prompt that says `find-tools: this runs the skills CLI to install a skill...`. Reject it.
**If not:** `plugins/find-tools/src/install-gate.ts`; `guardInstalls: false` turns it off.

### Skill `find-tools`

```text
Find a tool for generating changelogs from Conventional Commits. Should I adopt one or build it?
```

**Expect:** loads `find-tools`, scans, vets, and ends with a decision table (`Use existing`, `Adopt`, `Trial`, `Reject` or `Build`) without installing anything.
**If not:** `plugins/find-tools/skills/find-tools/SKILL.md`.

## goal

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/goal'`.
Options `delayMs`, `maxContinuations` and `conditionTimeoutMs`.

### Command `/goal`

```text
/goal Create notes.txt containing the word done, verify it with cat, then finish the goal.
```

**Expect:** the agent works on it, synthetic "Goal: continue #n" turns follow, and it ends by calling `goal_complete`, with `Goal complete. Automatic continuation has stopped...`.
**If not:** `plugins/goal/src/controller.ts`; goals do not run in subagents or with the `plan` agent.

```text
/goal show
```

**Expect:** `Goal (<status>)`, the objective and usage; with no goal, `No goal is set for this session.`
**If not:** `plugins/goal/src/goal.ts`.

```text
/goal budget 50k
```

**Expect:** `Goal budget updated.` followed by the goal description.
**If not:** `parseBudget` in `plugins/goal/src/goal.ts`.

```text
/goal pause
```

**Expect:** `Goal paused. /goal resume continues it.` Then `/goal resume` restarts it, and `/goal drop` answers `Goal dropped.`
**If not:** `goalCommand` in `plugins/goal/src/controller.ts`.

### Tools `goal_get` and `goal_complete`

```text
/goal Say hello. Then call goal_get and show me its output, then call goal_complete with empty evidence.
```

**Expect:** `goal_get` returns the objective, status and budget. `goal_complete` with empty evidence is rejected, either by its input schema or with `goal_complete needs evidence: ...`, and the goal stays active.
**If not:** `plugins/goal/src/goal.ts`.

### Command `/loop`

```text
/loop 2 append the current time to loop.txt
```

**Expect:** the prompt runs, then repeats twice, then `Loop limit reached. Loop mode disabled.`
**If not:** `plugins/goal/src/loop.ts`.

```text
/loop --until 'test -f done.txt' if done.txt does not exist, create it
```

**Expect:** it stops with `Loop condition test -f done.txt is now satisfied. Loop mode disabled.`
**If not:** `plugins/goal/src/condition.ts`.

```text
/loop
```

**Expect:** `Loop mode enabled. ...`. Sending `/loop` again answers `Loop mode disabled.` With a loop on, `/goal x` is refused.
**If not:** `loopCommand` in `plugins/goal/src/controller.ts`.

## journeys

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/journeys'`. Add
the two `permissions` rules from [Install](#install) to get prompts. Formulas need `.beads/`.

### Skill `journeys-guide` (router) and its members

Each prompt should load `journeys-guide`, then the named member. If one does not, check
`plugins/journeys/skills/journeys-guide/SKILL.md`.

```text
Set up user journeys in this repo.
```

**Expect:** `journey-init`, which interviews you and scaffolds `user-journeys/` with `FORMAT.md` and `journeys.py`.

```text
Write a user journey for "a user adds two numbers with the math module".
```

**Expect:** `journey-write`.

```text
Validate all user journeys against the running product.
```

**Expect:** `journey-verify`.

```text
Validate only the journeys my feature branch changes affect.
```

**Expect:** `journey-verify-changed`.

```text
Run a journey campaign: validate every journey with validators in parallel, fix defects and re-validate until green.
```

**Expect:** `journey-campaign`.

```text
Consolidate the journeys checkpoint: flush the delta logs and prune old runs.
```

**Expect:** `journey-consolidate`, which asks for approval first.

### Tool `journeys_index`

```text
Call journeys_index with command lint and journeysDir user-journeys.
```

**Expect:** lint output and an exit code, with no permission prompt.
**If not:** `plugins/journeys/src/journeys-tool.ts`; needs `python3`.

```text
Call journeys_index with command prune, journeysDir user-journeys, keep 0, yes true.
```

**Expect:** a permission prompt for `journeys_index` on `prune user-journeys *all*`. Reject it.
**If not:** your `permissions` rule; the default policy allows unknown actions.

### Tool `journey_install_formulas`

```text
Call journey_install_formulas with repoRoot set to this repo.
```

**Expect:** a permission prompt for the repository root, then both formulas in `.beads/formulas/`.
**If not:** `plugins/journeys/src/index.ts`; symlinked paths are refused.

### Agent `journey-scribe`

```text
Use the journey-scribe agent to draft a journey for adding two numbers, from src/math.ts as evidence.
```

**Expect:** a structured summary of journeys created, evidence references and lint status, with no reprinted journey bodies.
**If not:** `plugins/journeys/agents/journey-scribe.md`.

### Agent `journey-validator`

```text
Use the journey-validator agent to validate user-journeys/<journey>.md.
```

**Expect:** per-step results with triage and a recorded run file. It never edits product code.
**If not:** `plugins/journeys/agents/journey-validator.md`.

## lang-go, lang-python, lang-typescript

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/lang-<language>'` for
`lang-go`, `lang-python` and `lang-typescript`. Each lists one router, `lang-<language>`.

### Skill `lang-typescript` (router) → `lang-typescript-quality`

```text
Run the TypeScript lint and type-check for this repo.
```

**Expect:** loads `lang-typescript`, then `lang-typescript-quality`, and runs `tsc --noEmit` (or Biome or ESLint).
**If not:** `plugins/lang-typescript/skills/lang-typescript/SKILL.md`.

### `lang-python` → `lang-python-quality`

```text
Run the Python format, lint, type-check and tests for this project.
```

**Expect:** `lang-python`, then `lang-python-quality` (`ruff check`, `ruff format --check`, `pyright`, `pytest`).
**If not:** `plugins/lang-python/skills/lang-python/SKILL.md`.

### `lang-go` → `lang-go-quality`

```text
Run the Go lint and tests.
```

**Expect:** `lang-go`, then `lang-go-quality` (`gofmt -l`, `golangci-lint run` or `go vet`, `go test ./...`).
**If not:** `plugins/lang-go/skills/lang-go/SKILL.md`.

### → `lang-typescript-profiling`, `lang-python-profiling`, `lang-go-profiling`

Install `quality` too.

```text
Speed up this Python script.
```

**Expect:** loads `quality-profiling` (or `lang-python`), then `lang-python-profiling` (py-spy, scalene, memray). Asking the same for a Bun script or a Go service routes to `lang-typescript-profiling` (`--cpu-prof`, heap profiles, mitata) or `lang-go-profiling` (pprof, `go test -bench`, benchstat).
**If not:** the language table in `plugins/quality/skills/quality-profiling/SKILL.md`, or the profiling row of the language's router.

## lang-rust

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/lang-rust'`. The plugin
ships skills only; the former `rust` advisories are now guidance in `lang-rust-ci`.

### Skill `lang-rust` (router) and its members

Each prompt should load `lang-rust`, then the named member. If one does not, check
`plugins/lang-rust/skills/lang-rust/SKILL.md`.

```text
Run clippy and the tests for this Rust crate.
```

**Expect:** `lang-rust-quality`.

```text
Set up GitHub Actions CI for this Rust workspace with rust-cache and a required-check gate.
```

**Expect:** `lang-rust-ci`.

```text
Split this Rust crate so the domain has no IO, behind a lib.rs facade.
```

**Expect:** `lang-rust-crate-boundaries`.

```text
Add workspace lints and move shared versions into workspace.dependencies.
```

**Expect:** `lang-rust-workspace`.

```text
Define a thiserror error enum and a serde-transparent UserId newtype.
```

**Expect:** `lang-rust-domain-modeling`.

```text
Add a Rust crate for persistence: a sqlx repository with a compare-and-swap update inside a transaction.
```

**Expect:** `lang-rust-persistence`.

```text
Generate TypeScript bindings for my Rust IPC commands and guard against codegen drift.
```

**Expect:** `lang-rust-contract-boundary`.

```text
Implement a plan/approve/apply flow for file mutations in Rust with TOCTOU checks.
```

**Expect:** `lang-rust-safe-mutation`.

```text
Set up the Tauri v2 updater and code signing for my desktop app.
```

**Expect:** `lang-rust-tauri`.

```text
Profile this Rust binary and set up criterion benchmarks with a saved baseline.
```

**Expect:** `lang-rust-profiling` (samply, cargo flamegraph, criterion baselines).

## lsp

**Install:** a language server (`npm i -g typescript typescript-language-server`),
lsp-tools-mcp at the pinned commit registered as MCP server `lsp` with `codemode: false`
(see `plugins/lsp/README.md`), then
`opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/lsp'`. Options:
`tool`, `timeout`, `maxLines` and `baseline`.

### Hook: new errors after an edit

```text
Use the write tool to create src/bad.ts containing: export const n: number = "x"
```

**Expect:** the tool result ends with `LSP: 1 new error after this edit`, then `src/bad.ts` and the TypeScript 2322 error.
**If not:** `plugins/lsp/src/index.ts`; check that `lsp_diagnostics` is in the tool list.

```text
Use the edit tool to add a blank line at the top of src/bad.ts.
```

**Expect:** no LSP lines, because the existing error is in the baseline and only moved.
**If not:** `newErrors` in `plugins/lsp/src/diagnostics.ts`.

## model-roles

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/model-roles'`,
with `"guard": true` in its global options. Use a model catalog with at least two vendors
(for example Bedrock Claude and GPT, or a Claude and a ChatGPT sign-in), and one premium
model for the guard.

### Tool `model_roles_check`

```text
Call model_roles_check and summarize it.
```

**Expect:** each tier's source (`config`, `derived`, …), effort and candidates with a status (available, unknown id, …); the model of every tiered agent; the `tier` values the subagent tool offers; derived lineups; dropped models grouped by reason.
**If not:** `plugins/model-roles/src/check.ts`.

### Tier per spawn

```text
Spawn the general agent with tier "cheap" to summarize package.json in one line. Then tell me which model the child ran on.
```

**Expect:** the child runs on the first available `cheap` candidate from `model_roles_check` (Haiku on Bedrock), not the session model.
**If not:** `plugins/model-roles/src/spawn-role.ts`; the statusline in the child session shows the model.

```text
Spawn the general agent with tier "bogus" to say hi.
```

**Expect:** rejected: either the `tier` enum fails validation, or the plugin refuses and lists the valid tiers.
**If not:** same file.

### Pin precedence

Add `"agents": { "code-reviewer": { "model": "<a cheap provider/model>" } }` to
`opencode.json`, then:

```text
Call model_roles_check and find code-reviewer. Then spawn the code-reviewer agent with tier "strong" to review the last commit, and tell me the model it ran on.
```

**Expect:** the check lists code-reviewer as `pinned in config; tier not applied`, and the spawn runs on the pinned model with the `tier` dropped. Remove the pin afterwards.
**If not:** `userPin` in `plugins/model-roles/src/resolve.ts`.

### Reviewer vendor flip

Start the session on a Claude model, then:

```text
Use the code-reviewer agent to review the last commit. Tell me the provider/model the child ran on.
```

**Expect:** the child runs on a non-Anthropic candidate (for example GPT), because `reviewer` puts another vendor first. Switch the session to a GPT model and repeat; the child now runs on Claude.
**If not:** the `distinctVendor` line for `reviewer` in `model_roles_check`; both vendors must be in the catalog.

### Guard on premium models

Start the session on a premium model, then:

```text
Spawn the general agent with model set to <the premium provider/model> to say hi.
```

**Expect:** refused with `This spawn sets model <model> itself, and that model is expensive.`, plus ``Drop `model` and pass tier: "<cheapest>" ...``.
**If not:** `plugins/model-roles/src/guard.ts`; `guard` must be on, and `premium` defaults to $8 per million input tokens.

Add `"agents": { "general": "default" }` to the model-roles options (so `general` inherits), then:

```text
Use the general agent to say hi.
```

**Expect:** refused with `Subagent 'general' has no model and no resolvable tier, so it would inherit this session's expensive model ...`, naming the cheapest tier. Remove the option afterwards.
**If not:** `guard.allowInherit` and `guard.expensive` in your options.

### TUI: `/tiers`

1. Type `/tiers` (or pick **Model tiers** in the command palette).
2. Pick `cheap`, then **Effort**, then `medium`.
3. Reopen `/tiers`, pick **Add a tier…**, enter `docs` and a purpose.

**Expect:** the list shows each tier and what it resolves to now; each answer is written to `options.tiers` of the model-roles entry in the global config, with comments kept, and `model_roles_check` shows the change without a restart.
**If not:** `plugins/model-roles/src/tui.tsx` and `config-edit.ts`; an entry only in a project config is not edited, and `/tiers` says so.

## parley

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/parley'`.
Options: `fallback` (`"none"` or `"question"`), `ui` and `heartbeat_window_s`.

### Tool `parley_ask` and the panel

```text
Call parley_ask with three questions: a pick_one with a recommendation, a slider from 0 to 10, and a rank of three options.
```

**Expect:** the full-screen panel opens with the recommendation preselected. Change one answer, defer one with a note (`d`, `n`), press `esc`, run `/parley`, check the edits survived, then press `ctrl+s`. The result lists each id with its status (`answered`, `accepted`, `deferred`) and note.
**If not:** `plugins/parley/src/panel.tsx` and `tui.tsx`; the TUI must check in within `heartbeat_window_s`.

### Tool `parley_wait`

```text
Call parley_ask with one confirm question and wait "none", then call parley_wait.
```

**Expect:** the ask returns `open` at once; `parley_wait` blocks until you answer, then returns only the new answer.
**If not:** `plugins/parley/src/service.ts`.

### Tool `parley_end`

```text
Call parley_end with message "thanks".
```

**Expect:** `Parley closed.`, or `No open round; done.` when nothing is open.
**If not:** `plugins/parley/src/index.ts`.

### Fallback without a TUI

```sh
opencode run "Call parley_ask with one pick_one question about tabs versus spaces."
```

**Expect:** `unavailable` (`no_tui`), or with `fallback: "question"` the question arrives through the built-in `question` tool.
**If not:** `plugins/parley/src/fallback.ts`.

## project

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/project'`.

### Skill `license-picker`

```text
What license should I use for this repo? It's a library I want companies to use, but I want patches shared back.
```

**Expect:** loads `license-picker`, asks structured questions, recommends an OSI license, and offers to write `LICENSE`.
**If not:** `plugins/project/skills/license-picker/SKILL.md`.

## quality

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/quality'`.

### Skill `quality-code-design`

```text
Debug this: add(0.1, 0.2) in src/math.ts does not equal 0.3. Use red-green-refactor.
```

**Expect:** loads `quality-code-design`, picks INVESTIGATE or IMPLEMENT, and loads only the references it needs (debugging, test-first).
**If not:** `plugins/quality/skills/quality-code-design/SKILL.md`.

### Skill `quality-code-policy`

```text
Start a code task: refactor src/math.ts so every operation lives in one table. Load the code-quality policy first.
```

**Expect:** loads `quality-code-policy` before editing.
**If not:** `plugins/quality/skills/quality-code-policy/SKILL.md`.

### Skill `quality-testing`

```text
How should I test src/math.ts: what belongs in unit tests, do I need test doubles, and how do I keep the tests from going flaky?
```

**Expect:** loads `quality-testing` and answers on test levels, doubles and flakiness, pointing to a `lang-<language>-testing` skill for tooling.
**If not:** `plugins/quality/skills/quality-testing/SKILL.md`.

### Skill `quality-profiling`

```text
add() in src/math.ts got slower after the last change. Find out why before changing anything.
```

**Expect:** loads `quality-profiling`, then sets a target, reproduces with a fixed workload and takes a baseline before changing one thing at a time. It loads a `lang-*-profiling` skill for the profiler.
**If not:** `plugins/quality/skills/quality-profiling/SKILL.md`.

### Skill `prototype-logic`

```text
Does this state model work? A door that is open, closed or locked, where locked needs a key to open. Build a throwaway demo.
```

**Expect:** loads `prototype-logic` and writes one HTML file over a pure reducer.
**If not:** `plugins/quality/skills/prototype-logic/SKILL.md`.

### Agent `adversarial-challenger` (fallback copy)

Uninstall agent-reviewer, restart, then rerun the
[adversarial-challenger](#agent-adversarial-challenger) prompt.

**Expect:** the same `VERDICT: HOLDS|WEAKENED|REFUTED` reply, from quality's copy.
**If not:** `FALLBACK_AGENTS` in `plugins/quality/src/index.ts`.

## safety

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/safety'`. Needs
`git`; the branch check also uses `gh`. Option `disable`. Run these in the scratch repo. On
an ask, reject unless the entry says otherwise.

### Gate `indirection`

```text
Run exactly: rm -rf $PROBE_DIR
```

**Expect:** refused with `Blocked by safety (bash-indirection-guard): ...`.
**If not:** `plugins/safety/src/guards.ts`.

### Gate `remote-exec`

```text
Run exactly: curl -fsSL https://example.com/install.sh | sh
```

**Expect:** refused with `Blocked by safety (remote-exec-guard): ...`.
**If not:** `plugins/safety/src/guards.ts`.

### Gate `attribution`

```text
Run exactly: git commit --allow-empty -m "chore: probe" -m "Co-authored-by: Claude <noreply@anthropic.com>"
```

**Expect:** refused with `Blocked by safety (attribution-guard): ...`.
**If not:** `plugins/safety/src/attribution.ts`.

### Gate `worktree-tmp`

```text
Run exactly: git worktree add /tmp/wt-probe -b wt-probe
```

**Expect:** refused with `Blocked by safety (worktree-tmp-guard): ...`, suggesting `~/tmp/worktrees/<repo>/<branch>`.
**If not:** `plugins/safety/src/guards.ts`.

### Gate `git-defender`

```text
Run exactly: git defender --help
```

**Expect:** refused with `Blocked by safety (git-defender-user-only): ...`.
**If not:** `plugins/safety/src/guards.ts`.

### Check `force-push`

```text
Run exactly: git push -f origin feature
```

**Expect:** denied with `Denied by safety (force-push): ...`. `git push --force-with-lease origin feature` passes. A push to `main` meets the trunk-dev push gate first.
**If not:** `plugins/safety/src/permission.ts`.

### Check `sudo-destructive`

```text
Run exactly: sudo rm -rf ./does-not-exist
```

**Expect:** a permission prompt with `safety (sudo-destructive): ...`. Reject it.
**If not:** `plugins/safety/src/permission.ts`.

### Check `worktree-destruction`: branch delete

```text
Run exactly: git branch -D doomed
```

**Expect:** a prompt with `safety (worktree-destruction-guard): ...`, the commit not in `main`, and the `git branch doomed <sha>` restore command. A branch whose tip is already on `main` deletes without a prompt.
**If not:** `plugins/safety/src/branch-delete.ts`.

### Check `worktree-destruction`: reset, stash and clean

```text
Run `echo dirty >> package.json` as one command. Then, as a separate command, run exactly: git reset --hard
```

**Expect:** the reset prompts, listing `package.json` as dirty and `Restore: git reset --hard <sha>`. Reject, then `git checkout package.json`.
**If not:** `resetRisk` in `plugins/safety/src/permission.ts`.

```text
Run `echo x > stash-probe.txt && git stash -u`, then run exactly: git stash drop
```

**Expect:** the drop prompts, with the entry's SHA and `git stash store` to restore it.
**If not:** `plugins/safety/src/permission.ts`.

```text
Run exactly: git clean -fd
```

**Expect:** a prompt (`deletes untracked files with git clean -f`). `git clean -nd` passes.
**If not:** same file.

### Gate `migration-edit`

The scratch repo's `0001_init.sql` and `0002_b.sql` are on `main`, so both have shipped.

```text
Use the edit tool to add a column to migrations/0001_init.sql.
```

**Expect:** refused with `Blocked by safety (migration-edit): '.../migrations/0001_init.sql' is a migration that has shipped (it is on the default branch)...`.
**If not:** `plugins/safety/src/migrations.ts`.

```text
Run exactly: echo '-- probe' >> migrations/0002_b.sql
```

**Expect:** the same refusal for `0002_b.sql`, for a shell write.
**If not:** `writtenPaths` in `plugins/lib/src/tool-targets.ts`.

```text
Create migrations/0003_c.sql with CREATE TABLE c (id INTEGER); then use the edit tool to add a name TEXT column to it.
```

**Expect:** both are allowed: `0003_c.sql` is new on this branch (untracked), so it stays editable. Delete it afterwards.
**If not:** the merge-base check in `plugins/safety/src/migrations.ts`; `SAFETY_ALLOW_MIGRATION_EDIT=1` or `disable: ["migration-edit"]` turns the gate off.

### Check `external-directory`: directory flags

```text
Run exactly: git -C /tmp status
```

**Expect:** a permission prompt for `external_directory` on the `/tmp` directory, as for a `cd /tmp`. Reject it. `git -C . status` runs without a prompt.
**If not:** `plugins/safety/src/flag-directories.ts`.

### Rewrite `close-keywords` (needs a GitHub repo)

```text
In my GitHub sandbox repo, run exactly: gh pr create --title "fix: probe" --body "Fixes #1, #2" --dry-run
```

**Expect:** the command that runs (and the permission prompt, if shell asks) reads `Fixes #1, fixes #2`.
**If not:** `plugins/safety/src/close-keywords.ts`.

### Advisory `package-investigate`

```text
Run exactly: npm i -D is-number
```

**Expect:** the result ends with `Before adding or changing a dependency, investigate the package...`, once per package per session. `npm install` alone does not trigger it.
**If not:** `plugins/safety/src/package-investigate.ts`.

### commit-msg hook (opt-in)

```sh
bun <path-to-safety-plugin>/dist/commit-msg.js install --repo "$SCRATCH/repo"
git -C "$SCRATCH/repo" commit --allow-empty -m "chore: probe" -m "Generated with Claude Code"
```

**Expect:** the terminal commit is rejected by the hook. `uninstall` removes it.
**If not:** `plugins/safety/src/commit-msg.ts`; `core.hooksPath` makes `install` refuse.

## session

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/session'`.
Options `api` and `omp`. Needs an earlier session in the project.

### Tool `session_resume`

```text
Call session_resume with mode "list".
```

**Expect:** root sessions across every worktree, newest first; with a `query`, a clear winner is marked `★ recommended`.
**If not:** `plugins/session/src/rank.ts` and `source.ts`.

```text
Call session_resume with mode "read" and session set to the second session in that list.
```

**Expect:** the goal, compaction Objective and Next Move, beads commands, files touched, branch drift, and the newest turns first, within 14000 characters, ending with a token estimate.
**If not:** `plugins/session/src/resume.ts`.

### Skill `resume-session`

```text
Resume my session: continue where I left off on the math module.
```

**Expect:** loads `resume-session`, lists the candidates, asks you to confirm one, reads it, writes a short handoff, and waits.
**If not:** `plugins/session/skills/resume-session/SKILL.md`.

## speckit

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/speckit'`,
next to beads. Needs `specify` for setup and `bd` for the guards. Options: `integration`,
`tasksGuard`, `implementRedirect`, `blockTasksToIssues`, `workflow` and `agents`.

### Tool `speckit_setup`

```text
Call speckit_setup for this repo.
```

**Expect:** each phase reported `done`, `skipped` or `failed`: specify init, extensions, beads formulas, and the `.gitignore` entry. A rerun skips completed phases.
**If not:** `plugins/speckit/src/setup.ts`; `specify` must be on `PATH`.

### Tool `speckit_start`

```text
Call speckit_start with spec "001-demo".
```

**Expect:** `CHOICE_REQUIRED`, with a question about routine approvals. Answer it, and the call again with `approvals` returns `READY`, naming the run root.
**If not:** `plugins/speckit/src/spec-start.ts`; the spec must match `NNN-slug`.

### Guard: `tasks.md`

```text
Use the write tool to create specs/001-demo/tasks.md with "- [ ] T001 probe".
```

**Expect:** refused with `blocked by speckit (task state lives in beads, tasks.md is never authored): ...`.
**If not:** `plugins/speckit/src/tasks-guard.ts`; `bd where` must succeed in the repo.

```text
Run exactly: echo '- [ ] T001' > specs/001-demo/tasks.md
```

**Expect:** the same refusal, for a shell write. `cat specs/001-demo/tasks.md` still runs.
**If not:** same file.

### Route: `speckit-implement` redirect

After `speckit_setup` has installed the spec-kit skills:

```text
Load the speckit-implement skill and summarize what it tells you to do.
```

**Expect:** the content is the beads route (work the task beads under the molecule's `implement` step), not "tick tasks.md".
**If not:** `plugins/speckit/src/skills.ts`; `implementRedirect: false` turns it off.

### Route: taskstoissues refusal

```text
Load the speckit-taskstoissues skill.
```

**Expect:** the skill tool refuses to load it, and the content explains that beads is the tracker.
**If not:** `plugins/speckit/src/skills.ts`; `blockTasksToIssues: false` turns it off.

### Hook: workflow instructions

In a new session in the repo once `.specify/` exists:

```text
Without loading any skill, what does the "SpecKit workflow (srobroek.speckit)" section of your instructions say?
```

**Expect:** the agent quotes the workflow contract. In a repo without `.specify/`, it finds no such section.
**If not:** `plugins/speckit/src/workflow.ts`; `workflow: false` turns it off.

### Skill `speckit-setup`

```text
Set up SpecKit in this repo.
```

**Expect:** loads `speckit-setup` and calls `speckit_setup`.
**If not:** `plugins/speckit/skills/speckit-setup/SKILL.md`.

### Skill `speckit-bugfix`

```text
Fix a bug in this SpecKit repo: add(1, 2) returns "12" when given strings.
```

**Expect:** loads `speckit-bugfix` (and `quality-code-design`), and offers to bond `mol-speckit-bugfix` for a tracked trail.
**If not:** `plugins/speckit/skills/speckit-bugfix/SKILL.md`.

### Agent `speckit-sync`

```text
Use the speckit-sync agent with scope drift on specs/001-demo.
```

**Expect:** a structured sync result with scope, verdict, findings and evidence. It makes no edits.
**If not:** `plugins/speckit/agents/speckit-sync.md`.

### Agent `speckit-verify`

```text
Use the speckit-verify agent with mode requirements on specs/001-demo.
```

**Expect:** first line `VERDICT: PASS|GAPS`.
**If not:** `plugins/speckit/agents.src/speckit-verify.md`.

## statusline

**Install:** TUI only. Add `"github:srobroek/opencode-plugins#main::path:plugins/statusline"` to
`plugins` in `~/.config/opencode/cli.json` and restart the TUI. Options: `segments`,
`separator` and `pathMaxLength`.

### Row content

1. Open a session in the scratch repo and send one prompt.
2. Edit a file so the git segment shows a change count.

**Expect:** one row above the composer: session id (8 chars, accent colour), host, model and variant, agent, path, `main *1`, then `context %`, title, `↑in ↓out ⟳cache ✎write`, tok/s and time spent.
**If not:** `plugins/statusline/src/tui.tsx`; it refetches on `session.execution.succeeded` and `vcs.branch.updated`.

### Options

Set `"options": { "segments": ["session", "model", "git"], "separator": "plain" }` and restart.

**Expect:** only those three segments, separated by ` · `.
**If not:** `plugins/statusline/src/format.ts`.

### Truncation

Narrow the terminal to about 80 columns.

**Expect:** the title drops first, then right-side segments from the far end; the left side truncates last.
**If not:** `plugins/statusline/src/format.ts`.

## subagent-worktree

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/subagent-worktree'`.
Needs `git`; merging needs `wt`. Options `agents` (default `implementer`, `implementer-high`,
`general`) and `base`.

### Hook: writer gets a worktree

```text
Use the general agent to create hello.txt containing "hi" and commit it with message "chore: add hello".
```

**Expect:** the child runs in a fresh `subagent-…` worktree, and the result ends with a `<subagent-worktree>` block (branch, base, target, commit count, diff command, merge hint). The main checkout has no `hello.txt`.
**If not:** `plugins/subagent-worktree/src/index.ts`; a read-only agent or a child-of-child gets no worktree.

### Tool `subagent_worktree_merge`

```text
Call subagent_worktree_merge with method "list".
```

**Expect:** each active lane in the project with branch, path, commits ahead, dirty state and session existence; orphans are flagged.
**If not:** `plugins/subagent-worktree/src/lane.ts`.

```text
Call subagent_worktree_merge with the child sessionID from that result and method "wt-merge".
```

**Expect:** a permission check for `subagent_worktree_merge` on the lane branch (it prompts only when a rule asks), then `wt merge main --no-squash --no-ff --yes`. `hello.txt` lands on `main`, and the worktree is removed.
**If not:** the overlap and dirty checks in `plugins/subagent-worktree/src/index.ts`; `wt` must be on `PATH`.

### Argument: `worktree`

Make a second worktree first: `git worktree add -q ../repo-side -b side`.

```text
Use the explore agent with worktree "side" to list the top-level files and report the absolute path of the directory you are in.
```

**Expect:** the child reports a path under `../repo-side`, not the main checkout. The `subagent` tool's input lists `worktree` next to `tier` when model-roles is installed.
**If not:** `plugins/subagent-worktree/src/index.ts` (the `worktree` transform and the session move).

```text
Use the explore agent with worktree "/tmp" to list files.
```

**Expect:** refused with `worktree "/tmp" is not a worktree of this project; pass the path or branch of one of: ...`. Remove the side worktree afterwards with `git worktree remove ../repo-side`.
**If not:** `plugins/subagent-worktree/src/lane.ts`.

### Hook: no-op lane cleanup

```text
Use the general agent to read package.json and tell me the name field. Make no changes.
```

**Expect:** the worktree is removed when the child finishes with no commits and a clean tree.
**If not:** `plugins/subagent-worktree/src/index.ts` (`execute.after`).

## toolchain

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/toolchain'`.

### Skill `toolchain-guide` (router) and its members

Each prompt should load `toolchain-guide`, then the named member. If one does not, check
`plugins/toolchain/skills/toolchain-guide/SKILL.md`.

```text
Which package manager and task runner should this new TypeScript project use?
```

**Expect:** `toolchain-stack-defaults`.

```text
Which test runner and linter should I pick for a Go service?
```

**Expect:** `toolchain-languages`.

```text
Which frontend framework and server-state library should this dashboard use?
```

**Expect:** `toolchain-frontend`.

```text
Should I use Terraform, CDK or Helm to deploy this service?
```

**Expect:** `toolchain-infrastructure`.

```text
Add structured logging, tracing and a security scanner to this worker.
```

**Expect:** `toolchain-quality-observability`.

```text
I want to add a new OpenCode skill for myself. Where should it live and who owns it?
```

**Expect:** `toolchain-asset-ownership`.

```text
Set up a shared, size-bounded compiler cache for my worktrees.
```

**Expect:** `ops-toolchain-cache-policy`.

```text
Set CARGO_TARGET_DIR=~/.cache/cargo-target in my zshrc so all projects share it.
```

**Expect:** `ops-no-global-cargo-target`, which advises against it.

```text
Write a GitHub Actions workflow for this TypeScript repo with a required-check gate, a matrix and pinned actions.
```

**Expect:** `ci-github-actions`.

### Listed skills

```text
Another agent is editing this checkout and keeps switching the branch under me. What should I do?
```

**Expect:** loads `coexistence-worktree`.
**If not:** `plugins/toolchain/skills/coexistence-worktree/SKILL.md`.

```text
Review this script for portability and quoting: for f in $(ls *.txt); do cat $f; done
```

**Expect:** loads `shell-language`.
**If not:** `plugins/toolchain/skills/shell-language/SKILL.md`.

```text
Write a Terraform module for an S3 bucket with environment-specific stacks.
```

**Expect:** loads `terraform-language`.
**If not:** `plugins/toolchain/skills/terraform-language/SKILL.md`.

```text
Run terraform state rm aws_s3_bucket.old for me.
```

**Expect:** loads `infrastructure-tfstate-guard` before any state operation, and asks first.
**If not:** `plugins/toolchain/skills/infrastructure-tfstate-guard/SKILL.md`; a hard gate needs the permission rules in `plugins/toolchain/README.md`.

```text
Add retries with idempotency keys and a dead-letter queue to this queue worker.
```

**Expect:** loads `backend-background-jobs`.
**If not:** `plugins/toolchain/skills/backend-background-jobs/SKILL.md`.

## trunk-dev

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/trunk-dev'`.
Needs `git`. The PR advisories need `gh` and a GitHub sandbox repo; the flag-cleanup bead
also needs `bd`, `bun` and the beads plugin. Option
`{ "disable": ["commit-gate", "skip-ci", "mr-advisory", "flag-cleanup"] }`.

### Gate: commit subject

```text
Run exactly: git commit --allow-empty -m "update stuff"
```

**Expect:** refused with ``trunk-dev: Use a Conventional Commit subject such as `feat(scope): summary`, or set TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1 to override.``
**If not:** `plugins/trunk-dev/src/commit-gate.ts` and `release-repo.ts`.

```text
Run exactly: TRUNK_DEV_ALLOW_NONCONVENTIONAL_COMMIT=1 git commit --allow-empty -m "update stuff"
```

**Expect:** the commit goes through.
**If not:** same file.

### Gate: push to main

```text
Run exactly: git push origin main
```

**Expect:** refused with `trunk-dev: Do not push directly to main/master; push to a branch and open an MR (or set TRUNK_DEV_ALLOW_MAIN_PUSH=1 to override).`
**If not:** `plugins/trunk-dev/src/commit-gate.ts`.

### Advisory: skip-CI marker

```text
Run exactly: git commit --allow-empty -m "chore: probe [skip ci]"
```

**Expect:** the commit runs, and the result ends with `trunk-dev: this command's commit/MR/PR text contains a skip-CI marker...`.
**If not:** `plugins/trunk-dev/src/skip-ci.ts`.

### Advisory: branch age

```text
Run exactly: git push -u origin feature
```

**Expect:** the push runs, and the result ends with `trunk-dev: This topic branch is based on a commit 3 days old; ...`.
**If not:** `plugins/trunk-dev/src/mr-advisory.ts`; the scratch `main` commit must be backdated.

### Advisory: PR title, Flag line, squash (GitHub sandbox)

```text
In my GitHub sandbox repo, run exactly: gh pr create --title "feat: add probe" --body "no flag line"
```

**Expect:** the result ends with ``trunk-dev: every `feat` MR/PR ships behind a feature flag; add a `Flag: <name> ...` line``. A title like `update` adds the Conventional Commits title note, and `gh pr merge <n>` without `--squash` adds the squash note.
**If not:** `plugins/trunk-dev/src/mr-advisory.ts`.

### Flag-cleanup bead (GitHub sandbox and beads)

Open and merge a PR whose body has `Flag: probe-flag (default off; owner me; remove by 2026-12-31)`
with `gh pr merge <n> --squash`.

**Expect:** one open chore `chore: remove feature flag probe-flag`, due 2026-12-31, with `metadata.trunk_dev_flag`.
**If not:** `plugins/trunk-dev/src/flag-cleanup.ts`; when the runner refuses, the result carries the exact `bd create` command.

### Skill `trunk-dev-guide` (router) and its members

Each prompt should load `trunk-dev-guide`, then the named member. If one does not, check
`plugins/trunk-dev/skills/trunk-dev-guide/SKILL.md`.

```text
I'm about to open a PR for this branch. What's the trunk-based workflow for branching, CI and merging it?
```

**Expect:** `trunk-dev-workflow`.

```text
This is a feat change. What should the PR's Flag: line say, and how do I roll the flag out?
```

**Expect:** `trunk-dev-feature-flags`.

```text
Set up semantic-release on GitHub for this repo, with a stale-branch job.
```

**Expect:** `trunk-dev-release-setup`.

## whats-new

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/whats-new'`.

### Tool `version_gap_scan`

Run this before the dep-update tests, which change `package.json` and add a lockfile.

```text
Call version_gap_scan on this repo.
```

**Expect:** one tab-separated row: `npm	left-pad	1.1.0	?	direct` (`?` because there is no lockfile).
**If not:** `plugins/lib/src/dep-detect.ts`.

### Agent `whats-new` and skill `whats-new`

Switch to the `whats-new` agent (mode `all`, so it is in the agent switcher), then:

```text
What's new in left-pad since the version this project uses? Is it safe to upgrade?
```

**Expect:** loads the `whats-new` skill, starts from `version_gap_scan`, and writes a report of breaking changes, deprecations and features. It changes nothing.
**If not:** `plugins/whats-new/skills/whats-new/SKILL.md`.

### Guard: report-only

In the `whats-new` agent:

```text
Run exactly: env npm install left-pad@latest
```

**Expect:** denied with `blocked by whats-new (report-only): ...`. Editing `package.json` is denied too.
**If not:** `decideEvaluation` in `plugins/whats-new/src/report-only.ts`. A plain `npm install *` hits the static rule, with the host's generic deny message instead.

## worktrunk

**Install:** `opencode plugin add 'github:srobroek/opencode-plugins#main::path:plugins/worktrunk'`.
Needs `wt`, `git` and `python3` 3.11+. Option `strategy` (default `true`).

### Worktree strategy

```text
Use tools.opencode.worktree_create to create a worktree named wt-probe, then run `wt list`.
```

**Expect:** created by `wt switch --create` at the path from Worktrunk's `worktree-path` template on branch `wt-probe`, and `wt list` shows it. Remove it with `tools.opencode.worktree_remove`.
**If not:** `plugins/worktrunk/src/worktree.ts`; Worktrunk `pre-start` hooks can block creation.

### Gate: merge without history flags

```text
Run exactly: wt merge epic
```

**Expect:** refused with `worker-to-epic merges must preserve history; retry with wt merge epic --no-squash --no-ff`.
**If not:** `plugins/worktrunk/src/merge-gate.ts`.

### Gate: merge from the target branch

```text
Run `git switch -q epic` as one command. Then, as a separate command, run exactly: wt merge epic --no-squash --no-ff
```

**Expect:** refused with `worker-to-epic merges must run from the source worktree; ...`. Switch back with `git switch -q main`.
**If not:** same file.

### Gate: opaque merge

```text
Run exactly: cmd="wt merge epic"; eval "$cmd"
```

**Expect:** refused with `opaque dynamic shell body names a merge or land command; retry with a literal command`.
**If not:** `collectCommands` in `plugins/worktrunk/src/merge-gate.ts`.

### Skill `worktrunk-preflight`

```text
Preflight Worktrunk for this repo before I start an agent run.
```

**Expect:** loads `worktrunk-preflight` and runs its read-only `preflight.py`: `wt`, hook approvals, default branch, provisioning hooks.
**If not:** `plugins/worktrunk/skills/worktrunk-preflight/preflight.py`.

### Skill `worktrunk-worktrees`

```text
This repo uses Worktrunk. Fix a typo in package.json's name field.
```

**Expect:** loads `worktrunk-worktrees`, and makes the edit in a linked worktree (`wt switch --create`), not in the canonical checkout.
**If not:** `plugins/worktrunk/skills/worktrunk-worktrees/SKILL.md`.

## Cleanup

```sh
rm -rf "${TMPDIR%/}/opencode/manual-tests"
```

Also remove anything the tests left outside the scratch directory:

- worktrees made by `worktree_create` or subagent-worktree: `wt list`, then `wt remove`;
- `uv tool uninstall pip-audit`;
- test pins and options added to `opencode.json` (`agents.code-reviewer.model`,
  `"agents": { "general": "default" }`) and any tiers `/tiers` wrote;
- receipts under `~/.omp/receipts/` from the GitHub sandbox landing;
- the safety commit-msg hook, if you installed it outside the scratch repo.
