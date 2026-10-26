# session

Read-only handoff from an earlier top-level session into a fresh one. Built-ins
like `/sessions` and `--session` re-enter the old session with its full history;
this plugin gives the new session a short, bounded summary of where the old one
left off instead.

- Tool `session_resume`:
  - `mode: "list"` shows the project's root sessions across every worktree,
    newest first, or ranked by `query` (title, last goal, compaction objective,
    files, branch). A clear winner is marked `★ recommended`. An id or prefix in
    `query` resolves directly.
  - `mode: "read"` walks back from the end of one session to its last
    substantive request, or to the last compaction summary, within `max_chars`
    (default 14000). It reports the goal, compaction Objective / Next Move,
    beads commands, files touched, the branch worked on (with drift against the
    worktree now), and the newest turns first. Page older with `before`.
  - Every output escapes recorded `<tag` markup, redacts obvious secrets, drops
    reasoning unless `include_reasoning`, and ends with a token estimate.
  - Sessions outside the project are shown as metadata only until `confirm: true`.
- Skill `resume-session`: list, ask the user to confirm the session, read, then
  write a short handoff and wait.

The tool never writes: no compaction, fork, switch or view marking.

## Sources

| `source` | Reads | Notes |
| --- | --- | --- |
| `opencode` (default) | the plugin context: `session.list`, `get`, `context` | `context()` starts at the last compaction, so older turns are only available as its summary. |
| `api` | `opencode api get /api/session/...` | Opt-in with plugin option `{ "api": true }` (or `{ "api": { "args": ["--server", "<url>"] } }`). Pages the full history, so `past_compaction: true` works. Talks to the background service, which is not necessarily the server running this session. |
| `omp` | Oh My Pi JSONL under `~/.omp/agent/sessions` | Read-only; on when the store exists, `{ "omp": false }` disables it, `{ "omp": { "sessionsDir": "…" } }` moves it. Includes the latest omp todo board. |

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/session'
```
