# delivery

Lands pull requests with proof, cleans up after them, and ships the delivery
agents and instructions for fanning work out to subagents.

Ported from the omp-plugins `delivery` plugin (1.4.3 plus the land-fetch fix).
`delivery_hygiene_report` and the `worktree-reaper` agent were not ported: use
`wt list` for an inventory. A receipt for a branch whose worktree still exists
means `delivery_cleanup` has not run yet (or `delivery_land` could not finish it).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/delivery'
```

The implementer agents spawn `explore`, `operator` and `researcher`. Nested
subagents need `experimental.subagent_depth` of at least 2 in your config.

## Tools

| Tool | What it does |
| --- | --- |
| `delivery_land` | Proves a pull or merge request landed (merging it at most once) and writes one landing receipt. |
| `delivery_cleanup` | Removes the receipt's worktree and local branch after proving the landing and the bead close-out, then writes a continuation receipt. |

Both tools take JSON Schema input and declare an output schema, so Code Mode
callers get typed results. The same fields (without the full receipt) are stored
in the tool result's `metadata`. Both tools honour cancellation: an interrupt ends
the running `git`, `gh` or `glab` command. `delivery_cleanup` stops honouring it
once `git worktree remove` starts, so a removal is never left half done.

### delivery_land

Inputs: `pr`, and when needed `merge_method` (`squash` by default, `merge`,
`rebase`), `repo`, `remote`, `expectHeadSha`, `worktree`, `beadId`,
`setupAutoDelete`, `requireApproval`, `requireGreenChecks`, `queueWaitSeconds`.

Requires Git 2.38 or newer: the content proof compares the landed tree with
`git merge-tree --write-tree`. An older or unreadable Git refuses before any merge is issued.

- `expectHeadSha` is required whenever the call would merge. The merge is bound to
  that head (`gh pr merge --match-head-commit`, `glab mr merge --sha`), so a push
  between the read and the merge fails at the forge.
- `worktree` is recorded for cleanup, and its HEAD must be the PR head. Without
  it, the linked worktree that has the PR's branch checked out at the PR head is
  recorded; if none does, no worktree is recorded.
- `repo` selects, among the session repository's own remotes, the one whose URL
  names `repo`; it must still match that remote. `delivery_land` works only in the
  session repository: a `worktree` that is not one of its worktrees, or a `repo` it
  has no remote for, is refused before any Git runs in the other checkout. To land a
  pull request of another repository, run `delivery_land` from a session there.
  Local reads also run with `GIT_NO_LAZY_FETCH=1` and `log.showSignature=false`.
  The network operations are the explicit fetch of the landed commits and the check
  that the remote branch is gone. On GitHub the tool reads both branch refs (the head
  branch's absence and the base branch's tip) through the GraphQL API with your `gh`
  login. It fetches the commits over HTTPS from `https://github.com/<owner>/<repo>.git`,
  with `gh auth git-credential` as the only credential helper. The fetch runs as a
  throwaway bare repository whose only config is its own two `core` lines, and it writes
  into the session repository's object directory. No SSH runs, and no checkout, home or
  system `http.*`, `credential.*` or `url.*` setting reaches the request that carries
  your token. On GitLab both use the selected remote's own transport
  (`git ls-remote` and `git fetch`, with plain `ssh` on SSH remotes). A `worktree` that
  passes the ownership check is pinned (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`), so Git does
  not rediscover it through a `.git` marker that changes afterwards.
- `requireApproval` reads the approval from the PR. On GitHub that is an
  `APPROVED` review whose commit is the head. If reviewer and author share one
  account, it can instead be a comment by that account whose first line is
  `VERDICT: APPROVE` and whose body names the head SHA. On GitLab the approvals
  API must report `approved: true` at the head. GitLab does not tie an approval
  to a commit.
- `requireGreenChecks` requires every `gh pr checks` entry to pass (or be
  skipped), with at least one check present. On GitLab the head pipeline must have
  succeeded on the head.
- A squash uses the PR title as the commit subject.
- Merge queues need a paid GitHub plan or a public repository. On a private repository
  whose plan has none, the rules read fails with `(HTTP 403)` and "Upgrade to GitHub Pro or
  make this repository public to enable this feature"; the tool then takes that as "no
  merge queue possible", lands directly through the proofs below, and records the plan gate
  in the receipt notes. Any other failed rules read, including a 403 with another message,
  still refuses.
- A GitHub base branch with a merge queue (an active `merge_queue` rule, read from
  `GET /repos/{owner}/{repo}/rules/branches/{branch}`) takes no direct merge. The tool
  checks approval and checks as above, then enqueues the reviewed head with the
  `enqueuePullRequest` mutation and `expectedHeadOid`, so GitHub refuses a head that is
  not `expectHeadSha`. It never runs a direct merge or auto-merge there. It polls the
  pull request's `mergeQueueEntry` (5 s, doubling to 60 s) for up to `queueWaitSeconds`
  (default 600, at most 3600).
  - Merged: the tool re-reads the PR, requires the same head and base, and proves the
    merge commit GitHub names (`mergeCommit`) by shape and by base containment (the
    compare API must report it in the base branch's history). The queue builds on its own
    integration branch, so the shape is judged per the queue's method (`merge_method`
    must be omitted or match it): squash is one parent, any parent (a grouped entry
    follows its predecessor); merge is two parents with the reviewed head an ancestor
    (not necessarily the second parent); rebase is ordered `git patch-id --stable`
    equivalence. Then it writes the receipt. The queue entry's `headCommit` is the
    integration commit and is never compared with the reviewed head.
  - Every queue read must be for the authorized repository, PR number and base, and the
    enqueue only follows a read whose `headRefOid` is `expectHeadSha`.
  - Still queued when the wait ends: the result is `ok: false, queued: true`, which is
    not final. Call again with the same inputs; an entry for that head is waited on and
    not enqueued twice, and a PR that has merged is proved as usual. A small
    `pending-queue-<pr>-<head>.json` record next to the receipts remembers the enqueue.
    The tool writes it before it sends the mutation, to a temporary file that it then
    links into place, so it never replaces a record another call made. GitHub may queue
    the PR even when the answer is lost (a timeout, an exit without GraphQL errors, an
    unreadable reply), so the record stays then. A resumed
    call that finds no entry refuses as removed and does not enqueue again. It clears
    the record, so the next call decides afresh. A GraphQL rejection clears the record
    at once. That decision and the enqueue run under a per-head `.lock` file, and the call
    reads the queue again once it holds the lock, so an entry another call made in the
    meantime is waited on, not taken for a removal. A call that overlaps another call's
    enqueue refuses and leaves its record alone. Each record carries a generation, and a
    call deletes a record only under the lock and only while it still carries the
    generation that call wrote or read, so an older call never deletes a newer enqueue's
    record. A queue that merged the PR before this call saw an entry also gets a record,
    written before the proof, so a retry after a failed proof still judges the queue's
    shape. No call removes another call's lock; a lock an interrupted call left is named
    in the refusal, to delete after checking the queue.
  - A record that exists but does not parse, or that names another landing, refuses.
    The tool never reads it as "never enqueued". Check the queue on GitHub, delete the
    file the refusal names, and call again.
  - A call that finds the PR already MERGED takes the queue's method from the record.
    After the receipt is written, it takes the method from that validated receipt. A
    re-proof (to record a worktree, say) then uses the queue's proof again.
  - Removed from the queue (failed checks, conflict, closed) or a changed head: refused,
    with no other merge attempted.
  - A failed rules read, or a rules response with a malformed element, refuses, because a
    direct merge into a queue branch would enqueue the PR on its own. A 404 counts as no
    rule only when the repository itself reads back. A branch without a queue rule is
    merged directly, as before.
- After the merge the tool reads the PR again and fetches the landed commits by id
  (falling back to the base branch, with three attempts over about 7 seconds). It
  then checks the commit shape for the method:
  - squash: one parent;
  - merge: two parents, with the reviewed head second;
  - rebase: ordered `git patch-id --stable` equivalence with the reviewed commits.
  The landed commit must also be in the history of the base branch tip, which the tool
  reads (through the API on GitHub, with `git ls-remote` on GitLab) and fetches by id.
  Its tree must equal the reviewed head
  merged onto its first parent, or for a rebase onto the commit the chain starts from.
  These checks run for direct merges, queue landings, resumed
  calls and already-MERGED PRs alike. An already-MERGED PR names no method, so one
  parent passes as a squash or, if that fails, as a rebase chain proved by patch id.
- The tool never writes the Beads ledger. When the receipt's `beads.ledgerActive`
  is true, `next` lists the `bd update` / `bd close` commands to run, children
  first, before `delivery_cleanup`.
- With the `autoCleanup` option (default true) and no active ledger, `delivery_land`
  then runs the same cleanup in-process with the receipt it just wrote: the same
  proofs, and a non-force removal through OpenCode's registry when it tracks the
  worktree. The result gains `cleanup: { ok, reason?, removed?, localRefDeleted? }`.
  A cleanup refusal never turns the landing into an error; `next` keeps
  `delivery_cleanup` until cleanup finishes. With an active ledger cleanup is not
  attempted (`cleanup.skipped`), because it proves the beads are closed and those
  closes come first. `autoCleanup: false` keeps the two-call flow.
  Cleanup still refuses a worktree that moved past the landed head (`worktree.HEAD`,
  `worktree.branch`) or that is not clean (changes, an operation in progress, a stash).
- **One remover per worktree.** A worktree that `subagent-worktree` created as a lane is
  claimed by a file under the git common directory
  (`<common>/opencode/lane-claims/<sha1 of the directory>.json`, which every worktree of
  the repository shares and neither plugin has to import the other to read). While a claim
  exists, or cannot be read, delivery never removes that worktree, inline or in the
  background. It writes what it knows to `<common>/opencode/landings/<receiptId>.json`
  (the landed head, the landing session, a denial) for the owner to read, and the result
  reports `cleanup: { ok: false, deferred: "owned by subagent-worktree lane" }`.
- With an active ledger inline cleanup cannot run, so delivery retries it itself for
  worktrees nothing owns: after each `session.execution.succeeded`,
  `session.execution.failed` and `session.idle` (debounced 2 s per session, plus the
  `experimental.idle` hook when the host has it) it re-runs `delivery_cleanup`'s proofs
  for this repository's receipts whose worktree is still there, at most once per receipt
  every 5 s and at most 20 receipts per pass, least recently looked at first (receipts that
  are denied or owned take no slot). Open beads make the proof refuse and the retry is
  silent; once they close, the next turn end removes the worktree. Immediately before the
  removal, after the proofs, it checks ownership again (the claim file, and every page of
  the sessions in the directory; a lookup that fails or is incomplete holds). The session
  that ran `delivery_land` gets one reminder, when it goes idle with beads still open,
  naming the beads and their close commands. The retry runs only while `autoCleanup` is
  on, and no prompt is shown for it.
- An explicit `delivery_cleanup` of a worktree a lane owns, or whose claim cannot be read,
  is authorized and re-arms any earlier denial on disk, then stops: it returns
  `{ ok: true, deferred: "owned by subagent-worktree lane; removed by its owner once finished" }`
  and removes nothing. The owner removes it when the lane is finished and landed.
- The coordination files (landing records, denials, claim checks) are written whatever
  `autoCleanup` says; the option turns off only delivery's own inline cleanup and retry.
  The last check before any removal delivery makes on its own also re-reads the landing
  records for that directory: a denial, or a record that cannot be read, blocks it.
- The idle hook also records the `background` list as holds on disk
  (`<common>/opencode/holds/…`, the same format `subagent-worktree` writes): a shell that names the
  worktree, or any job of a session working in it. The last check before a removal reads them, so
  running background work keeps the worktree. Landing records are dropped only on positive evidence
  (their own receipt readable and cleaned or superseded); a denial is never dropped by cleanup of
  stale records, and a missing or unreadable receipt directory deletes nothing.
- The lock is the Beads embedded write lock's protocol (a leased, token-owned file with a steal
  lock), shared through `plugins/lib/src/lease-lock.ts`. Delivery's coordination writes (holds,
  landing records, denials) take it too. The last look (claims, holds, sessions, denials) runs
  inside the removal section after the final tree, ref and host reads, immediately before the
  removal call.
- Every removal delivery makes (explicit, inline, retry) runs its last step inside
  `lockedWorktreeRemoval`: the same on-disk lock `subagent-worktree` takes, then, under it and after
  every proof, a final look at claims, background holds, running sessions and denials, then the
  removal. The prompt, if any, comes before and outside the lock. If the coordination store cannot
  be written, or a hold could not be recorded, the worktree is treated as unsafe and kept.
- Before the removal, delivery moves every idle session whose location is the worktree (or below it)
  to the repository's canonical checkout, so none is left pointing at a directory that is gone
  (`Location not found`). A running session, an incomplete session listing or a failed move
  refuses the removal.
- **A refusal sticks.** If the inline cleanup is refused at its prompt, the landing record
  keeps `denied` and nothing retries it. A later explicit `delivery_cleanup` call that is
  authorized clears it; one that is refused records a fresh denial and leaves the old one
  in place until then.
  Limitation: the plugin API cannot ask what a permission rule for `delivery_cleanup` resolves to without prompting (the context only offers `assert`, which prompts, and the `evaluate` hook, which cannot be called), so a deny rule is recorded as a denial only when the inline cleanup's own prompt hits it, not when a rule blocks an explicit call before the tool runs.
- If the forge accepted the merge but a later step refused, the result has
  `mergeIssued: true` and no receipt. Run the tool again with the same inputs: it
  sees the PR as MERGED, merges nothing, and writes the receipt.

Supported forges: `github.com` (including `ssh.github.com`), `gitlab.com`
(including `altssh.gitlab.com`) and `gitlab.aws.dev` (including
`ssh.gitlab.aws.dev`). Any other remote is refused as `repo.forge "unknown"`.

### delivery_cleanup

Inputs: `receipt`, `pr`, `branch`, `worktree`, `remote`. Any input you pass must
match the selected receipt. Without `receipt`, the tool uses the newest receipt
for the current repository. A receipt or worktree of another repository is always
refused, before any Git command runs in it: a foreign checkout's config can name
programs (filter drivers, `include.path`), so run `delivery_cleanup` from a session
in that repository. A listed worktree is also checked first: its `.git` must be a
regular file (never a symlink or FIFO, read with bounded no-follow reads) naming a
directory under this repository's `worktrees/` whose `commondir` is this repository. The values are read as Git reads them: `gitdir: `
is stripped exactly (a leading blank makes the path relative), `..` is resolved through
symlinks, and a blank-prefixed `commondir` is a relative name. Once verified, every Git
command in that worktree, and in the worktree the removal runs from, is pinned with
`GIT_DIR`, `GIT_WORK_TREE` and `GIT_COMMON_DIR`, so a marker swapped after the check
cannot redirect it. They also run with `core.fsmonitor=false`,
`core.hooksPath=/dev/null` and `--no-optional-locks`. `git worktree remove` itself
re-reads the target's marker; the re-verification just before it narrows that window
but cannot close it.

The tool refuses in these cases:

- it was called from inside the worktree it would remove;
- the worktree is not a live, listed, non-symlink linked worktree on the
  receipt's branch and head;
- the tree is dirty;
- the branch is ahead of its upstream;
- the PR, read from the receipt's own remote, is not MERGED at the recorded head,
  base and merge commit;
- on an active ledger, a receipt bead is not closed with `metadata.merge_sha`
  equal to the merge.

A branch with no upstream (for example, the forge deleted it on merge and a fetch
pruned it) counts as pushed. Its HEAD has already been checked against the merged
PR's `headRefOid`. The receipt records this as `proof.evidence.pushed: "pr-head"`.

Removal never forces and uses `git branch -d`, never `-D`. A worktree that
OpenCode tracks (one made by `opencode_worktree_create` or a subagent-worktree
lane) is removed through the host's `worktree.remove`, so OpenCode's registry
drops the entry; the host refuses a dirty tree and cleanup reports its reason
without falling back to git. Any other worktree is removed with
`git worktree remove`.

A registry entry goes stale only when a removal bypasses the host (a manual
`git worktree remove` or a deleted folder). `worktree.list` still returns such
entries, and the host's `remove` then fails because the directory is gone. The
plugin leaves them alone: OpenCode's `worktree.refresh` drops registry entries
whose directory no longer exists. Upstream, `remove` could drop the entry when
the directory is already gone.

## Permissions

`delivery_land` asks permission for action `delivery_land` with resource
`<owner>/<name>#<number>`. It asks after every read has passed and before the
first write. `delivery_cleanup` asks for action `delivery_cleanup` with the
worktree path, right before the removal. The plugin turns an allowed request for
either action into `ask`, so every call prompts. A deny rule still wins. Set the
`confirm` option to `false` to let your permission rules decide on their own.

## Receipts

Receipts are JSON files under `~/.omp/receipts/<repo-key>/<receiptId>.json`. That
is the same directory, file name, schema (`omp.receipt.landing` v1) and repository
key that the Oh My Pi delivery plugin uses, so either plugin can clean up the
other's landings. `delivery.receipt.landing` is accepted on read as well. To use a
different root, set `DELIVERY_RECEIPTS_DIR` or the `receiptsDirectory` option.
`PI_CODING_AGENT_DIR` is not read. A directory scan reads at most 1000 receipts
per repository.

## Agents

The plugin registers these subagents from `agents/*.md` through
`ctx.agent.transform`, so they need no files in your project:

| Agent | Job | Model tier | Fallback model |
| --- | --- | --- | --- |
| `implementer` (steps 150) | One bead or task in its own worktree; `DONE`/`BLOCKED`/`SPLIT` | `standard` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |
| `implementer-high` (steps 200) | Root cause, concurrency, contracts, precision, design judgment | `strong` | `amazon-bedrock/global.anthropic.claude-opus-5-5#high` |
| `researcher` (steps 80) | One cited answer; no product edits (fallback copy, see below) | `standard` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |
| `pr-reviewer` (steps 80) | Read-only diff review through `gh pr view` / `gh pr diff`; `VERDICT:` first line (fallback copy, see below) | `reviewer` | `amazon-bedrock/global.anthropic.claude-opus-5-5#high` |
| `operator` (steps 30) | One exact bounded command | `cheap` | `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `shepherd` (steps 60) | Lands one approved PR with `delivery_land` (approval and checks required), closes beads, cleans up | `standard` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |

- `researcher` belongs to the [`agent-researcher`](../agent-researcher/README.md)
  plugin. Delivery ships the same agent as a fallback, so `execution_agent_type=researcher`
  beads still have an agent without that plugin. Delivery skips its copy when
  `plugin.list` reports `srobroek.agent-researcher` or an earlier plugin already
  registered `researcher`; if delivery's copy loads first anyway, the owner replaces
  it, so either order leaves one agent. The logic is
  `@srobroek/opencode-lib/agent-fallback` and `FALLBACK_AGENTS` in `src/agents.ts`;
  `plugins/agent-researcher` tests keep the two files in sync.
- `pr-reviewer` belongs to the [`agent-reviewer`](../agent-reviewer/README.md) plugin
  the same way, and is `hidden: true`: the fan-out and git-workflow skills name it, so
  it stays out of the subagent catalog. Its prompt is composed from
  `agents.src/pr-reviewer.md` and the shared review core by `bun run build`; edit the
  source, not `agents/pr-reviewer.md`. Only this copy carries the fallback model.
- Every agent names its tier in the `x-opencode-model-role` request header. With
  the model-roles plugin installed (detected through `plugin.list`), the tier picks
  the model and the plugin sets no model of its own.
- Without model-roles, the agent uses its fallback model when it is available on
  this machine, and otherwise inherits the session's model. The fallback is marked
  in the `x-opencode-model-fallback` request header: if model-roles is installed
  but was not detected, its tier still replaces the fallback. A model you pin in
  config (`agents.<id>.model`) wins over the tier either way. Delivery keeps these
  fallbacks, unlike the other plugins' agents, so `operator` stays on a cheap model
  and the reviewer on a strong one for users without model-roles.
- The `models` option overrides a model per agent (`"provider/model#variant"`),
  with or without model-roles; `false` means no model.
- Your own markdown or config agent with the same id loads after the plugin and
  overrides it field by field, including the tier header.
- `agents/roles.json` holds the same mapping as the headers, as a model-roles
  `agents` fragment, for hosts that set tiers in config instead.

The agents were converted with
`bun scripts/convert-agent.ts --roles plugins/delivery/agents/roles.source.json`,
then edited by hand. The edits removed omp-only references, slimmed the
shepherd, and limited the reviewer's shell to `gh pr view` and `gh pr diff`.

Each agent's permissions are a tool allowlist: a deny on every action, then allows
for what the agent needs, so other tools are left out of its requests. The
implementers get read, grep, glob, edit, shell, the `lsp_*` tools and the coding skill
families (`lang-*`, `quality-*`, `toolchain-*`, `architecture-*`, `trunk-dev-*`,
`worktrunk-*`, `aws-guidance` and a few toolchain skills by id); their prompts carry the
coding core's `standards` part (research first, compare with the `lang-<language>-libraries`
standards, middleware, Powertools, OpenTelemetry); `operator` read, grep, glob, edit and
shell, no skills; `researcher` read-only tools, shell, the `repomix` skill, Code Mode for
`repomix_pack`, webfetch and websearch; `shepherd` read-only tools, shell, the
`delivery-*` skills and Code Mode for `delivery_land` / `delivery_cleanup`;
`pr-reviewer` the `quality-*` and `review-*` skills and its two `gh pr` commands. Only
`researcher` and `shepherd` call Code Mode tools, so only they get `execute`.

`implementer`, `implementer-high`, `operator`, `shepherd` and `pr-reviewer` are hidden
from the subagent catalog: the fan-out and git-workflow skills and the Beads routing
name them, so the parent spawns them by id. `researcher` stays listed. Reads
outside the workspace (`external_directory`) still ask, and your own rules still
apply after the agent's.

### Verdicts

Every delivery agent starts its reply with `VERDICT: <WORD>`. A verdict line that
slips below a preamble or into a code fence still counts, marked `late: true`. Every agent except
`pr-reviewer` ends it with one fenced `json` block. An `execute.after` hook on the
`subagent` tool parses that into the result's `metadata.delivery`
(`{ verdict, agent, summary?, late?, fields? }`).

If a delivery agent's reply has no verdict line or otherwise breaks this format, the verdict is `MALFORMED` and the
result gets a note naming the session to continue. Other agents' results are left
alone. Background subagent completions arrive as synthetic messages rather than
tool results, so the hook does not see them.

## MCP tools

`implementer`, `implementer-high` and the fallback `researcher` cannot call MCP tools unless a rule allows them. The `tools` option adds allow rules for MCP tool patterns after the agent's own rules. OpenCode names an MCP tool's permission action `<server>_<tool>`, so `context7_*` allows every tool of the `context7` server and `context7_query-docs` allows one. Characters outside letters, digits, `_` and `-` become `_`.

| Option | Default | Effect |
| --- | --- | --- |
| `tools` | `["context7_*", "aws-mcp_*"]` | An array of patterns replaces the defaults. `false` or `[]` adds no rules; the agent keeps its fixed allowlist. |

```jsonc
"options": { "tools": ["context7_*", "<server>_<tool>"] }
```

Patterns must name MCP server tools only (`<server>_<tool>`). The option refuses a pattern that could match a tool from a plugin in this repository or from OpenCode itself, such as `dep_*`, `delivery_*`, `quality_*`, `lsp_*` or `opencode_*`, and a pattern that starts with a wildcard, and logs a warning. Only add read-only tools: an allowed MCP tool runs without a prompt. The option refuses a pattern that matches a built-in action (`shell`, `edit`, `write`, `patch`, `external_directory`, `subagent`, `*` and the like) and logs a warning, so it cannot widen file or shell access. `pr-reviewer`, `operator` and `shepherd` get no MCP rules.

This agent denies `execute`, so OpenCode lists its allowed MCP tools directly, even for a server configured for Code Mode: with `execute` wholly denied, every tool left active becomes a direct tool (`packages/core/src/tool.ts:260-264`, OpenCode v2.2.6; an MCP tool's `codemode` flag is set at `packages/core/src/tool/mcp.ts:57`).

## Instructions and skill

- **Fan-out rules.** `instructions/delivery-fan-out.md` is a short summary
  (under 250 tokens) of the lead's fan-out rules. A `session.hook("context")` adds
  it to the system prompt of every primary session whose agent can call
  `subagent`, but not to subagent sessions or the delivery agents. The text is
  static, so provider prompt caching keeps working. To manage it yourself, set
  `fanOut: false` and copy the file into your `AGENTS.md`.
- **Skill `delivery-fan-out`.** The full rules the summary points at: splitting
  work into units, batched background dispatch, self-contained briefs, tier
  routing, one worktree per writer, and verifying once after integration. It sets
  `metadata: opencode/autoinvoke: false`, so it stays out of the skill listing and
  loads by id when the summary sends the lead to it.
- **Skill `delivery-git-workflow`.** Covers PR shipping, the review-loop owner,
  squash titles, external-repository hygiene, merge-method choice, approval
  artifacts, the land/close/cleanup order, and Beads linkage. Load it for PR or
  landing work.

## Options

```jsonc
{
  "plugins": [{
    "package": "github:srobroek/opencode-plugins::path:plugins/delivery",
    "options": {
      "confirm": true,              // prompt for every land and cleanup
      "autoCleanup": true,          // delivery_land runs cleanup itself
      "receiptsDirectory": null,    // default $DELIVERY_RECEIPTS_DIR, then ~/.omp/receipts
      "agents": true,               // register the delivery agents
      "models": { "operator": false },
      "fanOut": true,               // fan-out instructions for primary sessions
      "verdicts": true              // parse subagent verdicts into metadata
    }
  }]
}
```
