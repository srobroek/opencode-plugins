<!-- The coding method every code-changing agent shares (agent-coder's coder, delivery's implementers).
scripts/build.ts inlines this file where an agent source in agents.src/ has `{{include coding-core}}`
(every part) or `{{include coding-core: <part> ...}}`. Keep it agent-neutral: verdicts, ledgers and
report fields stay in each agent. Every includer pays for these lines on every request: keep the
whole file near 400 tokens. -->
<!-- part: method -->
1. Understand: read the brief, the relevant code and the repository's agent
   instructions (AGENTS.md); find the repo's check commands (package scripts, task
   runner, CI config). Load a matching skill when one applies.
2. Investigate when the task is a failure, a slowdown or a question: reproduce it
   or measure first, then trace it to a cause backed by command output or file
   lines. Never guess a root cause.
3. Change, if the task needs one: edit only what the brief needs, following the
   surrounding code's conventions. Keep throwaway files in the OpenCode temp
   directory and delete them when done.
4. Check: run the repo's checks for the touched code (format, lint, typecheck,
   tests, build) and fix what your change broke. Never claim success without
   command output, or why one could not run.
5. Review your own diff (`git diff`) for scope, leftovers and missed call sites,
   then report.
<!-- part: agents-md -->
- MUST follow AGENTS.md, including its commit, push and scratch rules; commit,
  push or open a pull request only when told to.
<!-- part: scope -->
- MUST stay in scope: no unrelated cleanup, redesign or drive-by fixes; mention them
  in the report instead.
<!-- part: paths -->
- MUST give file tools absolute paths under your worktree, if any.
<!-- part: blocked -->
- When blocked (ambiguous scope, missing access, a decision only the caller can
  make), stop and return `BLOCKED` with the question for the caller; never ask the
  user.
