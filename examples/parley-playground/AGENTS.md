# Parley playground

This folder is for trying the parley plugin. When you ask the user anything:

- Ask through parley: `parley_ask` (in Code Mode, `tools.parley_ask`), or the `question` tool when
  parley has taken it over. Never ask in plain chat unless parley returns `unavailable`.
- Put every question you can already ask into one round instead of asking one by one.
- Mix kinds and pick the richest one that fits: `show_options` with pros/cons for trade-offs,
  `rank` for priorities, `slider` only for numeric quantities (a TTL, a count, a budget), `pick_one`
  for categorical choices such as "how wide should the change be", `pick_many` for sets, `confirm` for yes/no,
  `review` / `show_diff` for drafts and changes, `ask_file` / `ask_image` when you need material,
  `rate` / `thumbs` / `emoji_react` for feedback, `pick_one`, `ask_text` and `ask_code` otherwise.
  `ask_code` is for code the user writes; to have a snippet approved, put it in a `confirm` body or
  use `show_diff`.
- When the user asks for an overview or a demo, use every kind at least once across the rounds:
  pick_one, show_options, pick_many, confirm, rank, slider, ask_text, ask_code, review, show_diff,
  rate, thumbs, emoji_react, ask_image, ask_file, form, buckets, match, allocate, matrix, range,
  path, date, time, datetime, tags, colour. One call holds at most 12 questions, so split
  them into rounds.
- Use `form` for fields, `buckets` for categorising, `match` for bijections, `allocate` for a fixed
  total, `matrix` for criteria scores, `range` for intervals, `path` for local paths, `date` / `time` /
  `datetime` for scheduling, `tags` for labels and `colour` for hex colours. Put kind-specific settings
  in `config`; recommendations must be canonical full value objects for these kinds.
- Conditional is not a kind. Use `show_if: { id: "gate", equals: { choice: "yes" } }` on a follow-up
  after a `confirm` with id `gate`. Keep both in the same round, gate first; recommend yes and give
  the follow-up its own recommendation and rationale. Include this conditional demo in an overview.
- Give every question a `recommended` answer and a one-line `rationale`.
- Read each answer's status. Notes are the user's input to act on: when a note asks a question or
  raises a concern ("why not Postgres?"), answer it, or ask a follow-up round through parley, before
  you go on. Follow up on `deferred` answers in the next round and re-ask ids left in `pending`.
- When the user gives you a time limit ("you have 30 seconds"), pass it as `timeout_s`. On
  `timeout` the round has closed: go on with your recommendations and say so.
- Call `parley_end` with a short summary when everything is settled.
