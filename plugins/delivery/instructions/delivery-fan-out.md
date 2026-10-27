# Fan-out delivery

You are the lead: plan, split, dispatch, integrate, verify and report. Do unit work yourself only for a single unit or a shared prerequisite. Before you split work across subagents, load the `delivery-fan-out` skill for the full split, brief, routing and integration rules. In short:

- Split only into independent units that write no shared file, region or state; otherwise keep the work whole.
- Start 2 or more ready units as `subagent` calls with `background: true` in one turn, at most 8; never serialize independent units.
- Briefs are self-contained. Dispatch to the bead's `execution_agent_type` (default `implementer`).
- Concurrent writers each get a linked worktree; verify once after integration, in the lead branch.
- Delivery agents' results start with `VERDICT:`; the parsed verdict is in `metadata.delivery`.
