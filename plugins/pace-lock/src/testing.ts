import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = `#!/bin/sh
d="$(dirname "$0")"
cmd="$1"; shift
echo "$cmd $*" >> "$d/calls.log"
case "$cmd" in
  prefilter) cat "$d/prefilter" ;;
  check)
    cat > "$d/stdin.last"
    [ -f "$d/check_sleep" ] && sleep "$(cat "$d/check_sleep")"
    [ -f "$d/check_out" ] && cat "$d/check_out"
    exit "$(cat "$d/check_exit" 2>/dev/null || echo 0)" ;;
  bind)
    for a; do customer="$a"; done
    if [ -f "$d/bind_error" ]; then cat "$d/bind_error" >&2; exit 1; fi
    echo "{\\"customer\\":\\"$customer\\",\\"account\\":\\"111122223333\\",\\"region\\":\\"eu-west-1\\",\\"bound_at\\":\\"t0\\",\\"expires_at\\":\\"t1\\",\\"state\\":\\"bound\\"}" ;;
  status) echo '{"state":"unbound"}' ;;
  off) exit 0 ;;
esac
`

/** A stub of the shared `pace-lock` CLI in a scratch directory; behaviour comes from files next to the script. */
export function stubChecker() {
  const dir = mkdtempSync(join(tmpdir(), "pace-lock-stub-"))
  const bin = join(dir, "pace-lock")
  writeFileSync(bin, SCRIPT)
  chmodSync(bin, 0o755)
  const set = (name: string, value: string) => writeFileSync(join(dir, name), value)
  set("prefilter", "customer-a|customer-b")
  return {
    dir,
    bin,
    set,
    /** Every checker invocation as `<subcommand> <args>`, in order. */
    calls: (): string[] => {
      try {
        return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean)
      } catch {
        return []
      }
    },
    stdin: (): string => readFileSync(join(dir, "stdin.last"), "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
