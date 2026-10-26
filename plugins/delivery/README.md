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

| Agent | Role | Default model |
| --- | --- | --- |
| `implementer` | One bead or task in its own worktree; `DONE`/`BLOCKED`/`SPLIT` | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |
| `implementer-high` | Root cause, concurrency, contracts, precision, design judgment | `amazon-bedrock/global.anthropic.claude-opus-5-5#high` |
| `researcher` | One cited answer; no product edits | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |
| `pr-reviewer` | Read-only diff review through `gh pr view` / `gh pr diff`; `VERDICT:` first line | `amazon-bedrock/global.anthropic.claude-opus-5-5#high` |
| `operator` | One exact bounded command | `amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `shepherd` | Lands one approved PR with `delivery_land` (approval and checks required), closes beads, cleans up | `amazon-bedrock/global.anthropic.claude-sonnet-5-5#medium` |

- If the default model is not available on this machine, the agent inherits the
  session's model. The `models` option overrides a model per agent
  (`"provider/model#variant"`), and `false` means always inherit.
- Your own markdown or config agent with the same id loads after the plugin and
  overrides it field by field.
- To pick models by role with the model-roles plugin, add the mapping from
  `agents/roles.json` (`implementer: task`, `implementer-high: slow`,
  `pr-reviewer: reviewer`, `operator: tiny`, …) to its `agents` option.

The agents were converted with
`bun scripts/convert-agent.ts --roles plugins/delivery/agents/roles.source.json`,
then edited by hand. The edits removed omp-only references, slimmed the
shepherd, and limited the reviewer's shell to `gh pr view` and `gh pr diff`.

### Verdicts

Every delivery agent starts its reply with `VERDICT: <WORD>`. Every agent except
`pr-reviewer` ends it with one fenced `json` block. An `execute.after` hook on the
`subagent` tool parses that into the result's `metadata.delivery`
(`{ verdict, agent, summary?, fields? }`).

If a delivery agent's reply breaks this format, the verdict is `MALFORMED` and the
result gets a note naming the session to continue. Other agents' results are left
alone. Background subagent completions arrive as synthetic messages rather than
tool results, so the hook does not see them.

## Instructions and skill

- **Fan-out rules.** `instructions/delivery-fan-out.md` covers splitting work into
  units, batched background dispatch, self-contained briefs, tier routing, one
  worktree per writer, and verifying once after integration. A `session.hook("context")`
  adds it to the system prompt of every primary session, but not to subagent
  sessions or the delivery agents. The text is static, so provider prompt caching
  keeps working. To manage it yourself, set `fanOut: false` and copy the file into
  your `AGENTS.md`.
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
