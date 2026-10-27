# agent-seance

A `seance` subagent that answers a question about a past session by reading its
transcript and its subagent transcripts, so the caller's context never holds them.
Ported from the Oh My Pi built-in `seance` agent.

## Agent

`seance` (mode `subagent`) takes a session (a `ses_` id or a description) and a
question. It reads the session with `seance_read`, opens child transcripts when the
answer lies in a subagent's work, and replies with `VERDICT: ANSWERED|PARTIAL|NOT_FOUND`,
the answer, `ses_…[turn]` evidence and the gaps, in at most 250 words.

It may call `seance_read` (through Code Mode `execute`) and `read`, `grep` and `glob`;
everything else, including skills, edits, shell and subagents, is denied. `.env` reads
and `external_directory` ask. It declares the `cheap` model tier through the
`x-opencode-model-role` request header, so with the model-roles plugin that tier picks
its model; without it the agent inherits the caller's model.

## Tool

`seance_read` is read-only and touches only the plugin context's `session.list`, `get`
and `context`:

- Without `session` it lists this project's top-level sessions, newest first; `query`
  filters by title and `limit` caps the rows (default 15).
- With `session` it renders that session oldest turn first: user requests, assistant
  prose, each tool call with a one-line result, the last compaction summary, and the
  child (subagent) sessions with their agent. Pass a child id as `session` to read it.
  `from` pages by turn index, `match` keeps only turns containing a text, `max_chars`
  bounds the output (default 24000) and `reasoning` adds reasoning.
- A session outside the caller's project is read only after an `external_directory`
  check on its directory (`<dir>/*`). The `seance` agent asks; allow a directory with
  an `external_directory` rule under `agents.seance.permissions`.
- Every output escapes recorded `<tag` markup, redacts obvious secrets and ends with a
  token estimate.

`session.context` starts at the last compaction, so earlier turns are available only as
that compaction's summary. The tool name keeps the `seance_` prefix of the agent it
serves rather than the package name.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-seance'
```

The tool is OpenCode-only and the plugin ships no skills, so it is not in the Claude
Code or Codex marketplace.
