# parley playground

A project for trying every part of the [parley](../../plugins/parley) plugin by hand. It loads the
plugin from this repository (server and TUI parts), adds a local demo plugin whose
`/parley-demo` command opens rounds **without a model**, and has sample files to upload and review.

Nothing here is published: `examples/` is outside the workspace, the build and the marketplaces.

| Path | What it is |
| --- | --- |
| `opencode.json` | Loads `../../plugins/parley` (its committed `dist/`) and allows the `parley` permission. |
| `.opencode/plugins/parley-demo/` | Local plugin: the `/parley-demo` command. |
| `AGENTS.md` | Steering for model-driven rounds in this folder. |
| `samples/` | `diagram.png`, `notes.txt`, `data.bin`, `plan.md` (review) and `change.diff` (show_diff). |
| `prompts.md` | Model-driven prompts per kind, with what to try and what to expect. |
| `start.sh`, `reset.sh` | Launch OpenCode with isolated state; wipe that state. |

## Setup

```sh
bun install && bun run build      # from the repo root, after changing plugins/parley/src
cd examples/parley-playground
./start.sh                        # TUI on a private server (--standalone)
```

`start.sh` points `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_CACHE_HOME` at
`.playground-state/` (gitignored; override with `PARLEY_PLAYGROUND_STATE`), so your own plugins,
`cli.json`, sessions and the shared background service stay untouched. `HOME` is kept, so AWS
credentials come from your own `~/.aws`; nothing secret is written to the folder. The repository's
own `AGENTS.md` still loads as an ancestor instruction file.

| Flag / env | Effect |
| --- | --- |
| `--model <ref>` / `PARLEY_MODEL` | Model, default `amazon-bedrock/global.anthropic.claude-haiku-5-5`. For Bedrock, `AWS_PROFILE` defaults to `omp-bedrock` and `AWS_REGION` to `us-east-1`. |
| `--fallback` / `PARLEY_FALLBACK=question` | parley option `fallback: "question"`: with no panel, ask through the built-in question tool. |
| `--no-takeover` / `PARLEY_QUESTION_TOOL=off` | parley option `questionTool: "off"`. The default, `"takeover"`, asks plain `question` calls as parley cards while the panel is attached. |
| `--mini` | `opencode mini` instead of the TUI: no parley panel. |
| `--run "<message>"` | One-shot `opencode run`: no parley panel. |

`./reset.sh` deletes `.playground-state/`. Plain `opencode` in this folder works too (with your own
config and the shared service); the options then come from the same env variables.

The TUI part loads automatically: the server loads `plugins/parley` from `opencode.json`, and the
TUI loads the TUI part of every plugin its server loads. No `cli.json` entry is needed. Check with
`/parley` in the command list (it is disabled until a round is open).

## The `/parley-demo` command

It finds `parley_ask`, `parley_wait` and `parley_end` in the server's tool list and calls their
executors directly, as a model's tool call would. Each result is posted to the session as a
synthetic message: the TUI shows its summary above the prompt (`◈ parley-demo · …`), and the full
text, including the structured JSON output, is what the model receives with your next message.
`/parley-demo` alone prints the usage.

Panel keys: `tab`/`j`/`k` next/previous question, `↑`/`↓` choice, `space`/`enter`/`1`–`9` choose,
`a` accept, `n` note, `d` defer, `e` edit text, `shift+↑`/`↓` or `J`/`K` move ranked item,
`←`/`→` slider or rating, `ctrl+s` submit, `D` dismiss, `esc` minimise.

### `/parley-demo all`

Every kind, in two rounds (a call holds at most 12 questions).

1. Round 1 *choices* opens full screen: pick_one, show_options, pick_many, confirm, rank, slider,
   rate, thumbs, emoji_react. Each card shows ★ recommended and a "Why" line.
2. Try: on pick_one press `e` and type an answer of your own (`allow_other`); on pick_many toggle
   until you have 2–3 (min/max are enforced on submit, try 4 to see the error); move a rank item
   with `J`/`K`; move the slider (step 15 s, labels "always fresh … very stale"); rate each library
   with `↑`/`↓` then `←`/`→`.
3. `ctrl+s`. Toast "Answers sent"; round 2 *text, review and files* opens: ask_text, ask_code,
   review (the sections of `samples/plan.md`), show_diff (`samples/change.diff`), ask_image,
   ask_file.
4. On review choose revise and press `e` to write feedback. On ask_image press `e`, type
   `samples/diagram.png`, `esc`. On ask_file: `samples/notes.txt, samples/data.bin`.
