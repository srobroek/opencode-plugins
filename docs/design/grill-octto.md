# ngm.6 — Grilling, debate and to-questionnaire over octto (design)

Inputs read: `omp-plugins/debate/skills/{grilling,debate,to-questionnaire}/SKILL.md` (no
`references/` dirs exist; only LICENSE/NOTICE), octto v0.4.5 (`dbbc991`) `src/tools/*`,
`src/session/*`, `src/types.ts`, `src/agents/*`, `src/ui/bundle.ts`, bead 3go, V2 tools docs,
`@opencode/schema@2.1.4` `question.js` / `tool.d.ts`, `@opencode/plugin@2.1.4` `promise/*.d.ts`.

## 0. Skill question-round protocols today

### grilling
- **Model**: a *design tree*; each decision branches into dependent decisions.
- **Frontier**: every decision whose prerequisites are settled. A question that depends on
  another question open in the same round goes to a later round.
- **Round**: the whole frontier at once, numbered, each with a title, a body (can be
  multi-paragraph and list choices) and a *recommended answer*:
  ```
  **Q1** - **Title**: body
  > recommended answer
  ```
  Then wait for answers. Rationale is implicit in the body; there is no separate field.
- **Between rounds**: answers settle nodes, the frontier moves outward, recompute, next round.
- **Facts**: the agent looks them up (inline, or a non-blocking sub-agent). Only questions
  downstream of a pending fact wait; the rest of the frontier goes out now.
- **Stop**: end only when the frontier is empty (every branch visited, nothing silently
  assumed). Do not act on the plan until the user confirms a shared understanding.
- **Output**: the settled tree / shared understanding in chat. No file.

### debate
- Asking happens in only two places. **Phase 0**: a few context questions about unresolved
  constraints, and only when they would change the decision. **Phase 5**: "offer additional
  rounds" when a tradeoff is still unresolved. Deeper interviews hand off to grilling.
