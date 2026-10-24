import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SERVER = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const clients = [];

function baseEnv() {
  const env = { ...process.env };
  for (const key of ["GITHUB_TOKEN", "GITHUB_PAT", "MOCK", "GITHUB_API_URL"]) delete env[key];
  return env;
}

async function connect(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], env: { ...baseEnv(), ...env }, stderr: "ignore" });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function call(client, name, args) {
  const res = await client.callTool({ name, arguments: args });
  return { text: res.content.map((c) => c.text).join("\n"), isError: Boolean(res.isError) };
}

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
});

const EXPECTED_TOOLS = [
  "compare_repositories",
  "find_similar_repositories",
  "get_file_contents",
  "get_pull_request",
  "get_repo_health",
  "get_repo_tree",
  "get_repository",
  "list_issues",
  "list_pull_requests",
  "search_code",
  "search_issues_and_prs",
  "search_repositories",
  "search_topics",
  "security_advisories",
  "security_audit_dependencies",
  "security_supply_chain_risk",
];

test("exposes all 16 tools, all marked read-only", async () => {
  const client = await connect({ MOCK: "true" });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), EXPECTED_TOOLS);
  for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be read-only`);
});

test("every tool works in mock mode", async () => {
  const client = await connect({ MOCK: "true" });
  const repo = { owner: "mock-org", repo: "bank-core" };
  const cases = [
    ["search_repositories", { topics: ["java", "spring-boot"], min_stars: 100 }, ["Query: topic:java topic:spring-boot stars:>=100 archived:false", "mock-org/bank-core"]],
    ["search_topics", { query: "banking" }, ["- banking", "fintech", "[featured, curated]"]],
    ["search_issues_and_prs", { query: "NullPointerException", labels: ["good first issue"] }, ["is:issue", 'label:"good first issue"', "#12"]],
    ["search_code", { query: "SpringBootApplication", filename: "App.java" }, ["src/main/java/App.java", "@SpringBootApplication"]],
    ["get_repository", repo, ["# mock-org/bank-core", "Java 90.0%", "Latest release: v2.1.0", "## README"]],
    ["get_repo_tree", repo, ["mock-org/bank-core @ main", "pom.xml (4.0 KB)", "    java/"]],
    ["get_file_contents", { ...repo, path: "pom.xml" }, ["pom.xml", "<artifactId>bank-core</artifactId>"]],
    ["get_file_contents", { ...repo, path: "src" }, ["Folder src", "main/"]],
    ["list_issues", repo, ["#12 NullPointerException"]],
    ["list_pull_requests", repo, ["#7 Add transfer limits", "bob:feature/limits -> main"]],
    ["get_pull_request", { ...repo, number: 7 }, ["# PR #7: Add transfer limits", "A src/main/java/Limits.java (+100 -0)"]],
    ["get_repo_health", repo, ["# Health: mock-org/bank-core", "/100", "Contributors:"]],
    ["compare_repositories", { repos: ["mock-org/bank-core", "https://github.com/mock-org/payments-service"], include_health: true }, ["| Stars |", "Health score"]],
    ["find_similar_repositories", repo, ["Repositories similar to mock-org/bank-core", "mock-org/payments-service", "shared topics"]],
    [
      "security_advisories",
      { ecosystem: "maven", package: "org.apache.logging.log4j:log4j-core", version: "2.14.1" },
      ["1 advisory affects this version: 1 critical", "CVE-2021-44228", "Fixed in: 2.15.0", "EPSS 94.4%"],
    ],
    ["security_advisories", { ecosystem: "maven", package: "org.apache.logging.log4j:log4j-core", version: "2.17.1" }, ["No advisories affect this version"]],
    [
      "security_audit_dependencies",
      repo,
      ["Scanned: pom.xml (maven, 3 dependencies)", "1 vulnerable", "org.apache.logging.log4j:log4j-core 2.14.1", "Upgrade to 2.15.0", "junit:junit"],
    ],
    ["security_supply_chain_risk", repo, ["# Supply chain risk: mock-org/bank-core", "Bus factor 2", "Security policy: .github/SECURITY.md", "OpenSSF Scorecard: 6.2/10"]],
  ];
  for (const [name, args, expected] of cases) {
    const res = await call(client, name, args);
    assert.equal(res.isError, false, `${name} returned an error: ${res.text}`);
    for (const fragment of expected) assert.ok(res.text.includes(fragment), `${name} output missing "${fragment}":\n${res.text}`);
  }

  const issues = await call(client, "list_issues", repo);
  assert.ok(!issues.text.includes("#7"), "list_issues must exclude pull requests");
});

test("reports clear errors", async () => {
  const client = await connect({ MOCK: "true" });
  const missing = await call(client, "get_repository", { owner: "missing", repo: "nothing" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Not found/);

  const empty = await call(client, "search_repositories", {});
  assert.equal(empty.isError, true);
  assert.match(empty.text, /at least one/);

  const tooFar = await call(client, "search_repositories", { query: "x", offset: 1000 });
  assert.equal(tooFar.isError, true);
  assert.match(tooFar.text, /first 1,000 results/);
});

test("search_code explains that it needs a token when none is set", async () => {
  const client = await connect({ GITHUB_API_URL: "http://127.0.0.1:9" });
  const res = await call(client, "search_code", { query: "anything" });
  assert.equal(res.isError, true);
  assert.match(res.text, /needs a GitHub token/);
});

async function fakeGitHub() {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    const path = new URL(req.url, "http://x").pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/repos/acme/widget") {
      res.end(
        JSON.stringify({
          full_name: "acme/widget",
          description: "A widget",
          html_url: "https://github.com/acme/widget",
          homepage: null,
          stargazers_count: 5,
          forks_count: 1,
          open_issues_count: 0,
          language: "Go",
          license: null,
          topics: [],
          archived: false,
          fork: false,
          created_at: "2025-01-01T00:00:00Z",
          pushed_at: "2026-01-01T00:00:00Z",
          default_branch: "main",
        })
      );
    } else if (path.startsWith("/repos/acme/limited")) {
      res.statusCode = 403;
      res.setHeader("x-ratelimit-remaining", "0");
      res.setHeader("x-ratelimit-reset", String(Math.floor(Date.now() / 1000) + 600));
      res.end(JSON.stringify({ message: "API rate limit exceeded" }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ message: "Not Found" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, close: () => server.close() };
}

test("sends the token from GITHUB_TOKEN on every request", async () => {
  const gh = await fakeGitHub();
  try {
    const client = await connect({ GITHUB_API_URL: gh.url, GITHUB_TOKEN: "test-token-123" });
    const res = await call(client, "get_repository", { owner: "acme", repo: "widget" });
    assert.equal(res.isError, false, res.text);
    assert.ok(gh.requests.length >= 3, "expected several API requests");
    for (const r of gh.requests) assert.equal(r.authorization, "Bearer test-token-123", `missing token on ${r.url}`);
  } finally {
    gh.close();
  }
});

test("accepts GITHUB_PAT as an alternative name", async () => {
  const gh = await fakeGitHub();
  try {
    const client = await connect({ GITHUB_API_URL: gh.url, GITHUB_PAT: "pat-456" });
    await call(client, "get_repository", { owner: "acme", repo: "widget", include_readme: false });
    assert.ok(gh.requests.every((r) => r.authorization === "Bearer pat-456"));
  } finally {
    gh.close();
  }
});

test("explains rate limits and suggests a token when unauthenticated", async () => {
  const gh = await fakeGitHub();
  try {
    const client = await connect({ GITHUB_API_URL: gh.url });
    const res = await call(client, "get_repository", { owner: "acme", repo: "limited" });
    assert.equal(res.isError, true);
    assert.match(res.text, /rate limit exceeded; resets in about 10 min/);
    assert.match(res.text, /Set GITHUB_TOKEN/);
  } finally {
    gh.close();
  }
});

test("sends no Authorization header without a token", async () => {
  const gh = await fakeGitHub();
  try {
    const client = await connect({ GITHUB_API_URL: gh.url });
    const res = await call(client, "get_repository", { owner: "acme", repo: "widget" });
    assert.equal(res.isError, false, res.text);
    assert.ok(gh.requests.every((r) => r.authorization === undefined));
  } finally {
    gh.close();
  }
});
