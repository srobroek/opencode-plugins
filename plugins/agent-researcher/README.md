# agent-researcher

A `researcher` subagent that answers one scoped research question from the
codebase, its docs and the web, with cited observations kept apart from inferences.

## Agent

`researcher` (mode `subagent`) takes a question in its brief, or a bead id that
holds one. It:

- reads the narrowest relevant repository paths first, spawns `explore` for broad
  codebase lookups, and uses `websearch` and `webfetch` for external sources,
  preferring primary sources over summaries;
- cites every material claim with a path and line range or a URL, and marks each as
  an observation or an inference;
- with a bead id, claims the bead, records the finding with `bd comment` and leaves
  the bead open for the dispatcher; without one, returns the answer only;
- edits nothing, changes no bead links, and makes only read-only `gh`/`glab` calls.

Its reply starts with `VERDICT: DONE|BLOCKED` and ends with a fenced `json` block
(`verdict`, `answer`, and optional `bead_id`, `uncertainty`, `notes`), the shape the
delivery plugin's verdict hook parses.

Its permissions are an allowlist: read, grep, glob, skill, Code Mode (`execute`),
the `lsp_*` tools, shell (for `bd` and forge reads), `webfetch`, `websearch`, and
spawning only `explore`. Reads outside the workspace (`external_directory`) ask.

The agent pins no model. It declares the `standard` tier through the
`x-opencode-model-role` request header, so with the model-roles plugin that tier
picks its model; without it the agent inherits the caller's model. Set
`agent.researcher.model` to pin one.

## With delivery

The id stays `researcher`, so beads routing (`execution_agent_type=researcher`)
works with or without delivery. Delivery ships the same agent as a fallback and
skips it when this plugin (`srobroek.agent-researcher`) is installed. If delivery's
copy registers first, this plugin replaces it rather than layering over it, so either load order leaves one
agent.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-researcher'
```

This plugin ships no skills, so it is not in the Claude Code or Codex marketplace.
