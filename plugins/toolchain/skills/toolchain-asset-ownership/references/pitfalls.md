# Pitfalls

## Per-plugin updates restart the running service

**Symptom:** `ClientError ECONNRESET` during `opencode plugin update <package spec>`, then `Plugin is not configured` on the later updates in the loop.
**Cause:** On pace, a loop of per-plugin updates against the background service saw the service come back as a new `opencode serve --service` process mid-loop (opencode-plugins-4ap). The service restart cut the update's connection and live sessions. The trigger inside OpenCode is not confirmed. A no-target update on a Mac did not restart it once, but restarts followed other updates there.
**Fix:** Run one `opencode plugin update` with no target, not a loop. To keep it off the service, add `--standalone`, which uses a private server. Whether a standalone update leaves the running service untouched is untested. Restart the service at a planned time afterwards, then re-run the update for any plugin that still reports `Plugin is not configured`.
