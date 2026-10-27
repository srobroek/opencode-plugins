import type { Question } from "./questions.ts"
import { isStructured, structuredDefault, validateStructuredValue } from "./structured.ts"
import type { Draft } from "./tui-state.ts"

interface Value {
  fields?: Record<string, string | number | boolean>
  buckets?: Record<string, string[]>
  pairs?: Record<string, string>
  allocations?: Record<string, number>
  scores?: Record<string, Record<string, number>>
  min?: number
  max?: number
  paths?: string[]
  tags?: string[]
  value?: string
  hex?: string
}

// Solid's draft store supplies proxies, which structuredClone rejects. These answer values are JSON-only.
const draftValue = (q: Question, draft: Draft) => JSON.parse(JSON.stringify(draft.value ?? structuredDefault(q))) as Value
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
const tidy = (n: number) => Number(n.toPrecision(15))
const cycle = <T>(values: readonly T[], current: T | undefined, delta: number) => values[(Math.max(0, values.indexOf(current as T)) + delta + values.length) % values.length]
const changed = (draft: Draft, value: Value): Draft => ({ ...draft, status: "answered", value })

/** Each row is a field/item/cell; IDs are stable across value changes. */
export function structuredRows(q: Question): { id: string; label: string }[] {
  const config = q.config ?? {}
  switch (q.kind) {
    case "form": return (config.fields ?? []).map((field) => ({ id: field.id, label: `${field.label} (${field.type})` }))
    case "buckets": case "match": return [...(config.items ?? [])]
    case "allocate": return [...(q.options ?? [])]
    case "matrix": return (q.options ?? []).flatMap((option) => (config.criteria ?? []).map((criterion) => ({ id: `${option.id}/${criterion.id}`, label: `${option.label} × ${criterion.label}` })))
    case "range": return [{ id: "min", label: "Minimum" }, { id: "max", label: "Maximum" }]
    case "tags": return (config.suggestions ?? []).map((tag) => ({ id: tag.trim(), label: tag.trim() }))
    case "colour": return (config.swatches ?? ["#808080"]).map((hex) => ({ id: hex.toLowerCase(), label: hex.toLowerCase() }))
    default: return [{ id: q.kind, label: q.kind }]
  }
}

export function structuredRowText(q: Question, draft: Draft, id: string): string {
  const value = draftValue(q, draft)
  switch (q.kind) {
    case "form": return String(value.fields?.[id] ?? "")
    case "buckets": {
      const category = (q.config?.categories ?? []).find((entry) => value.buckets?.[entry.id]?.includes(id))
      return category?.label ?? "unassigned"
    }
    case "match": return q.config?.targets?.find((entry) => entry.id === value.pairs?.[id])?.label ?? "unpaired"
    case "allocate": return `${value.allocations?.[id] ?? 0}${q.unit ? ` ${q.unit}` : ""}`
    case "matrix": { const [option, criterion] = id.split("/"); return String(value.scores?.[option ?? ""]?.[criterion ?? ""] ?? q.min ?? 0) }
    case "range": return `${value[id as "min" | "max"] ?? ""}${q.unit ? ` ${q.unit}` : ""}`
    case "tags": return value.tags?.includes(id) ? "[x]" : "[ ]"
    case "colour": return value.hex?.toLowerCase() === id.toLowerCase() ? "●" : "○"
    case "path": return value.paths?.join(", ") ?? ""
    default: return value.value ?? ""
  }
}

/** Arithmetic navigation is UTC/local-ISO, never affected by the machine's timezone or DST. */
function temporalStep(q: Question, value: string, delta: number, month = false): string {
  if (q.kind === "time") {
    const [hour, minute] = value.split(":").map(Number)
    const total = clamp((hour ?? 0) * 60 + (minute ?? 0) + delta, 0, 1439)
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`
  }
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`)
  if (month) {
    const day = date.getUTCDate()
    date.setUTCDate(1)
    date.setUTCMonth(date.getUTCMonth() + delta)
    const lastDay = new Date(date)
    lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0)
    const last = lastDay.getUTCDate()
    date.setUTCDate(Math.min(day, last))
  } else date.setUTCDate(date.getUTCDate() + delta)
  if (date.getUTCFullYear() < 0) return `0000-01-01${q.kind === "datetime" ? value.slice(10) : ""}`
  if (date.getUTCFullYear() > 9999) return `9999-12-31${q.kind === "datetime" ? value.slice(10) : ""}`
  return `${date.toISOString().slice(0, 10)}${q.kind === "datetime" ? value.slice(10) : ""}`
}

/** Splits preserve the total: a change transfers points to/from the next option. */
function allocate(q: Question, value: Value, id: string, requested: number) {
  const ids = (q.options ?? []).map((option) => option.id)
  const other = ids[(ids.indexOf(id) + 1) % ids.length]
  if (!other || other === id || !value.allocations) return
  const current = value.allocations[id] ?? 0
  const donor = value.allocations[other] ?? 0
  const next = clamp(requested, 0, current + donor)
  value.allocations[id] = tidy(next)
  value.allocations[other] = tidy(donor + current - next)
}

