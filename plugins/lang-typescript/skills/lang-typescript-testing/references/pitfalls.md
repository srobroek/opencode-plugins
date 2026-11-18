# TypeScript testing pitfalls

## Bun.spawn without env passes the startup environment

**Symptom:** a child ignores a variable the test or preload set on `process.env`: `printf %s "$GIT_CONFIG_GLOBAL"` prints an empty string in the child, and git in a scratch repo still signs commits or runs host hooks.
**Cause:** `Bun.spawn` and `Bun.spawnSync` without `env` give the child the environment from process start, not the current `process.env` (checked on Bun 1.4.4).
**Fix:** pass `env: process.env` or an explicit env, or set test-wide values in a committed `.env.test`, which `bun test` loads before any code runs.
