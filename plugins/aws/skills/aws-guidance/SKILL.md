---
name: aws-guidance
description: Use for any AWS task (CLI, CDK, SAM, SDK, IaC, pricing, secrets); routes it through the AWS MCP servers and docs.
---

AWS work goes through two MCP servers: `aws-mcp` (the read-only AWS MCP Server) and `aws-pricing`. When either is not connected, say so and state which checks below stayed undone.

- Before an AWS task, and before the first AWS CLI, `cdk`, or `sam` command of one, search `aws-mcp` with `aws___search_documentation` and `topics: ["agent_skills"]`. Load a match with `aws___retrieve_skill`, passing `skill_name` exactly as returned, and follow it over general knowledge.
- Verify AWS API parameters, permissions, limits, error codes, and regional availability against `aws-mcp` documentation tools. State what stayed unconfirmed.
- Price estimates with `aws-pricing`, and state the region, usage assumptions, and price-list date.
- Project instructions win over this guidance, including the project's infrastructure-as-code tool.
- Load the `aws-secrets-manager` skill before any secret, credential, API key, token, or password task. Never call `secretsmanager get-secret-value` or `batch-get-secret-value`.
- Use hyphens, not em dashes, in AWS resource names and descriptions.
