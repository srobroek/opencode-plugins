import { describe, expect, setDefaultTimeout, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  decidePath,
  decideToolCall,
  latestMigration,
  migrationOverride,
  migrationTarget,
  orderKey,
  shipped,
} from "./migrations.ts"
import { budget, ProbeTimeout } from "./probes.ts"

setDefaultTimeout(60_000)

function scratch(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "safety-migrations-"))
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), "SELECT 1;\n")
  }
  return root
}

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  })
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`)
}

/** A repo whose `main` holds `shippedFiles`, checked out on `feature` with `branchFiles` committed and `untracked` left loose. */
function repo(shippedFiles: string[], branchFiles: string[] = [], untracked: string[] = []): string {
  const root = scratch(shippedFiles)
  git(root, "init", "-q", "-b", "main")
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "add", ".")
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
  git(root, "checkout", "-qb", "feature")
  for (const file of branchFiles) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), "SELECT 2;\n")
  }
  if (branchFiles.length > 0) {
    git(root, "add", ".")
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "branch")
  }
  for (const file of untracked) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), "SELECT 3;\n")
  }
  return root
}

describe("migrationTarget", () => {
  test.each([
    ["migrations/0001_init.sql", "migrations", "0001_init.sql"],
    ["crates/db/migrations/20240115120000_add.sql", "crates/db/migrations", "20240115120000_add.sql"],
    ["migrations/2024-01-15-120000_add/up.sql", "migrations", "2024-01-15-120000_add"],
    ["migrations/V3__add.sql", "migrations", "V3__add.sql"],
    ["shop/migrations/0002_order.py", "shop/migrations", "0002_order.py"],
    ["prisma/migrations/20240101000000_init/migration.sql", "prisma/migrations", "20240101000000_init"],
    ["db/migrate/20240101000000_create_users.rb", "db/migrate", "20240101000000_create_users.rb"],
    ["src/main/resources/db/migration/V1.1__x.sql", "src/main/resources/db/migration", "V1.1__x.sql"],
  ])("ordered: %s", (path, dir, entry) => {
    expect(migrationTarget(path)).toEqual({ dir, entry, layout: "ordered" })
  })

  test("alembic revisions are unordered", () => {
    expect(migrationTarget("alembic/versions/ae1027a6acf_add.py")).toEqual({
      dir: "alembic/versions",
      entry: "ae1027a6acf_add.py",
      layout: "alembic",
    })
    expect(migrationTarget("alembic/versions/__init__.py")).toBeNull()
  })

  test.each([
    "migrations/README.md",
    "migrations/.gitkeep",
    "shop/migrations/__init__.py",
    "prisma/migrations/migration_lock.toml",
    "migrations/R__views.sql",
    "src/migrate/0001_x.rb",
    "docs/migrations-guide.md",
    "src/lib.rs",
  ])("not a migration: %s", (path) => {
    expect(migrationTarget(path)).toBeNull()
  })
})

describe("ordering", () => {
  test("keys compare numerically per group", () => {
    expect(orderKey("2024-01-15-120000_x")).toEqual([2024n, 1n, 15n, 120000n])
    expect(orderKey("V1.10__x")).toEqual([1n, 10n])
    expect(orderKey("0003_name")).toEqual([3n])
  })

  test("latestMigration ranks 10 above 2", () => {
    const root = scratch(["migrations/1_a.sql", "migrations/2_b.sql", "migrations/10_c.sql", "migrations/README.md"])
    expect(latestMigration(join(root, "migrations"))).toBe("10_c.sql")
    expect(latestMigration(join(root, "nowhere"))).toBeUndefined()
  })
})

describe("shipped", () => {
  const run = budget().run

  test("on the default branch: shipped; added on the branch or untracked: not", async () => {
    const root = repo(["migrations/0001_init.sql"], ["migrations/0002_add.sql"], ["migrations/0003_new.sql"])
    expect(await shipped(join(root, "migrations/0001_init.sql"), run)).toBe(true)
    expect(await shipped(join(root, "migrations/0002_add.sql"), run)).toBe(false)
    expect(await shipped(join(root, "migrations/0003_new.sql"), run)).toBe(false)
  })

  test("outside git, unknown", async () => {
    const root = scratch(["migrations/0001_init.sql"])
    expect(await shipped(join(root, "migrations/0001_init.sql"), run)).toBeUndefined()
  })

  test("a timed-out git is unknown", async () => {
    const root = repo(["migrations/0001_init.sql"])
    const slow = budget({
      spawn: async (argv) => {
        throw new ProbeTimeout(argv.join(" "))
      },
    }).run
    expect(await shipped(join(root, "migrations/0001_init.sql"), slow)).toBeUndefined()
  })
})

describe("decidePath", () => {
  test("refuses a shipped migration, even the newest", async () => {
    const root = repo(["migrations/0001_init.sql", "migrations/0002_add.sql"])
    const reason = await decidePath(join(root, "migrations/0002_add.sql"))
    expect(reason).toContain("migration-edit")
    expect(reason).toContain("NEW migration")
    expect(reason?.length).toBeLessThan(500)
  })

  test("branch-local migrations stay editable, older ones included", async () => {
    const root = repo(["migrations/0004_x.sql"], ["migrations/0005_a.sql", "migrations/0006_b.sql"])
    expect(await decidePath(join(root, "migrations/0005_a.sql"))).toBeUndefined()
    expect(await decidePath(join(root, "migrations/0006_b.sql"))).toBeUndefined()
    expect(await decidePath(join(root, "migrations/0007_new.sql"))).toBeUndefined()
  })

  test("prisma, django and alembic layouts", async () => {
    const root = repo([
      "prisma/migrations/20240101000000_init/migration.sql",
      "shop/migrations/0001_initial.py",
      "alembic/env.py",
      "alembic/versions/ae1027a6acf_add.py",
    ])
    expect(await decidePath(join(root, "prisma/migrations/20240101000000_init/migration.sql"))).toBeDefined()
    expect(await decidePath(join(root, "shop/migrations/0001_initial.py"))).toBeDefined()
    expect(await decidePath(join(root, "alembic/versions/ae1027a6acf_add.py"))).toBeDefined()
  })

  test("outside git: only the newest ordered migration is editable; alembic is left alone", async () => {
    const root = scratch([
      "migrations/0001_init.sql",
      "migrations/0002_add.sql",
      "alembic/env.py",
      "alembic/versions/a_x.py",
      "alembic/versions/b_y.py",
    ])
    expect(await decidePath(join(root, "migrations/0001_init.sql"))).toContain("0002_add.sql")
    expect(await decidePath(join(root, "migrations/0002_add.sql"))).toBeUndefined()
    expect(await decidePath(join(root, "alembic/versions/a_x.py"))).toBeUndefined()
  })

  test("a versions/ directory without alembic's env.py is not alembic", async () => {
    const root = repo(["api/versions/v1.py"])
    expect(await decidePath(join(root, "api/versions/v1.py"))).toBeUndefined()
  })
})

describe("decideToolCall", () => {
  test("write, edit, every patch header and shell writes; reads pass", async () => {
    const root = repo(["migrations/0001_init.sql"], ["migrations/0002_add.sql"])
    const old = "migrations/0001_init.sql"
    expect(await decideToolCall("write", { path: old, content: "x" }, root)).toBeDefined()
    expect(await decideToolCall("edit", { path: join(root, old), oldString: "1", newString: "2" }, "/")).toBeDefined()
    const patchText = `*** Begin Patch\n*** Update File: migrations/0002_add.sql\n+x\n*** Delete File: ${old}\n*** End Patch`
    expect(await decideToolCall("patch", { patchText }, root)).toBeDefined()
    expect(await decideToolCall("shell", { command: `sed -i s/1/2/ ${old}` }, root)).toBeDefined()
    expect(await decideToolCall("shell", { command: `echo x >> ${old}` }, root)).toBeDefined()
    expect(await decideToolCall("shell", { command: `cp /dev/null ${old}` }, root)).toBeDefined()
    expect(await decideToolCall("bash", { command: "tee 0001_init.sql", workdir: join(root, "migrations") }, root)).toBeDefined()
    expect(await decideToolCall("shell", { command: `cat ${old}` }, root)).toBeUndefined()
    expect(await decideToolCall("shell", { command: "mv migrations/0002_add.sql migrations/0003_add.sql" }, root)).toBeUndefined()
    expect(await decideToolCall("read", { path: old }, root)).toBeUndefined()
  })
})

test("migrationOverride reads SAFETY_ALLOW_MIGRATION_EDIT", () => {
  expect(migrationOverride({ SAFETY_ALLOW_MIGRATION_EDIT: "1" })).toBe(true)
  expect(migrationOverride({ SAFETY_ALLOW_MIGRATION_EDIT: "true" })).toBe(true)
  expect(migrationOverride({ SAFETY_ALLOW_MIGRATION_EDIT: "0" })).toBe(false)
  expect(migrationOverride({})).toBe(false)
})
