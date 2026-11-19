<!-- The standards-review rules that code-reviewer, both pr-reviewer copies and security-reviewer share.
scripts/build.ts inlines this file where an agent source in agents.src/ has `{{include review-standards}}`
(every part) or `{{include review-standards: <part> ...}}`. Keep the lines language-neutral: language
rules live in the lang-<language> skills. The pr-reviewers cannot read files, so these lines must stand
alone. Every includer pays for them on every request: keep the file near 350 tokens. -->
<!-- part: rules -->
MUST Standards check: load `lang-<language>` for the code under review (and the skills it routes to) and `quality-code-policy`, and read the repo's engineering doc (`docs/engineering.md`, or the path AGENTS.md names) when you can read files, else use the text your caller supplies. Compare new or changed dependencies, hand-rolled code where a listed library or a shared repo helper exists, error and logging practice, and tests with them. A departure with no stated reason (PR body, comment or doc) is a finding; a stated reason that holds is not. Report the result in the Standards section.
MUST Treat a stack-changing diff (new or removed dependency, toolchain bump, new crate or module, new tool or departure) that leaves the engineering doc untouched, or a missing doc, as a finding.
<!-- part: checklist -->
MUST Also flag, each as a Standards finding: a helper copied where one shared home exists; a helper placed outside its shared crate or module's stated theme; a user-facing string written inline where the project has a message registry; a lint allowed without a stated reason; a `Result` or must-use value discarded (`.ok()`, `let _ =`) on a write, flush, filesystem or cache call; a mapped error that drops its source; a lossy numeric cast with no stated reason; an unwrap, expect or index on untrusted input; a dependency or practice that departs from the loaded skill with no stated reason.
