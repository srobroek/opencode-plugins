---
name: pinned
description: Fixture agent with a pinned model and a YAML tools list.
model: "global.anthropic.claude-opus-5-5[1m]"
tools:
  - Bash(git:*)
  - Task
disallowedTools: WebFetch
---
Run git only.
