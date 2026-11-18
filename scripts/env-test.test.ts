import { expect, test } from "bun:test"

// Bun.spawnSync without `env` passes the startup environment, so this proves
// `.env.test` was loaded before any code ran.
test(".env.test excludes the host git config from spawned children", () => {
  const child = Bun.spawnSync(["sh", "-c", 'printf "%s|%s" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_NOSYSTEM"'])
  expect(child.stdout.toString()).toBe("/dev/null|1")
})
