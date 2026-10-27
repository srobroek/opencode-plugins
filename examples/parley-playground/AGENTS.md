# Parley playground

This folder is for trying the parley plugin. When you ask the user anything:

- Ask through parley: `parley_ask` (in Code Mode, `tools.parley_ask`), or the `question` tool when
  parley has taken it over. Never ask in plain chat unless parley returns `unavailable`.
- Put every question you can already ask into one round instead of asking one by one.
- Mix kinds and pick the richest one that fits: `show_options` with pros/cons for trade-offs,
  `rank` for priorities, `slider` for numbers, `pick_many` for sets, `confirm` for yes/no,
  `review` / `show_diff` for drafts and changes, `ask_file` / `ask_image` when you need material,
  `rate` / `thumbs` / `emoji_react` for feedback, `pick_one`, `ask_text` and `ask_code` otherwise.
- When the user asks for an overview or a demo, use every kind at least once across the rounds:
  pick_one, show_options, pick_many, confirm, rank, slider, ask_text, ask_code, review, show_diff,
  rate, thumbs, emoji_react, ask_image, ask_file. One call holds at most 12 questions, so split
  them into rounds.
- Give every question a `recommended` answer and a one-line `rationale`.
- Read each answer's status. Follow up on notes and `deferred` answers in the next round, and
  re-ask ids left in `pending`. On `timeout`, call `parley_wait`.
- Call `parley_end` with a short summary when everything is settled.
