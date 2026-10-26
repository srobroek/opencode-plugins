# Questionnaires on OpenCode: native forms vs TUI vs browser (opencode-plugins-ngm.9)

Server plugins cannot create forms directly (no form API on the plugin context).
Two routes work, both tested end to end with a model:

- Call the built-in `question` tool's `execute` from a plugin (via `ctx.tool.list()`
  or `editor.get("question")`). Renders in TUI, desktop, web and ACP. Text,
  pick-one and pick-many only; one question per page; no markdown. Cancel throws.
- RPC broker: the server tool emits an RPC event, a TUI plugin creates the form
  or shows its own UI and submits back. Any type, TUI only.

Clients: full TUI renders all six form field types (one per page, no markdown);
mini refuses `when`/`pattern`; desktop/web only render forms with kind
`question`, `mcp-elicitation` or `websearch.provider`; ACP and `opencode run`
mostly cancel.

TUI plugins get `ui.dialog.show`, fullscreen `ui.panel.open` (session.panel slot),
`ui.router.register`, `keymap.layer`, `<markdown>`, `<diff>` (split/unified,
highlighted), `<code>`, `<textarea>`. Every octto question type is buildable
except native image/file pickers (path input plus base64 over RPC instead).
Plugin UI loads only in the TUI.

Decision: build octto as one package with a server entry (`octto_ask`,
`octto_wait`, `octto_end`; RPC `octto` with attach heartbeat, pending, submit,
cancel; event `round`) and a TUI entry (fullscreen round panel: cards with
markdown, recommended preselected, accept/note/defer, one submit). Start with the
seven grilling kinds plus review. Fallback order: TUI panel, then `question`
tool, then a plain markdown round. Browser mode optional, only if desktop users
need rank/diff/uploads. Effort about 6-7 days, replacing the browser port.
Evidence: $TMPDIR/opencode/forms.
