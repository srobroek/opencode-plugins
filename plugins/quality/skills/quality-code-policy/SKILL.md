---
name: quality-code-policy
description: Code-quality policy (SOLID, invariants, DRY, reuse, scoped refactors); load before code changes when no agent prompt already carries it.
---

# Maintainable code

MUST Load the `quality-code-design` skill (and only its task-relevant references) only for: adding new behavior or a capability, a refactor, a hard bug (root cause not obvious after reading the failure), or a code review. Small edits, mechanical changes, test-only fixes, config, docs and command runs do not need it. Read-only roles stay read-only.

MUST Prioritize SOLID, encapsulation, and protected invariants over YAGNI when they protect a real responsibility or boundary, using the language's own idioms. A library, ORM, or boundary with one consumer is justified when it reduces present total complexity; consumer count alone decides nothing.

MUST Apply DRY to knowledge that must change together, not to code that merely looks alike. Revisit structure whenever behavior changes.

MUST Before adding a capability the repository lacks, check the standard library and mature packages. A dependency the request did not name needs the user's approval.

MUST Scale planning and verification by uncertainty, consequences, and reversibility; file or line counts decide neither safety nor design. A PR request does not authorize a production release.

MUST After an edit that spans files or changes a signature, run the project's type checker once through the shell before handing back, preferring its own script (`npm run typecheck`); `lang-<language>-quality` names the command.

MUST Refactor only within the requested change: fix the violations it introduces and report pre-existing ones. A major refactor needs the user's approval; a worker reports it to its lead instead of doing it.
