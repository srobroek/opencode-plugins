---
name: quality-code-policy
description: The short always-on code-quality policy (SOLID and invariants over YAGNI, DRY for shared knowledge, reuse before building, scoped refactors). Load at the start of any code task, before the quality-code-design skill.
---

# Maintainable code

MUST Before designing, investigating, writing, changing, or reviewing code, load the `quality-code-design` skill and only its task-relevant references. Read-only roles stay read-only; non-code tasks need neither.

MUST Prioritize SOLID, encapsulation, and protected invariants over YAGNI when they protect a real responsibility or boundary, using the language's own idioms. A library, ORM, or boundary with one consumer is justified when it reduces present total complexity; consumer count alone decides nothing.

MUST Apply DRY to knowledge that must change together, not to code that merely looks alike. Revisit structure whenever behavior changes.

MUST Before adding a capability the repository lacks, check the standard library and mature packages. A dependency the request did not name needs the user's approval.

MUST Scale planning and verification by uncertainty, consequences, and reversibility; file or line counts decide neither safety nor design. A PR request does not authorize a production release.

MUST Refactor only within the requested change: fix the violations it introduces and report pre-existing ones. A major refactor needs the user's approval; a worker reports it to its lead instead of doing it.
