import { describe, expect, test } from "bun:test"
import { persistentScannerInstall } from "./scanner-install.ts"

const FIRE: Array<[string, string]> = [
  ["pip install pip-audit", "pip-audit"],
  ["pip3 install --user pip-audit", "pip-audit"],
  ["python -m pip install pip-audit", "pip-audit"],
  ['python3 -m pip install "pip-audit==2.7.0"', "pip-audit"],
  ["pipx install pip-audit", "pip-audit"],
  ["uv tool install pip-audit", "pip-audit"],
  ["brew install osv-scanner", "osv-scanner"],
  ["npm install --global osv-scanner", "osv-scanner"],
  ["npm i -g osv-scanner", "osv-scanner"],
  ["cargo install cargo-audit", "cargo-audit"],
  ["cargo install --locked cargo-audit", "cargo-audit"],
  ["cargo binstall cargo-audit", "cargo-audit"],
  ["go install golang.org/x/vuln/cmd/govulncheck@latest", "govulncheck"],
  ["go install golang.org/x/vuln/cmd/govulncheck@v1.1.3", "govulncheck"],
  ["cd /tmp && pip install pip-audit", "pip-audit"],
  ["echo hi; sudo pip install pip-audit", "pip-audit"],
  ["if true; then pipx install pip-audit; fi", "pip-audit"],
  ["ls\npip install pip-audit", "pip-audit"],
  ["yarn global add osv-scanner", "osv-scanner"],
  ["env CI=1 timeout 60 pipx install pip-audit", "pip-audit"],
  ["echo $(pipx install pip-audit)", "pip-audit"],
]

const HOLD = [
  "uvx pip-audit",
  "go run golang.org/x/vuln/cmd/govulncheck@latest",
  'echo "pip install pip-audit"',
  'echo "x && pip install pip-audit"',
  "printf 'cargo install cargo-audit'",
  "echo 'a; pipx install pip-audit'",
  "pip install requests --log pip-audit.log",
  'bd create --description "cargo install cargo-audit"',
  "npm install --save-dev osv-scanner-helper",
  "npm install osv-scanner",
  "pip-audit -r requirements.txt",
  "command -v pip-audit",
  'git commit -m "brew install osv-scanner"',
  "echo pip install pip-audit",
  "cat <<'EOF'\npip install pip-audit\nEOF",
]

describe("persistentScannerInstall", () => {
  for (const [command, scanner] of FIRE) {
    test(`fires: ${JSON.stringify(command)}`, () => {
      expect(persistentScannerInstall(command)).toBe(scanner)
    })
  }
  for (const command of HOLD) {
    test(`holds: ${JSON.stringify(command)}`, () => {
      expect(persistentScannerInstall(command)).toBeUndefined()
    })
  }
})
