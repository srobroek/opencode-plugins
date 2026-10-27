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
- Expect: show_options, cards side by side with +/− lines. Try: `←`/`→` between cards, pick a non-recommended one, `n`, type a note, `enter`.
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
- Expect: slider with unit and min/max labels. Try: `←`/`→`, then `e` and type a number.
- Model: uses the number exactly.
- Counter-check: "Ask me how wide the change should be." Expect pick_one (narrow / module / repo), not a slider.

### ask_text
- "Ask me what the release should be called."
- "I need a one-line project description from you."
- Expect: ask_text with a suggested text. Try: `e`, replace it.
- Model: uses your text verbatim.

### ask_code
- "Ask me for the regex we should use to validate tags."
- "Let me write the SQL for the report query."
- Expect: ask_code with a language; the code shows once, as a block. Try: `e`, add lines with `enter`.
- Model: uses or reviews the snippet.
- Counter-check: "Confirm this snippet before you apply it." Expect confirm with the snippet in the body, or show_diff, not ask_code.

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
- Expect: emoji_react. Try: `←`/`→` between emojis. Model: acknowledges the reaction briefly.

### ask_image
- "I want to show you a screenshot of the layout bug; ask me for it."
- "Ask me for the architecture diagram."
- Expect: ask_image. Try: `e`, type `dia` and `tab` to complete `samples/diagram.png`; or copy a screenshot and `ctrl+v`.
- Model: describes what it sees in the image (a box on a gradient).

### ask_file
- "Ask me for the files you need to understand the plan."
- "Let me attach the meeting notes and the data dump."
- Expect: ask_file (multiple). Try: `samples/notes.txt, samples/data.bin`.
- Model: quotes the notes (inlined) and mentions the binary's saved path.

## Mixed rounds
- "Give me a tour of everything parley can ask." → every kind plus conditional, split over five rounds (12 per call).
- "Interview me to set up a new service: name, language, database, CI checks, deployment, budget." → ask_text, pick_one, show_options, pick_many, slider in one round.
- "Grill me on samples/plan.md." → review plus confirm/rank/slider questions on the risks.

## Statuses
- "Ask me 5 setup questions at once; I'll defer some and add notes."
  Try: accept one (`a`), change one, note-only one, defer one with a note, leave one alone.
  Model: lists each status; asks the deferred and pending ones again later; does not treat a note-only answer as a choice.

## Follow-up behaviour
- "Ask me which database to use for a small notes app." Pick the recommendation and add the note
  "why not Postgres? I already run it on my NAS". Model: answers the question and asks a follow-up
  round (verified with haiku: a confirm "Use the Postgres on your NAS instead of SQLite?").
- After any round, add a note such as "only if hosting is free" to an answer.
  Model: the next round asks about the note (for example, which free host). Verified with show_options: a confirm about free tiers followed.
- Defer a question with "ask the team". Model: asks it again in a later round or records it as open.

## Wait modes
- "Ask me three questions but don't block: use wait none, then wait for my answers with parley_wait."
  Expect: `open`, then a parley_wait call that returns on submit.
- "Ask me one question with a 15 second timeout." Do not answer. Expect: the card counts down and
  closes, `timeout`, and the model goes on with its recommendations.
- "Ask me how wide the change should be and how many retries the loader gets. You have 30 seconds."
  Expect `timeout_s: 30` (verified with haiku), pick_one for the width, slider for retries.
- "Ask, wait for the first answer only (wait any), then continue."

## Question-tool takeover
On by default (`questionTool: "takeover"`) while the parley panel is attached; `./start.sh --no-takeover`
shows the built-in form for comparison.
- "Ask me a multiple-choice question about which shell I use, with the question tool."
- "Use the question tool to ask me which of these three colours I prefer."
- Expect: a parley card instead of the built-in form; the model gets the question tool's normal answer shape.
- On a single-question inline card: choose, `n`, type a note and press `enter`: the note saves and the
  card submits, with a `Note on …` line in the answer. `shift+enter` adds a line to the note.
