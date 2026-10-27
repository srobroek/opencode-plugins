# Safe mutation: plan, approve, apply

Read when code performs side effects behind a plan/approve/apply flow: bulk file moves, deletes, migrations, infrastructure changes, or any operation a user reviews before it runs. Persistence-level atomicity is in [persistence.md](persistence.md); release-time recovery is in [release.md](release.md).

## Approval is a token checked at apply time

**Do:** issue an approval token bound to the reviewed plan and re-verify it when applying. A stale or mismatched token errors.
**Do not:** store `approved = true` at review time and trust it later. The gap between review and apply is where time-of-check/time-of-use (TOCTOU) bugs live.

Bad: `plan.approved = true` is saved; apply runs an hour later against whatever the plan now contains.
Good: approval records the plan digest; apply recomputes the digest and refuses when it differs.

## Revalidate freshness per item

**Do:** at apply time, compare each item's strong identity (a monotonic revision, content digest, or `mtime`+size+inode where nothing stronger exists) with the value seen at plan time. A changed item pauses the plan for re-review rather than applying to stale state.
**Do not:** compare names or paths only; a file replaced under the same name looks unchanged.

## Paths and traversal

**Do:** normalize paths lexically, resolve them against an explicit root, and `lstat` each component. Reject symlink and junction traversal unless a root explicitly enables it.
**Do not:** check `path.startsWith(root)` on an unnormalized string, or follow a symlink out of the root after the check.

## Audit and progress

**Do:** write an audit record for every attempted action and its outcome (applied, refused, failed). Keep the audit trail append-only.
**Do not:** treat the live progress stream or UI log as the audit trail; it is additive and lossy.

## Reversibility

**Do:** prefer trash, archive, or soft delete over permanent delete. Permanent delete needs separate explicit consent.
**Do not:** fold "and also purge" into the same confirmation as the reversible action.

**Exception:** a disposable script that moves files in a scratch directory it created needs none of this ceremony. The rules apply where a user's data or shared state is at stake.
