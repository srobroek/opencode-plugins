---
name: quality-code-design
description: Use for coding, refactoring, reviewing, debugging or diagnosing, TDD, test-first or red-green-refactor work.
---

# Code design and review

TRIGGER
+ Design, investigate, write, modify, refactor, or review code in any agent role or language.
+ Add behavior to an existing function, module, type, script, or service.
+ Debug or diagnose a hard bug, a flaky failure, or a performance regression.
+ Work test-first: TDD or red-green-refactor.
+ Review a branch, PR, or work-in-progress change since a fixed point.
- Prose-only work or mechanical execution of an unchanged command needs no design analysis.
- Tuning code-agent instructions, model routing, or tools against task cases → the `tune-model-prompt` skill when installed (an owner-local skill this repository does not ship).
- Deciding what to test, at which level, with which doubles or test data → the `quality-testing` skill.
- Checking whether a state model or logic holds up before building it → the `prototype-logic` skill.
- Measuring, profiling or benchmarking slow or memory-heavy code → the `quality-profiling` skill.

## Workflow

1. Identify the accepted behavior, affected responsibility, callers, contracts, invariants, and material failure risks. Missing context is an uncertainty, not proof of a defect.
2. Choose IMPLEMENT, INVESTIGATE, or REVIEW. IMPLEMENT: when the change adds a capability or dependency the repository lacks, load the dependency guide before writing code. INVESTIGATE: map responsibilities, contracts, reuse candidates, and simplifications within the brief; do not edit. REVIEW: load the review guide and stay read-only.
3. Load only the references the table names for the situation. Select language guidance from the files and symbols in scope or the stated implementation language; an unrelated language elsewhere in the repository does not trigger it.
4. In IMPLEMENT, fix the violations the change introduces and simplify the code it touches. Choose focused checks against acceptance and failure cases.
5. In REVIEW, evaluate every row of the review guide's checklist, marking a row inapplicable when the code has no relevant construct. Report in the format your role or brief defines.
6. Reassess decisions when behavior changes. Record a non-obvious exception near the decision or in an existing decision record: reason, alternatives, residual risk, and revisit trigger. Omit ceremonial compliance reports on clean changes.

## Reference selection

References live in `references/` beside this file; the links below are relative to it. Examples are focused excerpts, not complete applications. Undefined collaborators stand for application-specific code.

| Situation → reference | Coverage |
|---|---|
| Responsibilities, extension, contracts, or dependencies → [solid.md](references/solid.md) | SRP, OCP, LSP, ISP, DIP; underdesign and overengineering |
| State, objects, modules, abstraction, or composition → [encapsulation.md](references/encapsulation.md) | Encapsulation, information hiding, invariants, abstraction, inheritance, polymorphism, composition |
| Module depth, seams, adapters, testability, or deepening shallow modules → [deep-modules.md](references/deep-modules.md) | Depth vocabulary, the seam rule, dependency categories, replace-don't-layer tests, optional design-it-twice |
| Scope, duplication, or simplifying a solution → [simplicity.md](references/simplicity.md) | YAGNI, KISS, DRY, reversible design, refactoring scope, scripts, tests |
| Adding a capability or dependency; library, ORM, or persistence choice → [dependencies.md](references/dependencies.md) | Repository and earlier-code reuse, mature packages, present value and boundaries |
| Database state, transitions, migrations, dynamic SQL, or persistence tests → [persistence.md](references/persistence.md) | DB as the record, compare-and-set updates, append-only migrations, bound queries, real-database tests |
| Generated bindings, IPC command names, wire casing, or client/server contract tests → [contracts.md](references/contracts.md) | Committed codegen with drift check, name conformance, one casing, tests against the real surface |
| Plan/approve/apply flows, bulk or destructive file operations, path checks, audit trails → [safe-mutation.md](references/safe-mutation.md) | Apply-time approval tokens, freshness checks, traversal, append-only audit, reversible deletes |
| Contracts, internal knowledge, naming, errors, or effects → [supporting-principles.md](references/supporting-principles.md) | Design by Contract, least knowledge, predictability, command-query separation; researched sources and limits |
| Go code → [go.md](references/go.md) | Consumer interfaces, structs, composition, package boundaries, errors |
| Rust code → [rust.md](references/rust.md) | Ownership, enums, traits, privacy, dispatch, error enums, serde newtypes |
| TypeScript or JavaScript code → [typescript.md](references/typescript.md) | Functions before classes, discriminated unions, branded types, errors with `cause` |
| Python code → [python.md](references/python.md) | Dataclasses and protocols, exception hierarchies, NewType/Annotated, pydantic at boundaries |
| Java/C#, functional, or procedural code → [other-paradigms.md](references/other-paradigms.md) | Java/C#, functional and C-style designs |
| Code, PR, or work-in-progress review → [review.md](references/review.md) | Fixed point and spec source, checklist, severity, evidence, exceptions, review examples |
| Uncertain scope, work sequencing, durable tradeoff, domain terms, or recurring delivery problem → [lifecycle.md](references/lifecycle.md) | Risk, small batches, decision records, term discipline, feedback and outcome metrics |
| Selecting tests or making verification/performance claims → [verification.md](references/verification.md) | Behavioral evidence, test fidelity, failure cases, proportional checks |
| Test-first, TDD, or red-green-refactor → [test-first.md](references/test-first.md) | Vertical slices, red before green, mockable boundaries |
| Hard bug, flaky failure, or performance regression → [debugging.md](references/debugging.md) | Feedback loops, minimisation, falsifiable hypotheses, tagged instrumentation, regression seam, cleanup |
| Untrusted input, identity, permissions, sensitive data, dependencies, or privileged automation → [security.md](references/security.md) | Trust boundaries, abuse cases, dependency and artifact assurance |
| Persistent state, API/event compatibility, network effects, or release operations → [release.md](references/release.md) | Mixed versions, recovery, idempotency, observability, staged release, release-state evidence |

## Rules

MUST Edit generated or vendored behavior through its owned source, generator, or upstream mechanism.
NOT Introduce classes, interfaces, configuration, frameworks, or tests merely to demonstrate compliance.
