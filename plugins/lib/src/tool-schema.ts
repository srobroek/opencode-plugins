/** Reading and extending a host tool's input schema from a tool transform. */

export type JsonObjectSchema = {
  type: "object"
  properties: Record<string, Record<string, unknown>>
  required?: string[]
  additionalProperties?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const JSON_TYPES: Readonly<Record<string, string>> = { String: "string", Boolean: "boolean", Number: "number" }

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A tool input as JSON Schema. Accepts a JSON Schema object as is, or reads an Effect
 * struct's AST of plain strings, booleans and numbers (the built-in `subagent` tool in
 * OpenCode 2.1.4). Anything else returns `undefined`, so the caller leaves the schema alone.
 */
export function toJsonSchema(input: unknown): JsonObjectSchema | undefined {
  if (isRecord(input) && input.type === "object" && isRecord(input.properties))
    return structuredClone(input) as JsonObjectSchema
  const ast = (input as { ast?: unknown } | null | undefined)?.ast
  if (!isRecord(ast) || ast._tag !== "Objects" || !Array.isArray(ast.propertySignatures)) return undefined
  if (Array.isArray(ast.indexSignatures) && ast.indexSignatures.length > 0) return undefined
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const signature of ast.propertySignatures as unknown[]) {
    if (!isRecord(signature) || typeof signature.name !== "string" || !isRecord(signature.type)) return undefined
    const type = signature.type
    const json = typeof type._tag === "string" ? JSON_TYPES[type._tag] : undefined
    if (json === undefined) return undefined
    const property: Record<string, unknown> = { type: json }
    let description =
      isRecord(type.annotations) && typeof type.annotations.description === "string" ? type.annotations.description : undefined
    for (const check of Array.isArray(type.checks) ? type.checks : []) {
      const annotations = isRecord(check) && isRecord(check.annotations) ? check.annotations : {}
      if (typeof annotations.description === "string") description ??= annotations.description
      const representation = isRecord(annotations.representation) ? annotations.representation : {}
      const payload = isRecord(representation.payload) ? representation.payload : {}
      if (representation.id === "effect/schema/isStartingWith" && typeof payload.startsWith === "string")
        property.pattern = `^${escapeRegExp(payload.startsWith)}`
    }
    if (description !== undefined) property.description = description
    properties[signature.name] = property
    const optional = isRecord(type.context) && type.context.isOptional === true
    if (!optional) required.push(signature.name)
  }
  return { type: "object", properties, required, additionalProperties: false }
}

type FieldSchema = { annotate?: (annotations: { description: string }) => unknown }
type StructSchema = { fields?: Record<string, FieldSchema>; mapFields?: (f: (fields: object) => object) => unknown }

/**
 * `input` with one more optional string property, or `undefined` when its shape is unknown.
 * An Effect struct that JSON Schema cannot express gets a copy of its optional `model`
 * field with the new description instead.
 */
export function withOptionalString(input: unknown, name: string, description: string): unknown {
  const schema = toJsonSchema(input)
  if (schema !== undefined) {
    schema.properties[name] = { type: "string", description }
    schema.required = (schema.required ?? []).filter((field) => field !== name)
    return schema
  }
  const struct = input as StructSchema | undefined
  const model = struct?.fields?.model
  if (typeof struct?.mapFields !== "function" || typeof model?.annotate !== "function") return undefined
  const field = model.annotate({ description })
  return struct.mapFields((fields) => ({ ...fields, [name]: field }))
}
