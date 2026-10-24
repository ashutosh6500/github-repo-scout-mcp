// Live check against the real GitHub API through the MCP protocol.
// Uses roughly 40 core requests and 5 searches, so it fits once an hour in the unauthenticated limit of 60.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MAX_LINES = Number(process.env.SMOKE_MAX_LINES ?? 25);
const hasToken = Boolean(process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PAT?.trim());

const steps = [
  ["search_topics", { query: "banking", limit: 8 }],
  ["search_repositories", { topics: ["java", "spring-boot", "banking"], limit: 5 }],
  ["get_repository", { owner: "modelcontextprotocol", repo: "python-sdk", readme_max_chars: 600 }],
  ["get_repo_health", { owner: "modelcontextprotocol", repo: "python-sdk" }],
  ["compare_repositories", { repos: ["modelcontextprotocol/python-sdk", "modelcontextprotocol/typescript-sdk"] }],
  ["find_similar_repositories", { owner: "modelcontextprotocol", repo: "python-sdk", limit: 5 }],
  ["get_repo_tree", { owner: "modelcontextprotocol", repo: "python-sdk", max_depth: 1 }],
  ["get_file_contents", { owner: "modelcontextprotocol", repo: "python-sdk", path: "pyproject.toml", max_chars: 800 }],
  ["list_issues", { owner: "modelcontextprotocol", repo: "python-sdk", limit: 3 }],
  ["list_pull_requests", { owner: "modelcontextprotocol", repo: "python-sdk", limit: 3 }],
  ["get_pull_request", { owner: "modelcontextprotocol", repo: "python-sdk", number: 6, body_max_chars: 300 }],
  ["search_issues_and_prs", { query: "ClosedResourceError", repo: "modelcontextprotocol/python-sdk", limit: 3 }],
  ["security_advisories", { ecosystem: "npm", package: "lodash", version: "4.17.15", limit: 3 }],
  ["security_audit_dependencies", { owner: "modelcontextprotocol", repo: "python-sdk" }],
  ["security_supply_chain_risk", { owner: "modelcontextprotocol", repo: "python-sdk" }],
];
if (hasToken) steps.push(["search_code", { query: "FastMCP", repo: "modelcontextprotocol/python-sdk", limit: 3 }]);

const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: process.env, stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

let failures = 0;
for (const [name, args] of steps) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.map((c) => c.text).join("\n");
  const lines = text.split("\n");
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - started} ms)${res.isError ? " ERROR" : ""}`);
  console.log(lines.slice(0, MAX_LINES).join("\n"));
  if (lines.length > MAX_LINES) console.log(`... (${lines.length - MAX_LINES} more lines)`);
  if (res.isError) failures++;
}
if (!hasToken) console.log("\n(search_code skipped: no GITHUB_TOKEN set)");

await client.close();
console.log(`\n${steps.length - failures}/${steps.length} tools succeeded against live GitHub.`);
process.exit(failures ? 1 : 0);
