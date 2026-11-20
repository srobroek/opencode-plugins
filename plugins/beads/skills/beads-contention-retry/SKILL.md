---
name: beads-contention-retry
description: How to treat embedded-store contention (lock busy, workspace gate busy) and retry a failed bd dolt pull or push.
metadata:
  opencode/autoinvoke: false
---

## Contention messages

- `a maintenance operation is running on this workspace: retry when it completes`
- `other bd commands are using this workspace: wait for them to finish and retry`
- `lock busy: held by another process`
- `lock already held by another process`
- `workspace gate busy`

Any of these is contention, not a failure. The embedded store is single-writer by design.
Ordinary commands share a cooperative gate. Maintenance takes the gate exclusively.
A concurrent writer is therefore the expected case, not a defect.
The limit applies to store writes only. It says nothing about code, file, or git work: subagents run that in parallel.

When you see one of these messages, MUST wait briefly and retry the same command, up to three attempts. Then report what still failed.

- NEVER escalate it.
- NEVER report the run as blocked on it.
- NEVER work around it.

Agents MUST NOT build their own serialization. Agents MUST NOT build a wrapper, a mutex, or a retry helper. When the beads shell gate is active, its embedded-write lock already serializes writes.
Nothing about the store needs changing.

NEVER treat `warning: workspace gate unavailable, continuing ungated` or
`warning: workspace gate acquisition failed, continuing ungated` as contention.
Those commands RAN. Retrying repeats work that already happened.

A message not on this list is a different problem. Report it verbatim rather than
retrying it, so whatever it actually is gets seen.

## Remote sync

`bd dolt pull` and `bd dolt push` are persistence, never a mutex. Never use a sync
to serialize writers. The section above covers contention.

MUST bound each `bd dolt pull` or `bd dolt push` attempt to 180 seconds (or a
shorter caller deadline). Then retry the same command, up to three attempts, with
a brief wait.

When an attempt times out or the caller kills it, report it verbatim as the failed
attempt. Do not assume the remote state until a later retry completes.

When a sync fails three times, report it. Do not work around it:

- NEVER fall back to a manual `dolt` invocation.
- NEVER start a server.
- NEVER continue as though the remote were current.

After the retry sequence, a partially applied sync leaves reads stale. Before you trust a read that
decides work assignment, MUST re-run `bd dolt pull`.

## Remote-sync diagnosis and probe

The observed multi-minute stalls are in the Dolt remote/conjoin path, not the
embedded writer lock. The lock deliberately excludes `bd dolt push` from its
serialized operation set, so waiting for that lock cannot make a push complete.
The local-file-remote probe below reproduced the important failure boundary.
It also established the recovery invariant without depending on a hosted service:

- The probe configured a scratch embedded ledger with `file:///private/tmp/omp-g3dl-remote-w2`.
- With a pending issue, the probe terminated a `bd dolt push` child with `SIGTERM`.
  The exact observed result was `exit=-15`, with empty stdout and stderr.
- Retrying the same `bd dolt push` completed with `Push complete.`
- The probe made a fresh Dolt clone of that remote and ran `dolt pull origin main`.
  The result showed both `probe-bgl | consistency probe` and `probe-r74 | retry consistency probe`.

A killed or timed-out push leaves the remote state unknown until the
same command succeeds on retry. After success, a fresh clone is the consistency
check. This is a probe result. It is not a claim that every hosted-remote stall has
the same transport-level cause.

This project records only the contention messages listed at the top. It holds no record of `bd dolt` failure
text, so this skill matches none. The sync
policy is therefore prose the agent applies after reading the command's own
output. It is not a pattern this skill claims to detect.
