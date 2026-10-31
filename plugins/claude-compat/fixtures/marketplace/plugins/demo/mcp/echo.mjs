// Minimal stdio MCP server for the claude-compat fixture: one tool, `shout`.
import { createInterface } from "node:readline"

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const tool = {
  name: "shout",
  description: "Return the text upper-cased, prefixed with ECHO-FIXTURE.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}
createInterface({ input: process.stdin }).on("line", (line) => {
  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }
  if (request.id === undefined) return
  if (request.method === "initialize")
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo-fixture", version: "1.0.0" } } })
  else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools: [tool] } })
  else if (request.method === "tools/call")
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: `ECHO-FIXTURE ${String(request.params?.arguments?.text ?? "").toUpperCase()}` }] } })
  else if (request.method === "ping") send({ jsonrpc: "2.0", id: request.id, result: {} })
  else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } })
})
