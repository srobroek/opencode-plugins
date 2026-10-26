# opencode-plugins-ngm.4 — delivery on OpenCode V2.1.4

Sources: `omp-plugins/delivery` @ 1.4.3 (150 commits, 2026-08-24 → `5d3615ce22`), OpenCode tag `v2.1.4` (`68bc26b`), cloned to scratch `…/delivery/opencode`.
Usage counts come from `~/.omp/agent/sessions` (28,680 files, 2.6 GB, read-only). Extension tools show up there as `details.xdev.tool` with `mode: "execute"`, not as `toolCall.name`. Scripts: `…/delivery/count.py`, `…/delivery/xdev.py`.

## Part 1 — components

### Usage evidence

| Component | Calls / spawns | Dates | Notes |
|---|---|---|---|
| `delivery_land` | 382 executions: 243 ok, 139 refused | 2026-10-04 → 10-26 | 43 files; platevault 237, omp-plugins 75, slopvac 40, chezmoi 21, actually 8 |
| `delivery_cleanup` | 156: 96 ok, 60 refused | 2026-10-06 → 10-26 | top refusals: `branch.upstream` 16, `worktree.removed` 8, `beads.<id>.status` 4 |
| `delivery_hygiene_report` | 8 | 2026-10-02 → 10-22 | 5 files |
| Receipts `~/.omp/receipts` (`PI_CODING_AGENT_DIR` unset) | 340 files in 6 repo keys: 214 `landed`, 126 `cleaned` | 2026-09-28 → 10-26 | squash 204, merge 7, rebase 3; `ledgerActive` true 317 / false 23 |
| agent `implementer-high` | 545 spawns | 10-04 → 10-26 | |
| agent `implementer` | 436 | 10-06 → 10-26 | |
| agent `researcher` | 289 | 10-03 → 10-26 | |
| agent `pr-reviewer` | 73 | 10-10 → 10-23 | |
| agent `operator` | 16 | 10-06 → 10-19 | |
| agent `shepherd` | 4 (plus 2 `execution_agent` metadata mentions) | — | almost every land was called by the lead, not a shepherd |
| agent `worktree-reaper` | 0 | — | |

Main failure modes for `delivery_land`:

- **43 refusals (31% of land refusals)** read `git show -s --format=%P <merge>: observed no completed read`. The tool looks up the merge commit's parents locally without fetching it first. In 29 of those cases it had just issued `gh pr merge`, so **the PR merged and no receipt was written** (`delivery-land-tool.ts` `mergeProof`, called after the re-read). This is a bug: fetch the merge commit or base before `mergeProof`.
- **8 refusals**: `repo.forge "unknown"` for the GitLab host `ssh.gitlab.aws.dev`, which isn't on the forge allowlist.

### Per component

