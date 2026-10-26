# build

An `external-repo-worker` subagent for work in a repository outside the caller's
project.

## Agent

`external-repo-worker` (mode `subagent`) is for a task that names a repo URL,
`org/name` or an external checkout path. It:

- clones into a unique `mktemp -d /tmp/agentic/external-repos/<repo>-XXXXXX`
  checkout (or uses the exact path the parent gives), and refuses to work inside
  the caller's repository tree;
- reads the target's own `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`
  and tooling before editing, and does not import the caller's conventions;
- makes the bounded change, runs the target's verification, and reports changed
  files and the check result;
- commits, pushes or opens a PR only when the parent delegated that, and keeps
  internal ids (beads, agents, gates) out of text written to an external repo.

It may read, search, edit, run shell commands and search the web; it may not spawn
subagents. Its checkouts live outside the project, so OpenCode asks for
`external_directory` access unless your config allows `/tmp/agentic/**`.

Converted from the omp-plugins `build` agent with `scripts/convert-agent.ts`. The
agent pins no model. On omp it used the `task` role at high thinking; map it with
the model-roles plugin (`{ "agents": { "external-repo-worker": "task" } }`) or set
`agent.external-repo-worker.model`.

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/build'
```

This plugin ships no skills, so it is not in the Claude Code or Codex marketplace.
