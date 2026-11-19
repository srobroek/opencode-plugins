# 0005. Questionnaires through a TUI panel, not a browser

## Context

Server plugins have no form API. Two routes were tested end to end:

- Call the built-in `question` tool from a plugin. It renders in every client,
  but only supports text, pick-one and pick-many, one question per page, no
  markdown, and cancel throws.
- An RPC broker: the server tool emits an event, and a TUI plugin renders the
  form and submits back. This supports any field type, but only in the TUI.

The TUI renders all six field types. The desktop and web clients render only
the `question`, `mcp-elicitation` and `websearch.provider` kinds.

## Decision

Build the octto question round as one package with a server entry (`octto_ask`,
`octto_wait`, `octto_end`, an RPC endpoint with attach and submit, and a round
event) and a TUI entry (a fullscreen round panel with recommended answers
preselected and one submit). Fallback order: TUI panel, then the `question`
tool, then a plain markdown round. A browser mode is optional and only for
desktop users who need ranking, diffs or uploads.

## Status

Decided, not built. The unshipped octto part is tracked as a backlog bead; no
in-repo file carries it.

## Consequences

- The TUI panel is the main UI, so headless and SSH sessions fall back to the
  `question` tool.
- Estimated effort was about 6 to 7 days.