| Component | What it does / invariants | Overlap | Verdict |
|---|---|---|---|
| `delivery_land` (`extensions/delivery-land-tool.ts`, 1,095 LoC) | **Exact-head approval:** refuses to merge without `expectHeadSha == pr.headRefOid`; binds the merge with `gh pr merge --match-head-commit` / `glab --sha`. A given `worktree` HEAD must equal the PR head. Merges at most once, then rereads and checks for drift in number, head and base. Checks merge shape per method (squash 1 parent; merge 2 parents with head second; rebase by ordered `patch-id --stable`). Refuses `merge` when `allow_merge_commit=false`. Writes **one validated receipt**. Never writes beads; returns the `bd update/close` steps children-first. | `gh pr merge --match-head-commit` already gives the head binding. Nothing in gh, trunk-dev, worktrunk or OpenCode proves the merge shape or writes a receipt. | **Port, simplified.** Keep head binding, worktree-head check, merge-shape proof and the receipt. Fix the fetch bug. Add the GitLab host allowlist or config. Run git/gh through `ctx.shell` or `Bun.spawn` with the call's `signal`. Declare an `output` schema (receipt path, merge SHA, next steps) so Code Mode callers get typed results. |
| `delivery_cleanup` (1,070 LoC) | **Cleanup safety:** reads the receipt, recomputes ledger classification, refuses when run from inside the target, proves worktree identity (listed, not a symlink, right branch and head), clean tree, pushed, PR merged at the recorded base with `headRefOid` covering the tip. **Children-first close check:** `bd show` must show each receipt bead closed with `metadata.merge_sha` equal to the receipt. Then `git worktree remove` (no force), `git branch -d`, four absence checks, and a continuation receipt. | worktrunk `wt remove` covers removal plus branch delete and refuses dirty trees, but has no receipt, PR proof or bead verification. | **Port, simplified.** Keep the receipt-driven proof and bead verification. Consider delegating the removal itself to `wt remove` when worktrunk is present. Revisit the `branch.upstream` refusal (16 hits), which likely fires on branches already deleted on the remote. |
| `landing-receipt.ts` (library, 1,231 LoC) | Schema `omp.receipt.landing` v1; atomic no-clobber `0600` link publish; capped scans; noncanonical paths refused. | none | **Port.** Keep the files on disk under `$XDG_DATA_HOME/opencode/receipts` (or keep `~/.omp/receipts` for continuity) so existing receipts still work and other tools can read them. Use `ctx.storage` only as an index keyed by repo and PR. Rename the schema id to `delivery.receipt.landing` and accept the `omp.*` id on read. |
| `forge-adapter.ts` (1,131 LoC) | gh/glab argv without a shell, bounded timeouts, env neutralisation, remote URL to `owner/name`, auto-delete setting, `allow_merge_commit`, `ls-remote` branch absence that never invents absence. | gh/glab | **Port** as the shared library behind both tools. Drop the dead sync paths (already removed in #673). |
| `delivery_hygiene_report` (`hygiene-orientation.ts`, 833 LoC) | Read-only inventory: worktrees, dirty/ahead counts, receipts for still-present worktrees; reports UNKNOWN rather than guessing. | `wt list` shows dirty and ahead state per worktree; `git worktree list`. | **Drop** (8 calls). Keep one sentence in instructions: "a receipt for a branch whose worktree still exists means run `delivery_cleanup`". A `delivery_status` read could return that later if it's missed. |
| agent `implementer` / `implementer-high` | One bead per run; `bd update --claim` and heartbeat; own worktree; evidence via `bd comment`; `DONE/BLOCKED/SPLIT` plus a JTD `output`; never review, merge or close; tier routing via `execution_agent_type`. | beads plugin owns the claim, heartbeat and actor; adoption plan's `subagent-worktree` owns the worktree. | **Port** as V2 markdown agents (`mode: subagent`, `model: …#variant`, `permissions`). Remove the claim/heartbeat/worktree steps the beads and subagent-worktree plugins enforce. **They spawn scout, operator and researcher, which needs `experimental.subagent_depth ≥ 2`** (default 1, `core/src/tool/plugin/subagent.ts:129`). |
| agent `researcher` | Cited answer, `bd comment FINDING`, no product edits. | built-in `explore`-style subagents | **Port, simplified** to read-only permissions plus webfetch/websearch. |
| agent `operator` | One exact bounded command. | — | **Port, minimal** (16 uses), or fold into `implementer` with a cheap model. |
| agent `pr-reviewer` | Read-only; only `pr://` and `rule://`/`skill://` reads; scope mapping; `VERDICT:` first line. | built-in reviewer pattern in V2 docs | **Port.** There are no `pr://` resources on V2, so allow `shell` scoped to `gh pr view/diff` via permissions. Its approval artifact is the PR review or comment, not its reply. |
| agent `shepherd` | Exact-head approval artifact **on the PR** (APPROVED review for that `commit.oid`, or a `VERDICT: APPROVE` comment naming the SHA when reviewer and author share an account); green checks; documented merge method; land, close beads children-first (merge-queue bead first), clean up; one shepherd per target branch. | Most of these steps are the lead running the tools itself (382 lands vs 4 spawns). | **Simplify.** Move the approval-artifact and checks preconditions into `delivery_land` (an optional `requireApproval: true` that reads `reviews`/`comments` and `gh pr checks`), so the invariant holds whoever calls it. Keep `shepherd` as a thin optional subagent. Drop the `write agent://` handback; V2 returns the child result to the parent. |
| agent `worktree-reaper` | Report-only inventory. | `wt list` | **Drop** (0 spawns). |
| rule `delivery-fan-out` (always on) | FO-1..9: lead as bridge, split test, one batch ≤8, self-contained briefs, tier routing, worktree per writer, verify once after integration. | V2 subagent has background mode and parent inbox delivery. | **Port** as always-on instructions, trimmed. Swap `task` for `subagent` (`background: true` for parallel work) and drop the omp helper names that don't exist on V2. Keep it static so the prompt cache isn't broken. |
| rule `delivery-git-workflow` | GW-3 landing proof, GW-4 review-loop ownership, GW-7 squash title, GW-8 external-repo hygiene, GW-10 method selection, Beads linkage, merge-queue beads. | trunk-dev-workflow references it; trunk-dev-mr-advisory nags on `--squash`. | **Port as a skill** loaded on PR or landing work, not always-on. Drop the GW-3 manual proof prose that the tool already enforces. Keep GW-4, GW-7, GW-8 and GW-10. |
| rule `delivery-worktree-hygiene` | WH-1 cleanup owner, WH-2 one worktree per bead, WH-3/4 scratch outside trees, WH-7 `.bak` dirs never swept. | worktrunk rules | **Merge** WH-2/3/4 into the worktrunk port. Keep WH-1 and WH-7 as two lines in the delivery skill. |

## Part 2 — structured agent I/O on V2.1.4

### What V2 has

1. **Tools can declare an output schema.**
   - `Tool.Info.output?: ValueSchema` (Effect Schema, Standard Schema/zod, or JSON Schema). `Result.output` is typed from it (`@opencode/schema/dist/tool.d.ts`).
   - The runtime refuses a result that has `output` but no declared schema, refuses a missing declared output, and validates or encodes it (`core/src/tool/runtime.ts` `execute`, `encodeOutput`).
   - If `content` is omitted, the model sees `JSON.stringify(output)` (`normalizeContent`).
   - The schema is advertised as `outputSchema` (`definition`). The only consumer is **Code Mode**, where `await tools.x(...)` returns the structured `output` (`core/src/codemode/tool.ts:114`, `:248`).
   - The public docs (`/v2/docs/build/plugins`, Tools section) show only `input` and `content`. `output` exists in types and source but is undocumented.
2. **`output` is not persisted.** `ToolStateCompleted` stores `input`, `content` and `metadata` (JSON) only (`schema/src/session-message.ts:142-146`). Anything a later reader needs has to go in `metadata`.
3. **`execute.after` sees and can replace `result.output`, `result.content` and `result.metadata`**, and the replacement is what gets stored and sent to the model (`core/src/tool.ts` `executeTool`). The docs example mutates `metadata`.
4. **The subagent result is text plus a `sessionID`.**
   - The output schema is `{ sessionID, status: "completed"|"running", output: string }` (`subagent.ts:50`).
   - The model sees `<subagent sessionID=… state="completed">TEXT</subagent>`. Stored metadata is `{ sessionID, status }` (`subagent.ts:262-264`).
   - TEXT is the joined text parts of the child's last completed assistant message (`subagent-completion.ts` `text`, `subagent-job.ts`).
   - **Background** completions skip the tool path. They arrive as a `session.synthetic` message with the same XML and metadata `{source:"subagent", childID, agent, state}` (`subagent-completion.ts:42`). An `execute.after` hook on `subagent` never sees them.
5. **No agent-level output or input schema.** `Agent.Info` / config agent has `model, request, system, description, mode, hidden, color, steps, permissions` and nothing else (`schema/src/agent.ts:23`, `schema/src/config/agent.ts`).
   - Subagent input is free-text `prompt` plus `agent, description, model, sessionID, background`.
   - Commands have `template, description, agent, model, subagent`, with arguments as text (`schema/src/config/command.ts`).
6. **No JSON mode in generation.**
   - `ctx.generate.text({prompt, model})` returns `string` (`core/src/generate.ts:29`).
   - `ctx.session.generate({sessionID, prompt})` returns `{text}` (`core/src/session/generate.ts:66`; docs "Session … generate … Promise<{ text: string }>").
   - There's no response-format or schema option. `generate` uses the session's tools only for the prompt, not for a forced call.
7. **`ctx.storage`** gives durable plugin-scoped JSON `get/set/remove/scan({prefix})` (`plugin/dist/promise/storage.d.ts`; docs "Storage"). `ctx.session.get` exposes the child's `parentID`.

### Options for delivery verdicts

| Option | Enforcement | Cost | Covers background |
|---|---|---|---|
| A. Prose first line `VERDICT: X` plus a fenced `json` block; an `execute.after` hook on `subagent` parses `output.output` and adds `metadata.delivery = {verdict,…}` (invalid → `metadata.delivery = {verdict:"MALFORMED"}` plus an appended content note) | Soft; the parse happens in the parent | ~40 LoC, no extra child call | no (synthetic path) |
| B. `delivery_report` tool with a JSON-schema **input** per agent (a discriminated union on `agent`, verdict enum). Its `execute` stores `report/<childSessionID>` in `ctx.storage` and returns "recorded". An `execute.after` hook on `subagent` reads `storage[result.output.sessionID]` and appends it to `content` and `metadata`. A missing report gets content `delivery_report missing; continue sessionID X`. | **Real input validation at the tool boundary**: the model gets an error and retries on a bad enum. That is the closest thing to omp `yield`. | ~150 LoC plus one tool call per child | partial: add a `delivery_reports({sessionIDs})` read tool, or a `session.hook("prompt")`/synthetic path if one exists |
| C. Child runs, then the parent plugin calls `ctx.session.generate(child, "emit JSON …")` and parses it | none (text) | one extra model call | yes |

### Recommendation

The safety-critical invariants don't depend on a subagent's verdict:

- The shepherd and `delivery_land` read the approval artifact and head **from the PR**.
- Cleanup reads the **receipt** and `bd show`.

So structured verdicts only help with routing, not safety. Plan:

1. **Now: Option A** for every delivery agent. Each agent prompt keeps `VERDICT: …` as the first line and ends with one fenced `json` block for the fields the lead routes on: implementer `branch, head, blocker, split[]`; shepherd `merge_sha, receipt_path, closed_beads`. The hook only annotates `metadata` and never blocks.
2. **Put typed results on the tools, not the agents.** `delivery_land` and `delivery_cleanup` declare `output` schemas, so the lead gets typed receipts in Code Mode and plain JSON otherwise. Mirror them into `metadata` so they're persisted.
3. **Build Option B only if** A's parse failure rate goes above about 5% over two weeks of use, or a lead routing loop (`SPLIT` → bead creation) needs guaranteed fields. Measure by counting `metadata.delivery.verdict === "MALFORMED"` via `ctx.storage` counters.

## Port plan for `plugins/delivery` (bead opencode-plugins-80h.4)

1. **Library:**
   - Port `forge-adapter.ts` and `landing-receipt.ts` as pure modules with their tests (Bun test; swap the omp `ExtensionAPI` and `pi.zod` for zod plus `Plugin.define`).
   - Fix the fetch-before-`mergeProof` bug.
   - Add a configurable GitLab host allowlist.
   - Read existing `omp.receipt.landing` receipts.
2. **Tools** (`delivery_land`, `delivery_cleanup`): `permission: "delivery"` with an `ask` default for land; `codemode: true`; `output` schemas; `context.signal` passed through; results mirrored to `metadata`.
   - Optional `requireApproval` / `requireGreenChecks` on land to absorb the shepherd's PR-artifact checks.
3. **Agents** (`agents/*.md`, V2 frontmatter): `implementer`, `implementer-high`, `researcher`, `operator`, `pr-reviewer`, `shepherd` (thin).
   - Drop `worktree-reaper`.
   - Remove the JTD `output`. Keep the `VERDICT:` line and the JSON block.
   - Remove the `write agent://` handbacks.
   - Document `experimental.subagent_depth: 2`.
4. **Hook:** `execute.after` on `subagent` parses verdicts into `metadata.delivery` (Option A), as a pure exported `parseVerdict(text, agent)`.
5. **Instructions:** fan-out as always-on static instructions; git-workflow plus WH-1/WH-7 as the `delivery` skill; hygiene WH-2/3/4 move to the worktrunk port.
6. **Drop:** `delivery_hygiene_report`, `worktree-reaper`, the omp manifest, `PI_CODING_AGENT_DIR`.
7. **Repo bookkeeping:** `release-please-config.json` and `.release-please-manifest.json` entries; `srobroek.delivery` id.
