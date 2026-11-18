export type PaceCommand = { kind: "status" } | { kind: "off" } | { kind: "bind"; customer: string } | { kind: "invalid"; reason: string }

const CUSTOMER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Parse the text after `/pace`. A customer never starts with `-`, so it cannot pass as a checker flag. */
export function parseCommand(text: string | undefined): PaceCommand {
  const words = (text ?? "").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return { kind: "status" }
  if (words.length > 1) return { kind: "invalid", reason: "Usage: /pace <customer> | /pace off | /pace" }
  const word = words[0] as string
  if (word === "off") return { kind: "off" }
  if (!CUSTOMER.test(word)) return { kind: "invalid", reason: `"${word}" is not a valid customer name.` }
  return { kind: "bind", customer: word }
}
