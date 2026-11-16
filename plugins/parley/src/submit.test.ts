import { describe, expect, test } from "bun:test"
import { isUndeliveredRound, isUnknownRound, type Outcome, type SubmitFlow, submitRound } from "./submit.ts"

function flow(overrides: Partial<SubmitFlow> = {}) {
  const log: string[] = []
  const base: SubmitFlow = {
    submit: async () => ({ ok: true }),
    deliver: async () => ({ ok: true }),
    choose: async () => true,
    dismiss: async () => void log.push("dismiss"),
    notify: (message) => void log.push(`notify:${message}`),
    settle: async () => void log.push("settle"),
  }
  return {
    log,
    flow: {
      ...base,
      ...overrides,
      submit: async () => {
        log.push("submit")
        return (overrides.submit ?? base.submit)()
      },
      deliver: async () => {
        log.push("deliver")
        return (overrides.deliver ?? base.deliver)()
      },
      choose: async () => {
        log.push("choose")
        return (overrides.choose ?? base.choose)()
      },
    } satisfies SubmitFlow,
  }
}

const unknown: Outcome = { ok: false, errors: ["unknown round rnd_0d73babd"] }

describe("submitRound", () => {
  test("a normal submit closes the card", async () => {
    const { flow: f, log } = flow()
    expect(await submitRound(f)).toEqual([])
    expect(log).toEqual(["submit", "notify:Answers sent", "settle"])
  })

  test("other errors come back for the card to show, with no choice offered", async () => {
    const { flow: f, log } = flow({ submit: async () => ({ ok: false, errors: ["unknown question x"] }) })
    expect(await submitRound(f)).toEqual(["unknown question x"])
    expect(log).toEqual(["submit"])
  })

  test("unknown round: shows the error once, offers the choice, sends the answers as a message and closes the card", async () => {
    const { flow: f, log } = flow({ submit: async () => unknown })
    expect(await submitRound(f)).toEqual([])
    expect(log).toEqual([
      "submit",
      "notify:This round is gone from the server (the plugin probably reloaded).",
      "choose",
      "deliver",
      "notify:Answers sent as a message",
      "settle",
    ])
  })

  test("unknown round: dismiss tells the server and closes the card without sending", async () => {
    const { flow: f, log } = flow({ submit: async () => unknown, choose: async () => false })
    expect(await submitRound(f)).toEqual([])
    expect(log).not.toContain("deliver")
    expect(log.slice(-2)).toEqual(["dismiss", "settle"])
  })

  test("undelivered round: shows the server's error once, then offers the same choice", async () => {
    const error = "undelivered round rnd_1: Could not send the answers to the session: host down"
    const { flow: f, log } = flow({ submit: async () => ({ ok: false, errors: [error] }) })
    expect(await submitRound(f)).toEqual([])
    expect(log).toEqual(["submit", `notify:${error}`, "choose", "deliver", "notify:Answers sent as a message", "settle"])
  })

  test("unknown round thrown by the transport is treated the same", async () => {
    const { flow: f, log } = flow({ submit: async () => { throw new Error("unknown round rnd_1") } })
    expect(await submitRound(f)).toEqual([])
    expect(log).toContain("deliver")
  })

  test("a failed send keeps the card open with the error", async () => {
    const { flow: f, log } = flow({ submit: async () => unknown, deliver: async () => ({ ok: false, errors: ["offline"] }) })
    expect(await submitRound(f)).toEqual(["offline"])
    expect(log).not.toContain("settle")
  })

  test("a submit that closed the round but could not message the session warns instead of failing", async () => {
    const { flow: f, log } = flow({ submit: async () => ({ ok: true, errors: ["Could not send the answers to the session: offline"] }) })
    expect(await submitRound(f)).toEqual([])
    expect(log[1]).toContain("Could not send")
  })
})

test("isUnknownRound and isUndeliveredRound match only their own errors", () => {
  expect(isUnknownRound(["unknown round rnd_1"])).toBe(true)
  expect(isUnknownRound(["round rnd_1 is submitted"])).toBe(false)
  expect(isUndeliveredRound(["undelivered round rnd_1: down"])).toBe(true)
  expect(isUndeliveredRound(["unknown round rnd_1"])).toBe(false)
})
