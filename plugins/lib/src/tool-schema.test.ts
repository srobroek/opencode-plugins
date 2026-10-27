import { describe, expect, test } from "bun:test"
import { toJsonSchema, withOptionalString } from "./tool-schema.ts"

/** The built-in `subagent` input as its Effect struct AST looks at runtime (OpenCode 2.1.4). */
const effectInput = {
  fields: {},
  mapFields: () => undefined,
  ast: {
    _tag: "Objects",
    indexSignatures: [],
    propertySignatures: [
      { name: "agent", type: { _tag: "String", annotations: { description: "The agent" } } },
      { name: "prompt", type: { _tag: "String" } },
      {
        name: "sessionID",
        type: {
          _tag: "String",
          context: { isOptional: true },
          checks: [
            {
              _tag: "Filter",
              annotations: {
                description: "Continue a session",
                representation: { id: "effect/schema/isStartingWith", payload: { startsWith: "ses" } },
              },
            },
          ],
        },
      },
      { name: "background", type: { _tag: "Boolean", context: { isOptional: true } } },
    ],
  },
}

describe("toJsonSchema", () => {
  test("reads an Effect struct", () => {
    expect(toJsonSchema(effectInput)).toEqual({
      type: "object",
      properties: {
        agent: { type: "string", description: "The agent" },
        prompt: { type: "string" },
        sessionID: { type: "string", pattern: "^ses", description: "Continue a session" },
        background: { type: "boolean" },
      },
      required: ["agent", "prompt"],
      additionalProperties: false,
    })
  })

  test("copies JSON Schema and gives up on unknown shapes", () => {
    const json = { type: "object", properties: { a: { type: "string" } } }
    const copy = toJsonSchema(json)
    expect(copy).toEqual(json as never)
    expect(copy).not.toBe(json as never)
    const signatures = [...effectInput.ast.propertySignatures, { name: "x", type: { _tag: "Union" } }]
    expect(toJsonSchema({ ...effectInput, ast: { ...effectInput.ast, propertySignatures: signatures } })).toBeUndefined()
    expect(toJsonSchema(undefined)).toBeUndefined()
  })
})

describe("withOptionalString", () => {
  test("adds an optional string to JSON Schema without touching the original", () => {
    const json = { type: "object", properties: { a: { type: "string" } }, required: ["a", "w"] }
    expect(withOptionalString(json, "w", "Where")).toEqual({
      type: "object",
      properties: { a: { type: "string" }, w: { type: "string", description: "Where" } },
      required: ["a"],
    })
    expect(json.properties).toEqual({ a: { type: "string" } })
  })

  test("falls back to the Effect struct's model field", () => {
    const annotated = { kind: "model", description: "Where" }
    const struct = {
      fields: { model: { annotate: (a: { description: string }) => ({ ...annotated, ...a }) } },
      mapFields: (f: (fields: object) => object) => f({ model: "m" }),
    }
    expect(withOptionalString(struct, "w", "Where")).toEqual({ model: "m", w: annotated })
    expect(withOptionalString({}, "w", "Where")).toBeUndefined()
  })
})
