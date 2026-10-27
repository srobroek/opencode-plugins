# delivery

Lands pull requests with proof, cleans up after them, and ships the delivery
agents and instructions for fanning work out to subagents.

Ported from the omp-plugins `delivery` plugin (1.4.3 plus the land-fetch fix).
`delivery_hygiene_report` and the `worktree-reaper` agent were not ported: use
`wt list` for an inventory. A receipt for a branch whose worktree still exists
means `delivery_cleanup` has not run yet.

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
`setupAutoDelete`, `requireApproval`, `requireGreenChecks`.

- `expectHeadSha` is required whenever the call would merge. The merge is bound to
  that head (`gh pr merge --match-head-commit`, `glab mr merge --sha`), so a push
  between the read and the merge fails at the forge.
- `worktree` is recorded for cleanup, and its HEAD must be the PR head.
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
- After the merge the tool reads the PR again and fetches the landed commits by id
  (falling back to the base branch, with three attempts over about 7 seconds). It
  then checks the commit shape for the method:
  - squash: one parent;
  - merge: two parents, with the reviewed head second;
  - rebase: ordered `git patch-id --stable` equivalence with the reviewed commits.
- The tool never writes the Beads ledger. When the receipt's `beads.ledgerActive`
  is true, `next` lists the `bd update` / `bd close` commands to run, children
  first, before `delivery_cleanup`.
- If the forge accepted the merge but a later step refused, the result has
  `mergeIssued: true` and no receipt. Run the tool again with the same inputs: it
  sees the PR as MERGED, merges nothing, and writes the receipt.

Supported forges: `github.com` (including `ssh.github.com`), `gitlab.com`
(including `altssh.gitlab.com`) and `gitlab.aws.dev` (including
`ssh.gitlab.aws.dev`). Any other remote is refused as `repo.forge "unknown"`.

### delivery_cleanup

Inputs: `receipt`, `pr`, `branch`, `worktree`, `remote`. Any input you pass must
match the selected receipt. Without `receipt`, the tool uses the newest receipt
for the current repository.

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

Removal uses `git worktree remove` without `--force` and `git branch -d`, never
`-D`.

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
| `implementer` | One bead or task in its own worktree; `DONE`/`BLOCKED`/`SPLIT` | `standard` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |
| `implementer-high` | Root cause, concurrency, contracts, precision, design judgment | `strong` | `amazon-bedrock/global.anthropic.claude-opus-5-5#high` |
| `researcher` | One cited answer; no product edits (fallback copy, see below) | `standard` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |
| `pr-reviewer` | Read-only diff review through `gh pr view` / `gh pr diff`; `VERDICT:` first line (fallback copy, see below) | `reviewer` | `amazon-bedrock/global.anthropic.claude-opus-5-5#high` |
| `operator` | One exact bounded command | `cheap` | `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `shepherd` | Lands one approved PR with `delivery_land` (approval and checks required), closes beads, cleans up | `standard` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |

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
implementers and `operator` get read, grep, glob, edit, shell, skill, Code Mode
(`execute`) and the `lsp_*` tools; `researcher` the same without edit but with
webfetch and websearch; `shepherd` read-only tools, shell and `delivery_land` /
`delivery_cleanup`; `pr-reviewer` only skill and its two `gh pr` commands. Reads
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
      "receiptsDirectory": null,    // default $DELIVERY_RECEIPTS_DIR, then ~/.omp/receipts
      "agents": true,               // register the delivery agents
      "models": { "operator": false },
      "fanOut": true,               // fan-out instructions for primary sessions
      "verdicts": true              // parse subagent verdicts into metadata
    }
  }]
}
```
