# parley

Ask the user a round of typed questions in a full-screen TUI panel and get
structured answers back. Each question carries a markdown body, your
recommended answer (preselected) and a one-line rationale. The user can accept,
change, annotate or defer every question, then submit the round in one go.
Inspired by [octto](https://github.com/vtemian/octto).

## Install

```sh
opencode plugin add 'github:srobroek/opencode-plugins::path:plugins/parley'
```

The package has a server entry (tools, RPC) and a TUI entry (`./tui`, the
panel). Both load from the same install.

Options:

| Option | Default | Effect |
| --- | --- | --- |
| `fallback` | `"none"` | `"question"`: with no TUI attached, ask through the built-in `question` tool (pick_one, show_options, pick_many, confirm, ask_text only). |
| `ui` | | `"off"` makes every call return `unavailable`. `PARLEY_DISABLE=1` does the same. |
| `heartbeat_window_s` | `30` | How recently a TUI must have checked in to count as attached. |

```json
{ "plugins": [{ "package": "github:srobroek/opencode-plugins::path:plugins/parley", "options": { "fallback": "question" } }] }
```

## Tools

All three go through Code Mode when it is on (`tools.parley_ask` and so on), so
they add nothing to the request's tool list, and share the permission key
`parley`, so one rule allows or denies them.

| Tool | Does |
| --- | --- |
| `parley_ask` | Opens a round (or adds questions to the session's open round) and, with `wait: "all"` (default), blocks until the user submits. `wait: "any"` / `"none"` return earlier. `timeout_s` defaults to 1800; 0 waits without limit. Aborting the call cancels the round in the UI. |
| `parley_wait` | Keeps waiting on the session's round after a timeout or a non-blocking ask. Returns only answers it has not returned before. Optional `ids` and `wait: "any"`. |
| `parley_end` | Closes the open round (if any) and shows an optional `message`. |

Each question: `{ id, title, kind, body?, rationale?, recommended?, options?, ... }`.
The `id` is yours (for example a design-tree node such as `auth.storage`);
answers come back keyed by it.

| Kind | `recommended` | Answer `value` |
| --- | --- | --- |
| `pick_one` (`allow_other`, default true) | option id | `{ selected }` or `{ other }` |
| `show_options` (options with `pros`/`cons`, side by side) | option id | `{ selected }` |
| `pick_many` (`min`, `max`, `allow_other`) | option ids | `{ selected[], other? }` |
| `confirm` (`yes_label`, `no_label`) | `yes` / `no` | `{ choice }` |
| `rank` | option ids, highest first | `{ order[] }` |
| `slider` (`min`, `max`, `step`, `unit`, `labels`) | number | `{ value }` |
| `ask_text` / `ask_code` (`language`) | text | `{ text }` |
| `review` (`markdown`, `sections`) / `show_diff` (`diff`, unified) | `approve` / `revise` | `{ decision, feedback? }` |
| `rate` (`min`/`max`, default 1..5) | `{ optionId: n }` | `{ ratings }` |
| `thumbs` | `up` / `down` | `{ choice }` |
| `emoji_react` (`emojis`) | emoji | `{ emoji }` |
| `ask_image` / `ask_file` (`multiple`) | | `{ files: [{ name, mime, size, path }] }` |

Answer statuses: `answered`, `accepted` (equals your recommendation),
`noted` (a note only, no value) and `deferred`. Any answer can carry a `note`.
Questions left alone come back in `pending`.

Result statuses: `submitted`, `open`, `partial`, `timeout`, `cancelled`
(`reason`: `aborted`, `user_closed`, `dismissed`, `ended`, `plugin_unloaded`),
`unavailable` (`reason`: `no_tui`, `disabled`, ...) and `none`. `unavailable`
returns at once, so a skill can fall back to the `question` tool or a plain
markdown round in chat.

Uploaded images reach the model as image content. Text files are inlined in the
result. Other files are written to a temporary directory on the server and the
path is reported.

## TUI panel

A round opens the session's tab, sends an attention notification and shows the
panel full screen. `esc` minimises it; `/parley` (or the command palette)
brings it back with your edits intact.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab`, `j` / `k` | Next / previous question |
| `↑` / `↓` | Move between choices in a card |
| `space` / `enter`, `1`–`9` | Choose (toggle for pick_many) |
| `a` | Accept the recommendation |
| `n` | Add a note (inline; `esc` when done) |
| `d` | Defer (again to undo) |
| `e` | Edit text: answer, "other", review feedback, file paths |
| `shift+↑` / `shift+↓`, `J` / `K` | Move a ranked item |
| `←` / `→` | Slider value, or the rating of the option under the cursor |
| `ctrl+enter` / `ctrl+s` | Submit the round (partial rounds are fine) |
| `D` | Dismiss the round (the agent gets `cancelled`) |
| `esc` | Minimise |

The TUI checks in with the server every 10 s (RPC `parley.attach`), and fetches
open rounds with `parley.pending` on start and after a reconnect. Desktop, web
and `opencode run` have no panel, so calls from there get `unavailable` or the
`question` fallback.

## RPC

`parley` methods: `attach { clientID, sessionIDs?, detach? }`,
`pending { sessionID? }`, `submit { roundID, answers, final? }`,
`cancel { roundID, reason? }`. Event `round { sessionID, roundID, action }`
with `action` `opened`, `updated`, `closed` or `ended`.

## Manual test

1. Add the plugin to a project's `opencode.json`, start `opencode` in it.
2. Ask the model: "Call parley_ask with three questions: a pick_one with a
   recommendation, a slider and a rank."
3. The panel opens. Change one answer, defer one with a note (`d`, `n`), press
   `esc`, run `/parley`, check the edits survived, press `ctrl+s`.
4. The tool result lists each id with its status and note.
5. Repeat with `opencode run` (no TUI): the call returns `unavailable`, or with
   `fallback: "question"` the questions appear as a form.