5. `ctrl+s`. Expected: two `◈` messages. Round 1 lists each id as `answered` or `accepted`
   (`other: …` for the free text). Round 2 inlines `notes.txt`, reports `data.bin … saved to
   <tmp>/parley/<id>/data.bin`, and lists `diagram.png` as an image part sent to the model.

### `/parley-demo <kind>`

One question of that kind, for example `/parley-demo slider` or `/parley-demo show_diff`. Kinds:
pick_one, show_options, pick_many, confirm, rank, slider, ask_text, ask_code, review, show_diff,
rate, thumbs, emoji_react, ask_image, ask_file. `/parley-demo files` asks the two upload kinds.

### `/parley-demo statuses`

Five questions whose titles say what to do:

1. press `a` → `accepted`, `accepted_recommendation: true`;
2. choose Tabs → `answered`, `accepted_recommendation: false`;
3. `n`, type a note, `esc` → `noted` with the note and no value;
4. `d`, then `n` and a reason → `deferred` with the note;
5. leave it → its id is in `Pending:`.

Before submitting, press `esc` (panel minimises), type `/parley` (it comes back with every edit
intact), then `ctrl+s`. Submitting with an untouched question is a **partial submit**: the round
closes and the untouched ids come back in `pending`.

### `/parley-demo wait`

1. `parley_ask` with `wait: "none"` returns at once: `◈ … open — 0 answers, 2 pending` and the hint
   to call `parley_wait`. The panel stays open.
2. The demo then calls `parley_wait` with `wait: "any"`. Answer and `ctrl+s`: it returns
   `submitted` with both answers. (The panel always submits the whole round; a client that sends
   `final: false` updates would get `partial` first, and the demo then calls `parley_wait` with
   `wait: "all"` for the rest.)

### `/parley-demo timeout`

`parley_ask` with `timeout_s: 15`. Wait 15 s without submitting: `◈ … timeout — 0 answers, 1
pending` ("The round stays open"). The panel stays up; the demo calls `parley_wait` (10 minutes).
Submit: `◈ … parley_wait after the timeout … submitted`. `/parley-demo resume` calls `parley_wait`
by hand at any time (`none` when there is no round).

### Dismiss, cancel and end

- **Dismiss**: in any round press `D`, confirm "Dismiss". Result `cancelled (user_closed)`.
- **Cancel** (the agent aborts): start a round, `esc`, run `/parley-demo cancel`. Toast "Round
  cancelled by the agent", the round is gone, and the demo reports the call was aborted (the host
  interrupts the call, as when you stop a model turn).
- **End**: start a round, `esc`, run `/parley-demo end`. The waiting call returns
  `cancelled (ended)`, `parley_end` returns "Parley closed." and a toast shows the message.
- Running a second demo while a round is open adds its questions to that round (toast "New
  questions joined the open round"); each call waits only for its own ids.

### No panel: fallback and unavailable

- `./start.sh --mini --fallback`, then `/parley-demo fallback` (pick_one, show_options, pick_many,
  confirm, ask_text) or `/parley-demo pick_one`: the questions appear as mini's built-in question
  form. Answer them; the result (`… via question tool`) reaches the model with your next message.
- `./start.sh --mini --fallback`, `/parley-demo rank`: `unavailable (no_tui; the question tool
  cannot ask roadmap.order …)`.
- `./start.sh --mini` (no `--fallback`): every demo returns `unavailable (no_tui)`.
- `opencode run` does not run slash commands, so use the model there:
  `./start.sh --run "Call parley_ask once with a confirm question 'Ship it?' and report the status"`
  reports `unavailable` / `no_tui`; with `--fallback` the call goes to the question tool (`channel:
  question`; without a terminal to answer it, `cancelled (dismissed)`).
- The panel counts as attached for 30 s after the TUI's last heartbeat, so after closing the TUI
  wait that long before testing these against the same server.

## Model-driven rounds

`AGENTS.md` tells the model to ask through parley, batch questions into one round, mix kinds,
always recommend, and follow up on notes and deferrals. Try for example:

- "Help me choose a database for a small side project; give me three options with pros and cons
  and let me pick." → show_options. Pick a different option and add a note; the next round should
  follow up on the note.
- "Grill me on `samples/plan.md` before I start." → several kinds in one round. For the debate
  plugin's grilling skill, add `"../../plugins/debate"` to `plugins` in `opencode.json` and ask
  "grill me on this plan"; its questions go through parley.
- "Give me a tour of everything parley can ask." → every kind across two rounds.

See [prompts.md](prompts.md) for prompts per kind, status and wait-mode prompts, and takeover
prompts.