- Ask again and press `D`: the turn ends, as when you dismiss the built-in form.

## Structured and input kinds

Each prompt below is an actual model instruction. Give the question a stable id, title, body,
recommendation and rationale; use the returned value and follow up on notes.

### form
- "Call parley_ask for service settings with kind form, config.fields [{id:'name',label:'Name',type:'text',required:true},{id:'replicas',label:'Replicas',type:'number',min:1,max:5},{id:'region',label:'Region',type:'choice',options:['eu','us']},{id:'logging',label:'Logging',type:'toggle'}], recommended {fields:{name:'reports',replicas:2,region:'eu',logging:true}} and a rationale. Then summarise my fields."
- "Call parley_ask with kind form to collect a release name: config.fields [{id:'name',label:'Name',type:'text',required:true}], recommended {fields:{name:'Cache Money'}}, and explain the recommendation. Use my edited name."
- Try: `↑`/`↓` field, `←`/`→` choice/toggle/number, `e` type field.

### buckets
- "Call parley_ask with kind buckets, config.items [{id:'cache',label:'Cache'},{id:'docs',label:'Docs'}], config.categories [{id:'now',label:'Now'},{id:'later',label:'Later'}], recommended {buckets:{now:['cache'],later:['docs']}} and a rationale. Plan from my categories."
- "Ask via parley_ask kind buckets to sort bugs: config.items [{id:'login',label:'Login'},{id:'theme',label:'Theme'}], config.categories [{id:'urgent',label:'Urgent'},{id:'backlog',label:'Backlog'}], recommended {buckets:{urgent:['login'],backlog:['theme']}} with rationale; every item must appear exactly once."
- Try: `↑`/`↓` item, `←`/`→` category.

### match
- "Call parley_ask kind match with config.items [{id:'cache',label:'Cache'},{id:'docs',label:'Docs'}], config.targets [{id:'sam',label:'Sam'},{id:'lee',label:'Lee'}], recommended {pairs:{cache:'sam',docs:'lee'}} and rationale. Assign work using my bijective pairs."
- "Ask via parley_ask kind match: config.items [{id:'api',label:'API'},{id:'web',label:'Web'}], config.targets [{id:'a',label:'Team A'},{id:'b',label:'Team B'}], recommended {pairs:{api:'a',web:'b'}} with rationale. Use each target once."
- Try: `↑`/`↓` left item, `←`/`→` partner (swaps).

### allocate
- "Call parley_ask kind allocate with options [{id:'cache',label:'Cache'},{id:'docs',label:'Docs'}], config.total 100, recommended {allocations:{cache:70,docs:30}} and rationale. Use my exact-total budget."
- "Ask via parley_ask kind allocate with options [{id:'tests',label:'Tests'},{id:'build',label:'Build'}], config.total 20, recommended {allocations:{tests:12,build:8}} with rationale. Schedule my allocation of 20 hours."
- Try: `↑`/`↓` option, `←`/`→` transfer from next option, `e` type.

### matrix
- "Call parley_ask kind matrix with options [{id:'local',label:'Local'},{id:'shared',label:'Shared'}], config.criteria [{id:'speed',label:'Speed'}], min 0 max 5 step 1, recommended {scores:{local:{speed:5},shared:{speed:3}}} and rationale. Compare my scores."
- "Ask via parley_ask kind matrix with options [{id:'sql',label:'SQL'},{id:'kv',label:'Key-value'}], config.criteria [{id:'cost',label:'Cost'},{id:'ease',label:'Ease'}], min 0 max 5 step 1, recommended {scores:{sql:{cost:4,ease:5},kv:{cost:3,ease:2}}} and rationale. Summarise my criteria scores."
- Try: `↑`/`↓` cell, `←`/`→` score, `e` type.

