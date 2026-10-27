# Model-driven prompts

Prompts that should make the model open a parley round of a given kind. Start with `./start.sh`
(the model follows `AGENTS.md`). For each prompt: the kind(s) to expect, what to try in the panel,
and what the model should do with the answers. Models vary; if the kind differs, note it.

## Per kind

### pick_one
- "Which test runner should I use for a new TypeScript library? Let me choose."
- "Pick a licence for this project with me."
- Expect: pick_one with a ★ recommendation. Try: `e` to type your own answer (`other`).
- Model: uses the choice, or takes your "other" text at face value and asks nothing more about it.

### show_options
- "Help me choose a database for a small side project; give me 3 options with pros and cons and let me pick."
- "Compare REST, GraphQL and gRPC for an internal API and let me decide."
- Expect: show_options, cards side by side with +/− lines. Try: pick a non-recommended card, add a note.
- Model: explains the consequences of your pick and follows up on the note.

### pick_many
- "Which of these should the CI run on every PR: lint, types, unit, e2e, audit? Let me pick 2–4."
- "Pick the browsers we support."
- Expect: pick_many, maybe with min/max. Try: `space` to toggle, go past max, submit (error), `e` for an extra entry.
- Model: lists the chosen set and any "other" entry.

### confirm
- "Should I enable strict mode in tsconfig? Just yes or no."
- "Before you delete the old branch, confirm with me."
- Expect: confirm with custom yes/no labels. Try: choose the non-recommended side.
- Model: acts on the answer (or stops on "no").

### rank
- "Help me prioritise: performance, accessibility, docs, translations."
- "Order these five bugs by urgency with me."
- Expect: rank. Try: `J`/`K` to reorder.
- Model: repeats the order and plans in that order.

### slider
- "What cache TTL should we use? Let me set a number between 0 and 300 seconds."
- "How many retries before we give up?"
- Expect: slider with unit and min/max labels. Try: `←`/`→`.
- Model: uses the number exactly.

### ask_text
- "Ask me what the release should be called."
- "I need a one-line project description from you."
- Expect: ask_text with a suggested text. Try: `e`, replace it.
- Model: uses your text verbatim.

### ask_code
- "Ask me for the regex we should use to validate tags."
- "Let me write the SQL for the report query."
- Expect: ask_code with a language. Try: edit the snippet.
- Model: uses or reviews the snippet.

### review
- "Draft a plan for adding a cache from samples/plan.md and let me review it."
- "Write release notes and let me approve them section by section."
- Expect: review with sections. Try: revise plus feedback (`e`).
- Model: revises the draft per your feedback and asks again, or proceeds on approve.

### show_diff
- "Propose the change to add caching to loadReport as a diff and let me review it before you write it."
- "Show me samples/change.diff and ask whether to apply it."
- Expect: show_diff. Try: revise with feedback.
- Model: changes the diff and shows it again, or applies it on approve.

### rate
- "Rate these three logo ideas with me, 1 to 5."
- "Let me score each option you proposed."
- Expect: rate. Try: `↑`/`↓` per option, `←`/`→` rating.
- Model: picks the best-rated, mentions ties.

### thumbs
- "Quick thumbs up or down on the name report_cache."
- "Did that explanation help? Thumbs."
- Expect: thumbs. Model: keeps or changes course.

### emoji_react
- "How do you feel about this sprint? Let me react with an emoji."
- "React to this commit message with an emoji."
- Expect: emoji_react. Model: acknowledges the reaction briefly.

### ask_image
- "I want to show you a screenshot of the layout bug; ask me for it."
- "Ask me for the architecture diagram."
- Expect: ask_image. Try: `e`, `samples/diagram.png`.
- Model: describes what it sees in the image (a box on a gradient).

### ask_file
- "Ask me for the files you need to understand the plan."
- "Let me attach the meeting notes and the data dump."
- Expect: ask_file (multiple). Try: `samples/notes.txt, samples/data.bin`.
- Model: quotes the notes (inlined) and mentions the binary's saved path.

## Mixed rounds
- "Give me a tour of everything parley can ask." → every kind once, split over two rounds (12 per call).
- "Interview me to set up a new service: name, language, database, CI checks, deployment, budget." → ask_text, pick_one, show_options, pick_many, slider in one round.
- "Grill me on samples/plan.md." → review plus confirm/rank/slider questions on the risks.

## Statuses
- "Ask me 5 setup questions at once; I'll defer some and add notes."
  Try: accept one (`a`), change one, note-only one, defer one with a note, leave one alone.
  Model: lists each status; asks the deferred and pending ones again later; does not treat a note-only answer as a choice.

## Follow-up behaviour
- After any round, add a note such as "only if hosting is free" to an answer.
  Model: the next round asks about the note (for example, which free host). Verified with show_options: a confirm about free tiers followed.
- Defer a question with "ask the team". Model: asks it again in a later round or records it as open.

## Wait modes
- "Ask me three questions but don't block: use wait none, then wait for my answers with parley_wait."
  Expect: `open`, then a parley_wait call that returns on submit.
- "Ask me one question with a 15 second timeout." Do not answer. Expect: `timeout`, then parley_wait.
- "Ask, wait for the first answer only (wait any), then continue."

## Question-tool takeover
Needs `./start.sh --takeover` and the `questionTool` option (feat/parley-question-takeover).
- "Ask me a multiple-choice question about which shell I use, with the question tool."
- "Use the question tool to ask me which of these three colours I prefer."
- Expect: a parley card instead of the built-in form; the model gets the question tool's normal answer shape.

## Upcoming kinds (4p3.52)
To be filled when they land: form, buckets/matching, allocate, matrix, range, path picker,
date/time, tags, conditional, colour.
