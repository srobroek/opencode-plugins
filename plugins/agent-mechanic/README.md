# agent-mechanic

A lean `mechanic` subagent for mechanical edits: renames, bulk edits, formatting and
moving code, where the caller has already decided the change.

## Agent

`mechanic` (mode `subagent`):

- does exactly the described change, with no redesign or unrelated cleanup;
- finds every occurrence first, including imports, tests and docs;
- runs the check the caller names, or the repository's obvious test or typecheck;
- stops and reports anything that is not purely mechanical;
- replies with `VERDICT: DONE|PARTIAL|BLOCKED`, the changed paths and the check result,
  in at most 120 words.

It may `read`, `grep`, `glob`, `edit` (which covers `write` and `patch`) and run
`shell`. Skills, Code Mode (`execute`), subagents, questions and web access are denied,
so its requests carry no skill list or tool catalog. `.env` reads and
`external_directory` ask. It declares the `cheap` model tier through the
`x-opencode-model-role` request header, so with the model-roles plugin that tier picks
its model; without it the agent inherits the caller's model.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/agent-mechanic'
```

This plugin ships no skills, so it is not in the Claude Code or Codex marketplace.