### range
- "Call parley_ask kind range with min 0 max 300 step 15 unit 's', recommended {min:30,max:90} and rationale. Use my TTL interval."
- "Ask via parley_ask kind range with min 1 max 10 step 1 unit 'replicas', recommended {min:2,max:4} and rationale. Use my scaling interval."
- Try: `↑`/`↓` endpoint, `←`/`→` adjust, `e` number.

### path
- "Call parley_ask kind path with config.mode 'files', multiple true, recommended {paths:['samples/notes.txt']} and rationale. Report the selected local paths without uploading them."
- "Ask via parley_ask with questions:[{id:'paths',title:'Select paths',kind:'path',config:{mode:'both'},multiple:true,recommended:{paths:['samples/notes.txt','samples/']},rationale:'Use both the notes and sample directory.'}]. multiple belongs to the question, not config or the call. Keep a trailing slash on directory paths and summarise my selection."
- Try: `e` type, `↑`/`↓` suggestion, `tab` complete.

### date
- "Call parley_ask kind date with config.min '2026-11-01', config.max '2026-12-31', recommended {value:'2026-11-16'} and rationale. Use my YYYY-MM-DD release date."
- "Ask via parley_ask kind date with config.min '2027-01-01', config.max '2027-01-31', recommended {value:'2027-01-11'} and rationale. Record my review date."
- Try: `←`/`→` day, `↑`/`↓` week, `shift+←`/`shift+→` month, `e` ISO.

### time
- "Call parley_ask kind time with config.min '09:00', config.max '17:00', recommended {value:'10:00'} and rationale. Record my HH:mm rollout time."
- "Ask via parley_ask kind time with config.min '12:00', config.max '18:00', recommended {value:'14:30'} and rationale. Use my review time."
- Try: `←`/`→` minute, `↑`/`↓` hour, `e` ISO.

### datetime
- "Call parley_ask kind datetime with config.min '2026-11-01T09:00', config.max '2026-12-31T17:00', recommended {value:'2026-11-16T10:00'} and rationale. Record my YYYY-MM-DDTHH:mm rollout slot."
- "Ask via parley_ask kind datetime with config.min '2027-01-01T09:00', config.max '2027-01-31T17:00', recommended {value:'2027-01-11T14:30'} and rationale. Use my review slot."
- Try: `←`/`→` day, `↑`/`↓` week, `shift+←`/`shift+→` month, `e` ISO.

### tags
- "Call parley_ask kind tags with config.suggestions ['cache','performance','docs'], min 1 max 3, recommended {tags:['cache','performance']} and rationale. Label the release with my tags."
- "Ask via parley_ask kind tags with config.suggestions ['bug','feature','maintenance'], min 1 max 2, recommended {tags:['maintenance']} and rationale. Use my edited tags."
- Try: `↑`/`↓` suggestion, `space` toggle, `e` comma-list.

### colour
- "Call parley_ask kind colour with config.swatches ['#336699','#cc6633'], recommended {hex:'#336699'} and rationale. Use my hex colour for the release badge."
- "Ask via parley_ask kind colour with config.swatches ['#669933','#993366'], recommended {hex:'#669933'} and rationale. Record my chosen accent colour."
- Try: `←`/`→` swatch, `e` hex.

### conditional (not a kind)
- "Call parley_ask with two questions: confirm id 'gate' recommended 'yes' with rationale, then ask_text id 'detail' show_if {id:'gate',equals:{choice:'yes'}} recommended 'Watch latency after enabling the flag.' with rationale. Ask whether to add rollout detail, then use the visible detail answer."
- "Ask via parley_ask in one round: confirm id 'gate' recommended 'yes' with rationale to enable review notes; ask_text id 'detail' show_if {id:'gate',equals:{choice:'yes'}} recommended 'Review before merge.' with rationale. Do not invent a conditional kind; respect my gate choice."
- Try: toggle gate no/yes; detail hides/reappears. `e` edits detail. Model: uses detail only when enabled.