- **Output**: a structured report in chat (validation, pros/cons, tradeoffs, alternatives,
  overengineering 5Q, reversibility, devil's advocate, conditional verdict). Saved to
  `research/debate-<slug>.md` only when the user asks.

### to-questionnaire
- **Two single-exchange questions to the user**: (1) recipient role, expertise and
  relationship; (2) the decisions or facts the user needs back.
- **Output**: a Markdown file at a path the user names, or `~/tmp/to-questionnaire-{slug}.md`.
  The recipient answers it outside the session, so octto cannot be the channel. Octto only
  serves the two intake questions, plus an optional review of the draft before it is written.

So all three skills follow one pattern: a **batch of independent questions, each with a
recommended answer, asked together, with all answers back before the agent continues**. The
agent owns the tree and the stop condition. The UI only needs to present a batch and return
typed answers.

## 1. Skill ↔ plugin interface

### Recommendation: the skill drives the loop; the plugin is pure UI and transport
Don't use octto's `create_brainstorm` / `await_brainstorm_complete` / probe / bootstrapper:
- Octto's branches are fixed up front, and its probe decides "done" per branch from that
  branch's history alone. Grilling's frontier is recomputed across the whole tree after every
  round, and the stop rule is "frontier empty", which only the agent holding the tree can judge.
- The probe runs on another model (`ctx.generate.text`) with no repository access. That
  breaks grilling's rule "finding facts is your job": the probe would ask the user things a
  grep could answer.
- Octto pushes one question at a time. Grilling asks the whole frontier at once.
- Upstream `octto.ts` writes to `docs/plans/` and hard-codes a model. Both are already
  flagged in 3go.

Keep the brainstorm/probe flow out of the default build. At most it can be an opt-in
`octto-brainstorm` agent later. Ship no agents by default.

### Tools the skill calls
| Tool | When |
|---|---|
| `octto_ask` | Once per round. Takes the whole frontier and by default blocks until the user submits the round. |
| `octto_wait` | Only after `octto_ask` with `wait:"none"`/`"any"`, or after a `timeout` result, e.g. when grilling's background sub-agent returns and downstream questions should join the open round. |
| `octto_end` | When the frontier is empty and the user has confirmed. It closes the tab ("session complete"). |

There is no `session_id` argument. The plugin keys the browser session by
`context.sessionID`, so one OpenCode session gets one octto tab, earlier rounds stay visible
(collapsed), and the agent has no ids to juggle. The plugin cleans up on `session.deleted`,
on setup cleanup, and after an idle TTL.

### Mapping grilling questions to octto types
Every question uses one envelope:
`{ id, title, body (markdown), kind, recommended, rationale, depends_on? }`.
- `id` is the skill's stable design-tree node id (`"auth.storage"`). Answers come back keyed
  by it, so mapping them back to the tree is a lookup, not text matching.
- `rationale` is the "why I recommend this" line. Upstream folds it into the body; a separate
  field lets the UI show it under the recommendation and lets the fallback put it in an
  option description.
- `depends_on` is display-only (e.g. "unblocked by Q2 last round"). The plugin never
  enforces it.

| Grilling question shape | octto `kind` | `recommended` is |
|---|---|---|
| Pick one of 2–6 alternatives, tradeoffs obvious | `pick_one` (+`allow_other`) | option id |
| Pick one where pros/cons drive the choice | `show_options` (options carry `pros`/`cons`) | option id |
| Yes/no, "should we X at all" | `confirm` | `"yes"`/`"no"` *(new field)* |
| Several non-exclusive items (which of these are in scope) | `pick_many` | option ids |
| Priority order | `rank` | ordered ids *(new field)* |
| Number or threshold (budget, SLO, N retries) | `slider` | number (= `defaultValue`) |
| Open-ended (name, constraint, free description) | `ask_text` | text, prefilled *(new field)* |
| Final "do we share an understanding?" | `review` (= octto `show_plan`, sections = settled tree) | `"approve"` |

Every question also gets three affordances in the UI, all new in the port:
- **Accept recommended**: one click. The answer comes back with `accepted_recommendation: true`.
- **Note**: free text attached to any answer. Grilling answers often come with "yes, but…".
- **Defer / not sure**: status `deferred`. The agent keeps the node on the frontier, or turns
  it into a fact lookup or a to-questionnaire item.

Out of scope for grilling: `ask_image`, `ask_file`, `ask_code`, `show_diff`, `thumbs`,
`emoji_react`, `rate`. Keep them in the port, but the skill text does not mention them.

### Answers back into the tree
`octto_ask` returns a structured `output` (V2 `Tool.Result.output`, typed by an output
schema) and a short text `content` for the transcript:
```json
{ "status": "submitted", "round": 3,
  "answers": [
    { "id": "auth.storage", "status": "answered", "accepted_recommendation": false,
      "value": { "selected": "sqlite" }, "note": "only for v1" },
    { "id": "auth.ttl", "status": "deferred", "note": "ask ops" } ],
  "pending": [] }
```
The skill's per-round rules:
- `answered`: settle the node and record the note as a constraint.
- `deferred`: keep the node open and decide whether it is a fact (look it up) or a person
  (to-questionnaire).
- Recompute the frontier.

The text `content` repeats each answer as `Q1 auth.storage → sqlite (note: only for v1)`, so
the transcript and later compaction keep the decisions.

## 2. Availability detection and fallback

Three tiers, tried in order:

1. **octto**. Use it when `octto_ask` is in the tool list. The plugin registers its tools
   with `codemode: false` (pinned direct tools), so the skill sees them without `search`.
   If the user keeps them in Code Mode, the skill checks `search({namespace:"octto"})`.
2. **`question` tool**. Use it when octto is absent or returns `status:"unavailable"`.
3. **Plain markdown round** in upstream format. Use it when `question` is missing or denied,
   or the client has no interactive form (the docs say dismissing it cancels).

**The plugin decides whether octto is usable, not the skill.** The skill can't see the
environment reliably; the plugin can. On the first `octto_ask` of a session, the plugin
returns `{status:"unavailable", reason}` quickly, without blocking, when:
- config `octto.ui = "off"`, or env `OCTTO_DISABLE=1`;
- `SSH_CONNECTION` or `SSH_TTY` is set and `ui` is not `"url"` (headless remote);
- Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY`; or `CI` is set;
- the opener (`open`/`xdg-open`/`start`) fails to spawn or exits non-zero;
- **no WebSocket connects within `connect_timeout_s` (default 20s)** after opening. This is
  the decisive check: it catches a browser opening on the wrong display.

When it returns unavailable, the plugin closes the server and remembers the result for that
OpenCode session, so later rounds fail over instantly. Escape hatch: config `ui:"url"` never
opens a browser. The URL (with token) goes into the result and `ctx.progress`, and the call
waits for a connection, which suits SSH users who port-forward.

**Desktop app Review pane (open question to test)**: when the `browser` Code Mode namespace
exists, the skill could pass `open:"none"` and call `tools.browser.tabs.open({url})` itself,
which keeps the UI inside OpenCode. This only works when the desktop browser can reach the
server's loopback. The docs say "returned paths are server-local", which implies client and
server can be on different machines. So it stays opt-in until someone tests it.

**`question` tool shape** (`@opencode/schema` 2.1.4): `questions: Prompt[]`, where
`Prompt = { question: string, header: string (≤30 chars), options: {label (1–5 words),
description}[], multiple?: boolean }`. Each answer is `string[]` (the selected labels or the
free text). A free-form answer is always available.

**Fallback mapping** (the skill does this from the same envelope, so it writes one question
list either way):
| octto kind | `question` prompt |
|---|---|
| `pick_one` / `show_options` | `options` = alternatives; the recommended one is **first** with label suffix ` (Recommended)`; description = one line, plus pros/cons compressed (`+fast −lock-in`) for show_options |
| `pick_many` | `multiple: true`, recommended ones marked |
| `confirm` | options `Yes` / `No`, recommended first |
| `rank` | one option `Use recommended order` (description lists it); otherwise free-form "list ids in order" |
| `slider` | 3–4 preset values, recommended first; free-form for others |
| `ask_text` | one option `Use recommended` (description = the text); free-form otherwise |
| `review` | `Approve` / `Needs changes`; print the summary in chat first |

`header` = the question title truncated to 30 characters. `question` = the body's first
paragraph plus `Why: <rationale>`. If a body is long, print the full round in upstream
markdown format in chat first, then call `question` with the short prompts. Deferring maps
to the free-form answer ("defer"/"not sure").

## 3. Changes to the octto port spec (bead 3go)

Add to DESIGN:
1. **New batch tools `octto_ask` / `octto_wait` / `octto_end`** (schemas in §4).
   - They replace the agent-facing `start_session`, `push_question`, the per-type tools and
     `get_answer`/`get_next_answer`.
   - Keep the per-type tools out of the default tool set. Sixteen tools cost context in every
     session. Expose them behind config `octto.tools: "batch" | "all"`, default `"batch"`.
2. **Typed questions with `recommended` on every kind.** Add it to `confirm`, `rank` and
   `ask_text`, which upstream lacks. Add `rationale`, `note`, `defer` and
   `accepted_recommendation` to all answers. Validate with zod. Upstream's `looseObject`
   with `any()` fields gets replaced by a discriminated union on `kind`.
3. **Round UI mode.**
   - Render a whole batch as one card group: all questions visible, the recommended choice
     pre-selected, and one **Submit round** button. Partial submit is allowed: unanswered
     questions come back `pending` unless the user marked them deferred.
   - Upstream's one-active-question queue stays for the `wait:"any"` streaming path.
   - Render `body` and `rationale` as markdown via the vendored marked + DOMPurify. Upstream
     escapes `context` as plain text and parses a `[Branch]` prefix out of it; drop that.
4. **Blocking semantics honour `context.signal`.**
   - `wait:"all"` (default) blocks until the round is submitted. On abort, send `cancel` for
     the round's questions and return `status:"cancelled"`.
   - `wait:"any"` returns at the first answer.
   - `wait:"none"` returns at once with `status:"open"`.
   - `timeout_s` defaults to 1800 for asking (a grilling round can take a while; upstream's
     5 min is too short). A timeout returns the partial answers with `status:"timeout"`, and
     the agent resumes with `octto_wait`. Report progress with
     `ctx.progress({answered, total})` as answers arrive.
5. **Structured output.** Declare an output schema and return it in `Tool.Result.output`,
   with a compact text `content` for the transcript.
6. **Availability probe** as in §2 (`status:"unavailable"` plus `reason`; config
   `ui: "auto" | "url" | "off"`, `connect_timeout_s`). This supersedes the vague "Fallback to
   the built-in question tool" bullet. The plugin does not call `question` itself; the skill
   owns the fallback. Calling another tool's `execute` through `ctx.tool.list()` is possible
   but undocumented, so leave it out.
7. **Session keyed by `context.sessionID`.** One tab per OpenCode session, reused across
   rounds, with earlier rounds collapsed. Idle TTL defaults to 30 minutes after the last
   answer.
8. **No agents shipped by default.** Drop the bootstrapper, probe, octto agents, the
   fragment injector and the `.octto/` state store. Brainstorm mode can come back later as
   an opt-in (a separate bead).
9. **Tool options.** Set `codemode: false` so skills see the tools directly.
   `permission: "octto"`, so users can deny it (and the skill then falls back).

Acceptance additions:
- A grilling round of 5 mixed questions round-trips with ids preserved.
- Abort mid-round cancels the questions in the UI.
- Headless env returns `unavailable` in under 1s.
- No WS connection returns `unavailable` within `connect_timeout_s`.

## 4. Drafts

### 4a. Revised grilling SKILL.md — replaces steps 1–2 of the Workflow and adds a section
(The vendored-modification comment block gains: "3. Rounds are asked through `octto_ask`
when available, else the `question` tool, else the upstream markdown format.")

```markdown
1. Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are
   already settled: the questions you can ask now without guessing at answers you have
   not heard yet. Ask the whole frontier in one round, each question with your recommended
   answer and why, then wait for the answers before the next round. See **Asking questions**.

## Asking questions

Write each frontier question once, as: a stable `id` naming its node in the design tree
(`auth.storage`), a short `title`, a markdown `body`, a `kind`, your `recommended` answer,
and a one-line `rationale`. Pick the kind from the decision's shape:

- one of a few alternatives → `pick_one`; when pros and cons decide it → `show_options`
- yes or no → `confirm`; several in-scope items → `pick_many`; an order → `rank`
- a number or threshold → `slider`; anything open → `ask_text`

Then deliver the round through the first channel that works:

1. **octto**: if the `octto_ask` tool is available, call it once with the whole round.
   It blocks until the user submits. Answers come back keyed by `id`:
   - `answered`: settle that node and keep any `note` as a constraint.
   - `deferred`: the node stays open. Decide whether it is a fact to look up or a
     question for someone else (`skill://to-questionnaire`).
   - If it returns `unavailable`, use the next channel for the rest of the session.
   - On `timeout`, call `octto_wait`.
   - When a background lookup finishes mid-round, ask `octto_ask` with `wait:"none"` for
     the questions it unblocks, rather than holding them for the next round.
2. **question tool**: one prompt per question.
   - `header` is the title (30 characters at most).
   - `question` is the body's first paragraph plus `Why: {rationale}`.
   - The recommended option goes first, with ` (Recommended)` appended to its label.
   - Use Yes/No for `confirm`, `multiple: true` for `pick_many`, a few preset values for
     `slider`, and a single `Use recommended` option for `rank` and `ask_text`.
   - If bodies are long, print the round in the format below first.
3. **plain chat**: if neither tool is available, print the round and wait:

   **Q1** - **Question title**: question body
   > your recommended answer — rationale

When the frontier is empty, show the settled tree for approval. With octto, that is one
`review` question whose sections are the settled tree; otherwise it is a summary and a
Yes/No. Then call `octto_end` if you used octto.
```
Debate needs one line under Phase 0 and Phase 5: "Ask through the channels in
`skill://grilling` § Asking questions." To-questionnaire needs the same line for steps 1–2
(both `ask_text`, recommended empty), plus an optional step: "With octto, show the draft as
a `review` question before writing it."

### 4b. `octto_ask` input (JSON Schema, draft 2020-12)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "octto_ask.input",
  "type": "object",
  "additionalProperties": false,
  "required": ["questions"],
  "properties": {
    "title":   { "type": "string", "maxLength": 120, "description": "Shown at the top of the tab, e.g. the plan under grilling" },
    "round":   { "type": "integer", "minimum": 1, "description": "Round number, shown as a divider" },
    "wait":    { "enum": ["all", "any", "none"], "default": "all" },
    "timeout_s": { "type": "integer", "minimum": 0, "default": 1800, "description": "0 = no timeout; signal abort always ends the wait" },
    "open":    { "enum": ["system", "none"], "default": "system", "description": "none = return url and wait for a connection without opening a browser" },
    "questions": { "type": "array", "minItems": 1, "maxItems": 12, "items": { "$ref": "#/$defs/question" } }
  },
  "$defs": {
    "option": {
      "type": "object", "additionalProperties": false, "required": ["id", "label"],
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9][a-z0-9_.-]*$" },
        "label": { "type": "string", "maxLength": 80 },
        "description": { "type": "string" },
        "pros": { "type": "array", "items": { "type": "string" } },
        "cons": { "type": "array", "items": { "type": "string" } }
      }
    },
    "base": {
      "type": "object",
      "required": ["id", "title", "kind"],
      "properties": {
        "id": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9_.:-]*$", "description": "Caller's stable id (design-tree node); answers are keyed by it" },
        "title": { "type": "string", "maxLength": 120 },
        "body": { "type": "string", "description": "Markdown" },
        "rationale": { "type": "string", "description": "Why the recommendation; shown beside it" },
        "depends_on": { "type": "array", "items": { "type": "string" }, "description": "Display only" },
        "allow_defer": { "type": "boolean", "default": true }
      }
    },
    "question": {
      "oneOf": [
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "pick_one" },
            "options": { "type": "array", "minItems": 2, "items": { "$ref": "#/$defs/option" } },
            "recommended": { "type": "string" },
            "allow_other": { "type": "boolean", "default": true } }, "required": ["options"] }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "show_options" },
            "options": { "type": "array", "minItems": 2, "items": { "$ref": "#/$defs/option" } },
            "recommended": { "type": "string" } }, "required": ["options"] }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "pick_many" },
            "options": { "type": "array", "minItems": 2, "items": { "$ref": "#/$defs/option" } },
            "recommended": { "type": "array", "items": { "type": "string" } },
            "min": { "type": "integer", "minimum": 0 }, "max": { "type": "integer", "minimum": 1 },
            "allow_other": { "type": "boolean", "default": false } }, "required": ["options"] }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "confirm" },
            "recommended": { "enum": ["yes", "no"] },
            "yes_label": { "type": "string" }, "no_label": { "type": "string" } } }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "rank" },
            "options": { "type": "array", "minItems": 2, "items": { "$ref": "#/$defs/option" } },
            "recommended": { "type": "array", "items": { "type": "string" }, "description": "Ids, highest first" } }, "required": ["options"] }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "slider" },
            "min": { "type": "number" }, "max": { "type": "number" }, "step": { "type": "number" },
            "unit": { "type": "string" },
            "recommended": { "type": "number" },
            "labels": { "type": "object", "properties": { "min": { "type": "string" }, "mid": { "type": "string" }, "max": { "type": "string" } } } },
            "required": ["min", "max"] }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "ask_text" },
            "recommended": { "type": "string", "description": "Prefilled text" },
            "placeholder": { "type": "string" },
            "multiline": { "type": "boolean", "default": true } } }] },
        { "allOf": [{ "$ref": "#/$defs/base" }, { "properties": {
            "kind": { "const": "review" },
            "markdown": { "type": "string" },
            "sections": { "type": "array", "items": { "type": "object", "required": ["id", "title", "content"],
              "properties": { "id": { "type": "string" }, "title": { "type": "string" }, "content": { "type": "string" } } } } } }] }
      ]
    }
  }
}
```
Ship it as a zod discriminated union on `kind` and convert with `ctx.tool.transform`. That
gives the model a flat `anyOf` per kind. The `allOf`+`base` form above is for reading.
Semantic checks the tool runs and reports as errors:
- ids are unique;
- `recommended` refers to existing option ids;
- `min < max`.

### 4c. `octto_ask` / `octto_wait` output
```json
{
  "$id": "octto.answers",
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "enum": ["submitted", "open", "partial", "timeout", "cancelled", "unavailable"] },
    "reason": { "type": "string", "description": "unavailable/cancelled: ssh | no_display | ci | opener_failed | no_connection | disabled | aborted | user_closed" },
    "url":    { "type": "string", "description": "Present when open=none or ui=url" },
    "round":  { "type": "integer" },
    "answers": { "type": "array", "items": {
      "type": "object", "required": ["id", "status"],
      "properties": {
        "id": { "type": "string" },
        "status": { "enum": ["answered", "deferred"] },
        "accepted_recommendation": { "type": "boolean" },
        "value": { "description": "pick_one/show_options {selected, other?} | pick_many {selected[], other?} | confirm {choice} | rank {order[]} | slider {value} | ask_text {text} | review {decision: approve|revise, feedback?}" },
        "note": { "type": "string" }
      } } },
    "pending": { "type": "array", "items": { "type": "string" }, "description": "Question ids still unanswered" }
  }
}
```
`octto_wait`: `{ wait?: "all"|"any", ids?: string[], timeout_s? }`. Returns the same shape,
but only for answers it has not returned before. `octto_end`: `{ message?: string }` →
`{ ok: boolean }`.

## 5. Effort

| Piece | Estimate |
|---|---|
| Port deltas on top of 3go: batch tools, zod union, output schema, signal/timeout/progress, availability probe, session-per-OpenCode-session | 1.5–2 d |
| UI round mode: grouped cards, preselected recommendation, accept/defer/note, markdown body, submit round, partial submit | 1.5–2 d (bundle.ts is 1.6k lines of inline JS) |
| Tests: tool validation, mapping ids, abort cancels, headless → unavailable, connect timeout | 1 d |
| Skill edits: grilling "Asking questions", one-liners in debate and to-questionnaire, NOTICE modification lists | 0.5 d |
| Manual verification: macOS desktop + system browser, SSH → `question` fallback, `question` denied → markdown | 0.5 d |
| **Total over 3go** | **≈5–6 d** |

Dropping the agents/brainstorm/state code from the port makes 3go itself smaller, roughly
−1 d.

## Open questions
1. Can the desktop app's `browser.tabs.open` reach the plugin's loopback server? If yes,
   prefer the Review pane over the system browser.
2. Does a pinned (`codemode:false`) plugin tool show in every agent's list, or must agents
   opt in? This affects detection wording.
3. Does a tool call blocking for 30 minutes trip any V2 turn or step timeout? The `question`
   tool blocks indefinitely, which suggests it doesn't.
4. Should the skills live in this repo (OpenCode V2) as a copy, or stay in `omp-plugins`
   with the channel logic conditional on the host? This belongs to bead 4p3.4.
