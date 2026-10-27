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
| `questionTool` | `"takeover"` | While a parley TUI is attached, calls to the built-in `question` tool are asked in parley and answered in that tool's format. `"off"` leaves the tool alone. |
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
| `parley_ask` | Opens a round (or adds questions to the session's open round) and, with `wait: "all"` (default), blocks until the user submits. `wait: "any"` / `"none"` return earlier. `timeout_s` defaults to 1800; 0 waits without limit. When it passes, the round closes in the UI and the call returns `timeout` (with several waiting calls, the one with the latest deadline closes it). Aborting the call cancels the round in the UI. |
| `parley_wait` | Keeps waiting on the session's round after a non-blocking ask. Returns only answers it has not returned before. Optional `ids`, `wait: "any"` and `timeout_s`. |
| `parley_end` | Closes the open round (if any) and shows an optional `message`. |

`parley_ask` with `format: "native"` words a submitted result like the built-in
`question` tool (`output` stays parley's JSON).

Each question: `{ id, title, kind, body?, rationale?, recommended?, options?, ... }`.
The `id` is yours (for example a design-tree node such as `auth.storage`);
answers come back keyed by it.

| Kind | `recommended` | Answer `value` |
| --- | --- | --- |
| `pick_one` (`allow_other`, default true) | option id | `{ selected }` or `{ other }` |
| `show_options` (options with `pros`/`cons`, side by side) | option id | `{ selected }` |
| `pick_many` (`min`, `max`, `allow_other`, default true) | option ids | `{ selected[], other? }` |
| `confirm` (`yes_label`, `no_label`) | `yes` / `no` | `{ choice }` |
| `rank` | option ids, highest first | `{ order[] }` |
| `slider` (`min`, `max`, `step`, `unit`, `labels`, `allow_other`, default false) | number | `{ value }` or `{ other }` |
| `ask_text` / `ask_code` (`language`) | text | `{ text }` |
| `review` (`markdown`, `sections`) / `show_diff` (`diff`, unified) | `approve` / `revise` | `{ decision, feedback? }` |
| `rate` (`min`/`max`, default 1..5) | `{ optionId: n }` | `{ ratings }` |
| `thumbs` | `up` / `down` | `{ choice }` |
| `emoji_react` (`emojis`) | emoji | `{ emoji }` |
| `ask_image` / `ask_file` (`multiple`) | | `{ files: [{ name, mime, size, path }] }` |

Use `slider` for numeric quantities only. A categorical choice ("how wide should
the change be") is a `pick_one`; a labelled slider shows its label for the value
under the knob, with the number in brackets unless every step is labelled.
`ask_code` is for code the user writes (the recommendation starts the editor);
to have a snippet approved, put it in a `confirm` body or use `show_diff`.

Answer statuses: `answered`, `accepted` (equals your recommendation),
`noted` (a note only, no value) and `deferred`. Any answer can carry a `note`.
Questions left alone come back in `pending`.

When any answer carries a note, the result text tells the model that notes are
input to act on: answer a question or concern in a note, or ask a follow-up
round, before going on.

Result statuses: `submitted`, `open`, `partial`, `timeout` (`reason: timeout`, the round closed), `cancelled`
(`reason`: `aborted`, `user_closed`, `dismissed`, `ended`, `plugin_unloaded`),
`unavailable` (`reason`: `no_tui`, `disabled`, ...) and `none`. `unavailable`
returns at once, so a skill can fall back to the `question` tool or a plain
markdown round in chat.

Uploaded images reach the model as image content. Text files are inlined in the
result. Other files are written to a temporary directory on the server and the
path is reported.

## Question tool takeover

With `questionTool: "takeover"` (default), parley wraps the built-in `question`
tool while a parley TUI is attached at the location. A call from a session with
an attached TUI becomes a parley round: each prompt becomes a `pick_one`
(`pick_many` for `multiple: true`) with free text allowed, or an `ask_text`
when it has no options. A label ending in "(Recommended)" becomes the
recommendation. The model gets the built-in tool's result: `output.answers` and
`metadata.answers` hold the chosen labels as the model wrote them, and the text
is the built-in sentence with parley's extras on their own lines:

```text
User has answered your questions: "Which database?"="Postgres", "Which extras?"="Unanswered". You can now continue with the user's answers in mind.
Note on "Which database?": we already run it
Deferred (the user will answer later): "Which extras?"
```

`metadata.parley` holds parley's own answers. Dismissing the round (`D`) ends
the turn exactly like dismissing the built-in form: parley hands the call back
to the built-in tool and the TUI cancels the form it opens, so the host records
"The user dismissed this question" and stops the step. If that TUI goes away
first, the built-in form stays up and can be answered there. A dismissed
built-in form (no TUI attached) passes through the wrapper unchanged.

With no TUI attached, the built-in tool runs unchanged. After the last TUI's
heartbeat expires (up to `heartbeat_window_s` plus 15 s), the wrapper is removed.
Calls parley cannot ask as given, such as a prompt with exactly one option, also
go to the built-in tool.

Why a wrapper and not an `execute.before` rename (the `bash` → `shell` trick
in agent-efficiency): in 2.1.4 a renamed call resolves only to direct tools,
and parley's tools are Code Mode tools. Renaming to one fails with "No tool
named …".

## TUI panel

A round opens the session's tab and sends an attention notification. A round
with one question shows as a compact card above the prompt. The card takes
focus and uses the keys below, with `enter` to submit (it also picks the row
under the cursor if nothing is chosen), `j` / `k` to move between choices, `f`
for full screen and `esc` to hide the card (`/parley` brings it back). In full
screen, `f` returns a one-question round to the card. Larger rounds show the
panel full screen; `f` switches between full screen and a side panel next to the
session. `esc` minimises it; `/parley` (or the command palette) brings it back
with your edits intact, and says so when the session has no open round. The
line under the round lists the keys of the focused card first. Once a round is
within ten minutes of its `timeout_s`, it shows the time left. The card keeps focus
while it is open: the host moving focus to the prompt on its own is undone, and
keys it does not use (`↓`, `tab`) stay with it instead of reaching the prompt's
bindings. Clicking the prompt hands focus over on purpose; the card then says
that keys go to the prompt and that `alt+p` or `/parley` returns.

| Key | Action |
| --- | --- |
| `tab` / `shift+tab`, `j` / `k` | Next / previous question |
| `↑` / `↓` | Move between stacked choices (options, yes/no, ranked or rated rows). On side-by-side cards (`show_options`, `emoji_react`) and cards without rows (slider, text), go to the previous / next question |
| `←` / `→` | Move between side-by-side choices; adjust a slider, or the rating of the row under the cursor |
| `space` / `enter`, `1`–`9` | Choose (toggle for pick_many) |
| `a` | Accept the recommendation |
| `n` | Add a note |
| `d` | Defer (again to undo) |
| `e` | Edit text: answer, "other" (pick_one, pick_many), a slider value (a number, a label, or free text with `allow_other`), review feedback, file paths |
| `shift+↑` / `shift+↓`, `J` / `K` | Move a ranked item |
| `ctrl+v` | On ask_image / ask_file: attach the clipboard's image (a screenshot) or copied files |
| `y` | Copy the focused card's plain text (body, review/code/diff, current answer and note); only outside text editing |
| `f` | Inline card ↔ full screen; full screen ↔ side panel for larger rounds |
| `alt+p` | Return focus to the open card or panel (also `/parley`, or "Return to parley round" in the command palette) |
| `ctrl+enter` / `ctrl+s` | Submit the round (partial rounds are fine) |
| `D` | Dismiss the round (the agent gets `cancelled`; a taken-over `question` call ends the turn) |
| `esc` | Minimise |

In a note or text field, `enter` saves it and returns to the card (on the inline
card it saves and submits), `shift+enter` adds a line, `esc` saves too, and
`ctrl+enter` / `ctrl+s` submit. In `ask_code` answers `enter` adds a line; the
code shows as a highlighted block. Text pastes with the terminal's own paste.

In a path field, suggestions from the session directory (fuzzy, `.gitignore`
respected, filtered to images or `accept` extensions) list under the field as
you type; `↑` / `↓` pick one and `tab` completes it. Paths starting with `~` or
`/` complete from that directory. Relative paths resolve against the session
directory. `ctrl+v` reads the system clipboard through OpenTUI's clipboard
service, with an AppleScript fallback on macOS.

Copy uses the renderer's OSC 52 support, so it also works over SSH when the
terminal permits clipboard writes. When unsupported, it falls back to `pbcopy`
on macOS or `wl-copy`, then `xclip -selection clipboard` on Linux (each bounded
to 1.5 s). Uploaded file bytes and key hints are not copied. `y` remains ordinary
text while editing; the host's `ctrl+c` behaviour is unchanged.

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
5. Ask the model to use the `question` tool with one question: the card shows
   above the prompt. Choose with `2`, add a note with `n` and press `enter`:
   the card submits. The result reads like the built-in tool's, plus a
   `Note on …` line. Ask again and press `D`: the turn ends as it does when you
   dismiss the built-in form.
6. Repeat with `opencode run` (no TUI): the call returns `unavailable`, or with
   `fallback: "question"` the questions appear as a form.
