import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const RESOURCE_FIELD = {
  Read: "file_path",
  Edit: "file_path",
  Write: "file_path",
  NotebookEdit: "notebook_path",
  Grep: "path",
  Glob: "path",
  Bash: "command",
  WebFetch: "url",
  WebSearch: "query",
  Skill: "skill",
  Agent: "subagent_type"
};
const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`, "s");
const ask = (reason) => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: reason }
});
export function guardDecision(input, config) {
  const agent = input.agent_type;
  if (!agent || !input.tool_name)
    return;
  const id = Object.keys(config).find((key) => agent === key || agent.endsWith(`:${key}`));
  if (id === undefined)
    return;
  const field = RESOURCE_FIELD[input.tool_name];
  const target = field === undefined ? undefined : input.tool_input?.[field];
  if (typeof target !== "string")
    return;
  for (const guard of config[id] ?? []) {
    if (!guard.tools.includes(input.tool_name))
      continue;
    const match = guard.rules.findLast((rule) => glob(rule.resource).test(target));
    if (match?.effect === "ask")
      return ask(`${id} must ask before ${input.tool_name} on ${target} (matches ${match.resource})`);
  }
  return;
}
function main() {
  let output;
  try {
    const guards = process.env.CLAUDE_AGENT_GUARDS ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "agent-guards.json");
    output = guardDecision(JSON.parse(readFileSync(0, "utf8")), JSON.parse(readFileSync(guards, "utf8")));
  } catch (error) {
    output = ask(`agent guard failed (${error instanceof Error ? error.message : String(error)}); asking instead`);
  }
  if (output !== undefined)
    process.stdout.write(JSON.stringify(output));
}
main();
