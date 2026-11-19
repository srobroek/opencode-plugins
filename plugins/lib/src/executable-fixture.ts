/**
 * Test executables (stub CLIs, Git hooks, filter drivers) that start without an
 * endpoint scan.
 *
 * Endpoint security agents on developer machines check a file the first time it is
 * executed, and under load that check has been measured at 0.3–28 s per new file;
 * a symlink to a file that was already checked starts in milliseconds. So every
 * executable a test writes is a symlink to one committed trampoline, and the script
 * itself is a plain file it sources. The process is the same `/bin/sh` either way:
 * `$0`, `$$`, `"$@"`, `exec` and `exit` behave as they would in the script.
 *
 * ```ts
 * writeExecutable(join(bin, "bd"), "#!/bin/sh\necho stub\nexit 3\n")
 * ```
 */

import { lstatSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/** The committed trampoline; see `executable-fixture.sh`. */
export const TRAMPOLINE = join(import.meta.dir, "executable-fixture.sh")

const SHEBANG = /^#!\/bin\/sh[ \t]*\r?\n/

/**
 * Make `path` an executable that runs `script` with `/bin/sh`. `script` is a `/bin/sh`
 * script; its `#!/bin/sh` line is optional. An existing file at `path` is replaced.
 */
export function writeExecutable(path: string, script: string): void {
  if (script.startsWith("#!") && !SHEBANG.test(script)) throw new Error(`writeExecutable: ${path} must be a /bin/sh script`)
  writeFileSync(`${path}.body`, script.replace(SHEBANG, ""))
  if (exists(path)) rmSync(path)
  symlinkSync(TRAMPOLINE, path)
}

function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