export function structuredStep(q: Question, draft: Draft, delta: number, month = false): Draft {
  const value = draftValue(q, draft)
  const id = structuredRows(q)[draft.cursor]?.id ?? ""
  const config = q.config ?? {}
  const size = q.step ?? 1
  switch (q.kind) {
    case "form": {
      const field = config.fields?.find((entry) => entry.id === id)
      if (!field || !value.fields) return draft
      const current = value.fields[id]
      if (field.type === "toggle") value.fields[id] = !current
      else if (field.type === "choice") value.fields[id] = cycle(field.options ?? [], current as string, delta) ?? ""
      else if (field.type === "number") value.fields[id] = clamp(Number(current ?? 0) + delta, field.min ?? -Number.MAX_SAFE_INTEGER, field.max ?? Number.MAX_SAFE_INTEGER)
      else return draft
      break
    }
    case "buckets": {
      const categories = (config.categories ?? []).map((entry) => entry.id)
      const current = categories.find((category) => value.buckets?.[category]?.includes(id))
      const next = cycle(categories, current, delta)
      if (!next || !value.buckets) return draft
      for (const category of categories) value.buckets[category] = (value.buckets[category] ?? []).filter((item) => item !== id)
      value.buckets[next]?.push(id)
      break
    }
    case "match": {
      const targets = (config.targets ?? []).map((entry) => entry.id)
      const current = value.pairs?.[id]
      const next = cycle(targets, current, delta)
      if (!next || !value.pairs) return draft
      const other = Object.keys(value.pairs).find((left) => value.pairs?.[left] === next)
      if (other && current) value.pairs[other] = current
      value.pairs[id] = next
      break
    }
    case "allocate": allocate(q, value, id, (value.allocations?.[id] ?? 0) + delta * size); break
    case "matrix": {
      const [option, criterion] = id.split("/")
      const row = value.scores?.[option ?? ""]
      if (!row || !criterion) return draft
      const min = q.min ?? 0
      const max = min + Math.floor(((q.max ?? 5) - min) / size + 1e-8) * size
      row[criterion] = tidy(clamp((row[criterion] ?? min) + delta * size, min, max))
      break
    }
    case "range": {
      const key = id as "min" | "max"
      const lower = key === "max" ? value.min ?? q.min ?? 0 : q.min ?? 0
      const bound = key === "min" ? value.max ?? q.max ?? 10 : q.max ?? 10
      const upper = (q.min ?? 0) + Math.floor((bound - (q.min ?? 0)) / size + 1e-8) * size
      value[key] = tidy(clamp((value[key] ?? lower) + delta * size, lower, upper))
      break
    }
    case "colour": {
      const swatches = (config.swatches ?? ["#808080"]).map((hex) => hex.toLowerCase())
      value.hex = cycle(swatches, value.hex, delta) ?? "#808080"
      return { ...changed(draft, value), cursor: Math.max(0, swatches.indexOf(value.hex)) }
    }
    case "date": case "time": case "datetime": {
      const next = temporalStep(q, value.value ?? "", delta, month)
      value.value = config.min && next < config.min ? config.min : config.max && next > config.max ? config.max : next
      break
    }
    default: return draft
  }
  return changed(draft, value)
}

export function structuredChoose(q: Question, draft: Draft, index: number): Draft {
  const next = { ...draft, cursor: index }
  if (q.kind === "colour") return changed(next, { hex: (structuredRows(q)[index]?.id ?? "#808080").toLowerCase() })
  if (q.kind === "tags") {
    const value = draftValue(q, draft)
    const id = structuredRows(q)[index]?.id
    if (!id) return draft
    const tags = value.tags ?? []
    value.tags = tags.includes(id) ? tags.filter((tag) => tag !== id) : q.max === undefined || tags.length < q.max ? [...tags, id] : tags
    return changed(next, value)
  }
  return structuredStep(q, next, 1)
}

export function structuredEditText(q: Question, draft: Draft): string {
  const value = draftValue(q, draft)
  const id = structuredRows(q)[draft.cursor]?.id ?? ""
  switch (q.kind) {
    case "form": return String(value.fields?.[id] ?? "")
    case "allocate": return String(value.allocations?.[id] ?? 0)
    case "matrix": { const [option, criterion] = id.split("/"); return String(value.scores?.[option ?? ""]?.[criterion ?? ""] ?? q.min ?? 0) }
    case "range": return String(value[id as "min" | "max"] ?? "")
    case "path": return (value.paths ?? []).join("\n")
    case "tags": return (value.tags ?? []).join(", ")
    case "colour": return value.hex ?? ""
    default: return value.value ?? ""
  }
}

