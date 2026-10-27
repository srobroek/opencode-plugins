---
name: grilling
description: Interviews the user relentlessly about a plan or decision in numbered frontier rounds. Triggers on grill me or stress-test my thinking.
---

<!--
Vendored from mattpocock/skills 1.2.3, path skills/productivity/grilling/SKILL.md, copied
2026-10-08. Licensed under the MIT License, Copyright (c) 2026 Matt Pocock. The full
licence text is in the LICENSE file beside this one.

THIS FILE HAS BEEN MODIFIED from the original. Changes:
  1. Fact lookups: upstream dispatched a sub-agent for every fact from the environment.
     Cheap lookups (a few reads, one grep) now run inline; a sub-agent is reserved for
     wide exploration.
  2. Rewrote the frontmatter description to this repository's authoring contract.
  3. Ported to opencode-plugins: references to other skills name the skill instead
     of an Oh My Pi skill URI.
  4. Rounds go through the parley tool when it is installed, else the host's question
     tool, else upstream's markdown format (new "Asking questions" section). Each
     question carries a node id, a kind and a rationale; deferred answers and notes
     feed the next round.
The design-tree framing, the frontier rounds, the round format, and the completion
condition are upstream's and are unchanged in substance.
-->

# Grilling

TRIGGER
+ "grill me", "stress-test my thinking", "poke holes in this plan"
+ a decision with several dependent sub-decisions that the user wants settled one by one
- a two-sided analysis of one decision → the `debate` skill
- a questionnaire for someone other than the user → the `to-questionnaire` skill

Interview the user relentlessly until you reach a shared understanding. Map this as a
**design tree**: every decision branches into the decisions that hang off it.

## Workflow

1. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are
   already settled: the questions you can ask now without guessing at answers you have
   not heard yet. Ask the whole frontier in one round, each question with your
   recommended answer and why, then wait for the answers before the next round. See
   **Asking questions** for the channel and the format.
2. Fold the answers into the tree. An answer settles its node; a note on it becomes a
   constraint on the nodes below. A deferred or unanswered question stays on the
   frontier: decide whether it is a fact to look up or a question for someone else
   (the `to-questionnaire` skill), and say which in the next round. Follow-ups are
   questions too: checking what a note means, or whether to hand a deferred node to
   someone, goes into the next round through the same channel, not into chat prose.
3. Each round reshapes the tree: settled decisions push the frontier outward and unblock
   the questions that depended on them. Recompute the frontier and ask the next round. A
   question whose answer depends on another question still open in this round belongs to
   a later round.
4. Finding facts is your job, never the user's. Look a fact up inline when a few reads or
   one grep answer it. Dispatch a sub-agent only for wide exploration, and do not block on
   it: only the questions downstream of that fact wait; ask the rest of the frontier now.
5. Decisions are the user's: put each to them and wait.

## Asking questions

Write each frontier question once, with:

- `id`: a stable name for its node in the design tree, such as `auth.storage`. Reuse it
  when a question comes back in a later round.
- `title`: a few words. `body`: markdown, as long as the decision needs.
- `kind`, picked from the decision's shape:
  - one of a few alternatives → `pick_one`; when pros and cons decide it → `show_options`
    (options carry `pros` and `cons`)
  - yes or no → `confirm`; several in-scope items → `pick_many`; an order → `rank`
  - a number or threshold → `slider` (`min`, `max`, `unit`); anything open → `ask_text`
- `options` with short ids and labels, for the kinds that choose.
- `recommended`: your answer (an option id, ids, `yes`/`no`, a number or text), and
  `rationale`: one line on why.

Deliver the round through the first channel that works, and stay on it for the session:

1. **parley**: when the `parley_ask` tool is available (in Code Mode, `tools.parley_ask`),
   call it once with the whole round (`round` set to the round number, `title` to the
   plan; at most 12 questions, so ask the most fundamental first). It blocks until the user submits and returns answers
   keyed by `id`:
   - `answered` or `accepted` (took your recommendation): settle the node; keep any `note`.
   - `noted`: the user commented without choosing. Read the note; usually the node
     returns next round reworded.
   - `deferred`, or listed in `pending`: the node stays open (step 2 of the workflow).
   - `timeout` or `partial`: call `parley_wait` to keep waiting.
   - `cancelled`: the user dismissed the round. Ask in chat whether to go on.
   - `unavailable`: use the next channel for the rest of the session.
   When a background lookup lands while a round is open, send the questions it unblocks
   with `parley_ask` and `wait: "none"`; they join the open round.
2. **question tool**: the host's built-in tool for asking the user (`question` in
   OpenCode, `AskUserQuestion` in Claude Code). One prompt per question: the title as
   header, the body's first paragraph plus `Why: {rationale}` as the question, and the
   recommended option first with ` (Recommended)` on its label. Use Yes/No for `confirm`,
   multiple selection for `pick_many`, a few preset values for `slider`, and a single
   `Use recommended` option for `rank` and `ask_text`. If a body is long, print the round
   in the chat format first. Split the round across calls if the tool caps the number of
   questions. A free-text "defer" or "not sure" counts as deferred.
3. **chat**: otherwise print the round and wait:

   ```
   **Q1** - **Question title** (`node.id`): question body, which may run to several
   paragraphs and list several choices
   > your recommended answer, because {rationale}

   **Q2** - **Question title** (`node.id`): question body
   > your recommended answer, because {rationale}
   ```

When the frontier is empty, put the settled tree to the user for approval. With parley,
that is one `review` question whose `sections` are the settled branches, recommended
`approve`; a `revise` with feedback reopens the nodes it names. On the other channels,
print the summary and ask a Yes/No. Then call `parley_end` if you used parley.

## Rules

MUST End the session only when the frontier is empty: every branch of the design tree
  visited, nothing left silently assumed.
NOT Act on the plan before the user confirms that you share an understanding.
NOT Ask the user for a fact a read, grep, or sub-agent can find.
