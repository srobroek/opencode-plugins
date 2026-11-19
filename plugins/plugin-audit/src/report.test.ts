import { describe, expect, test } from "bun:test"
import type { Finding } from "./model.ts"
import { countFindings, formatReport } from "./report.ts"

const finding = (over: Partial<Finding>): Finding => ({
  category: "practices",
  plugin: "demo",
  severity: "warn",
  code: "x",
  message: "m",
  ...over,
})

describe("formatReport", () => {
  test("counts findings by severity and by category", () => {
    const counts = countFindings([finding({ severity: "error" }), finding({ category: "docs", severity: "info" })])
    expect(counts.total).toBe(2)
    expect(counts.bySeverity).toEqual({ error: 1, warn: 0, info: 1 })
    expect(counts.byCategory.docs).toBe(1)
  })

  test("groups by category then plugin, errors before warnings within a plugin", () => {
    const { content } = formatReport([
      finding({ plugin: "b", severity: "info", code: "later" }),
      finding({ plugin: "a", severity: "warn", code: "warned" }),
      finding({ plugin: "a", severity: "error", code: "broken" }),
    ])
    const lines = content.split("\n")
    expect(lines.indexOf("## practices (3)")).toBe(0)
    expect(lines.indexOf("a")).toBeLessThan(lines.indexOf("b"))
    expect(lines.indexOf("  error broken: m")).toBeLessThan(lines.indexOf("  warn  warned: m"))
    expect(lines.at(-1)).toBe("-- 3 findings: 1 error, 1 warn, 1 info --")
  })

  test("says so when there is nothing to report", () => {
    expect(formatReport([]).content).toBe("no findings\n-- 0 findings: 0 error, 0 warn, 0 info --")
  })
})