/** e edits one typed field/cell rather than asking the user to write JSON. */
export function structuredSetText(q: Question, draft: Draft, text: string): { draft: Draft } | { error: string } {
  const value = draftValue(q, draft)
  const id = structuredRows(q)[draft.cursor]?.id ?? ""
  const trimmed = text.trim()
  const numeric = () => trimmed !== "" && Number.isFinite(Number(trimmed))
  switch (q.kind) {
    case "form": {
      const field = q.config?.fields?.find((entry) => entry.id === id)
      if (!field || !value.fields) return { error: "No field selected" }
      if (field.type === "number") {
        if (!numeric() || (field.min !== undefined && Number(trimmed) < field.min) || (field.max !== undefined && Number(trimmed) > field.max)) return { error: "Enter a number within the field bounds" }
        value.fields[id] = Number(trimmed)
      } else if (field.type === "toggle") {
        if (!/^(true|false)$/i.test(trimmed)) return { error: "Enter true or false" }
        value.fields[id] = trimmed.toLowerCase() === "true"
      } else if (field.type === "choice") {
        if (!field.options?.includes(trimmed)) return { error: `Choose ${field.options?.join(", ")}` }
        value.fields[id] = trimmed
      } else value.fields[id] = text
      if (field.required && trimmed === "") return { error: "This field is required" }
      return { draft: changed(draft, value) }
    }
    case "allocate": {
      const total = q.config?.total ?? 100
      if (!numeric() || Number(trimmed) < 0 || Number(trimmed) > total) return { error: `Enter 0..${total}` }
      const ids = (q.options ?? []).map((option) => option.id)
      const wanted = Number(trimmed)
      let remaining = wanted - (value.allocations?.[id] ?? 0)
      if (!value.allocations) return { error: "No allocation" }
      for (const other of ids.filter((candidate) => candidate !== id)) {
        const transfer = remaining > 0 ? Math.min(remaining, value.allocations[other] ?? 0) : remaining
        value.allocations[other] = tidy((value.allocations[other] ?? 0) - transfer)
        remaining -= transfer
      }
      value.allocations[id] = wanted
      break
    }
    case "matrix": {
      if (!numeric()) return { error: "Enter a number" }
      const [option, criterion] = id.split("/")
      const row = value.scores?.[option ?? ""]
      if (row && criterion) row[criterion] = Number(trimmed)
      break
    }
    case "range": if (!numeric()) return { error: "Enter a number" }; value[id as "min" | "max"] = Number(trimmed); break
    case "path": value.paths = trimmed.split(/[\n,]/).map((path) => path.trim()).filter(Boolean); break
    case "tags": value.tags = trimmed.split(/[\n,]/).map((tag) => tag.trim()).filter(Boolean); break
    case "colour": value.hex = trimmed; break
    case "date": case "time": case "datetime": value.value = trimmed; break
    default: return { draft }
  }
  const checked = validateStructuredValue(q, value)
  return "error" in checked ? checked : { draft: changed(draft, checked.value as Value) }
}

export function structuredKeys(q: Question): string {
  switch (q.kind) {
    case "form": return "↑/↓ field · ←/→ choice/toggle/number · e type field"
    case "buckets": return "↑/↓ item · ←/→ category"
    case "match": return "↑/↓ item · ←/→ partner (swaps)"
    case "allocate": return "↑/↓ option · ←/→ transfer points · e type amount"
    case "matrix": return "↑/↓ cell · ←/→ score · e type score"
    case "range": return "↑/↓ endpoint · ←/→ adjust · e type endpoint"
    case "path": return "e type paths · ↑/↓ suggestion · tab complete"
    case "tags": return "↑/↓ suggestion · space toggle · e comma-separated tags"
    case "colour": return "←/→ swatch · space choose · e hex"
    case "time": return "←/→ minute · ↑/↓ hour · e HH:mm"
    default: return "←/→ day · ↑/↓ week · shift+←/→ month · e ISO date/time"
  }
}

export function calendarText(value: string): string {
  const date = new Date(`${value.slice(0, 10)}T12:00:00Z`)
  if (!Number.isFinite(date.getTime())) return value
  const monthStart = new Date(date)
  monthStart.setUTCDate(1)
  const first = monthStart.getUTCDay()
  monthStart.setUTCMonth(monthStart.getUTCMonth() + 1, 0)
  const last = monthStart.getUTCDate()
  const cells = Array.from({ length: first + last }, (_, i) => i < first ? "    " : i - first + 1 === date.getUTCDate() ? `[${String(i - first + 1).padStart(2)}]` : ` ${String(i - first + 1).padStart(2)} `)
  const weeks: string[] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7).join(""))
  return `${value.slice(0, 7)}\n Su  Mo  Tu  We  Th  Fr  Sa\n${weeks.join("\n")}`
}

export const structuredEditable = (q: Question) => isStructured(q) && q.kind !== "buckets" && q.kind !== "match"
