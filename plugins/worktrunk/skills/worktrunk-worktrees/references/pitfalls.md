# Worktrunk pitfalls

## `wt switch` killed mid-provisioning

- **Symptom:** `wt switch` ends with a tool timeout or `SIGTERM`, and the worktree exists but has missing modules, missing ignored directories or a dirty `git status`.
- **Cause:** `wt switch` runs the pre-start hook in the foreground. The shell tool's default timeout (120000 ms) kills the hook with SIGTERM and leaves a half-provisioned worktree. The worktrunk plugin raises the timeout of a foreground `wt switch` call to 600000 ms; a call that sets a shorter one is raised too, and a host without the plugin keeps the default.
- **Fix:** Pass `timeout: 600000` (or more) on every `wt switch` call. Afterwards run `git status` in the new worktree and read the hook output (`wt config state logs --format=json`). If the worktree is half provisioned, remove it with `wt remove` and create it again; do not repair it by hand.
