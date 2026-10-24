import { GitHubError, type Query } from "./github.js";

const now = Date.now();
const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

function repo(fullName: string, overrides: Record<string, unknown> = {}) {
  const [owner, name] = fullName.split("/");
  return {
    full_name: fullName,
    name,
    owner: { login: owner },
    description: `Mock repository ${fullName}`,
    html_url: `https://github.com/${fullName}`,
    homepage: null,
    stargazers_count: 1200,
    forks_count: 300,
    open_issues_count: 42,
    subscribers_count: 80,
    language: "Java",
    license: { spdx_id: "MIT", name: "MIT License" },
    topics: ["java", "spring-boot", "banking", "microservices"],
    archived: false,
    fork: false,
    created_at: daysAgo(900),
    pushed_at: daysAgo(2),
    default_branch: "main",
    ...overrides,
  };
}

const searchRepos = [
  repo("mock-org/bank-core", { stargazers_count: 5400 }),
  repo("mock-org/payments-service", {
    stargazers_count: 2100,
    topics: ["java", "spring-boot", "payments", "microservices"],
    pushed_at: daysAgo(40),
  }),
  repo("other/legacy-bank", { stargazers_count: 900, archived: true, pushed_at: daysAgo(800), topics: ["java", "banking"] }),
];

const issue = (n: number, title: string, isPr = false) => ({
  number: n,
  title,
  state: "open",
  html_url: `https://github.com/mock-org/bank-core/${isPr ? "pull" : "issues"}/${n}`,
  repository_url: "https://api.github.com/repos/mock-org/bank-core",
  comments: 3,
  created_at: daysAgo(10),
  updated_at: daysAgo(1),
  user: { login: "alice" },
  labels: [{ name: "good first issue" }],
  ...(isPr ? { pull_request: { merged_at: null } } : {}),
});

const pull = {
  number: 7,
  title: "Add transfer limits",
  state: "open",
  draft: false,
  html_url: "https://github.com/mock-org/bank-core/pull/7",
  user: { login: "bob" },
  created_at: daysAgo(5),
  updated_at: daysAgo(1),
  closed_at: null,
  merged_at: null,
  base: { ref: "main" },
  head: { ref: "feature/limits", label: "bob:feature/limits" },
  body: "Adds daily transfer limits per account.",
  additions: 120,
  deletions: 8,
  changed_files: 2,
  commits: 3,
  comments: 1,
  review_comments: 2,
  labels: [{ name: "enhancement" }],
  requested_reviewers: [{ login: "carol" }],
};

const tree = [
  { path: "README.md", type: "blob", size: 2048 },
  { path: "pom.xml", type: "blob", size: 4096 },
  { path: "src", type: "tree" },
  { path: "src/main", type: "tree" },
  { path: "src/main/java", type: "tree" },
  { path: "src/main/java/App.java", type: "blob", size: 900 },
  { path: "src-docs", type: "tree" },
  { path: "src-docs/guide.md", type: "blob", size: 300 },
];

const pom = `<project>
  <artifactId>bank-core</artifactId>
  <properties>
    <jackson.version>2.17.1</jackson.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>org.apache.logging.log4j</groupId>
      <artifactId>log4j-core</artifactId>
      <version>2.14.1</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13.2</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;

const log4shell = {
  ghsa_id: "GHSA-jfh8-c2jp-5v3q",
  cve_id: "CVE-2021-44228",
  html_url: "https://github.com/advisories/GHSA-jfh8-c2jp-5v3q",
  summary: "Remote code injection in Log4j",
  type: "reviewed",
  severity: "critical",
  published_at: "2021-12-10T00:40:56Z",
  withdrawn_at: null,
  vulnerabilities: [
    { package: { ecosystem: "maven", name: "org.apache.logging.log4j:log4j-core" }, vulnerable_version_range: ">= 2.13.0, < 2.15.0", first_patched_version: "2.15.0" },
  ],
  epss: { percentage: 0.944, percentile: 0.999 },
};

export const mockScorecard = {
  date: daysAgo(3),
  score: 6.2,
  checks: [
    { name: "Code-Review", score: 8, reason: "Found 24/30 approved changesets" },
    { name: "Maintained", score: 10, reason: "30 commit(s) and 12 issue activity found in the last 90 days" },
    { name: "Pinned-Dependencies", score: 3, reason: "dependency not pinned by hash detected" },
    { name: "Dangerous-Workflow", score: 10, reason: "no dangerous workflow patterns detected" },
    { name: "Signed-Releases", score: -1, reason: "no releases found" },
  ],
};

const committers = ["alice", "bob", "alice", "carol", "bob"];

type Route = [RegExp, (m: RegExpMatchArray, q: Query) => unknown];

const routes: Route[] = [
  [/^\/search\/repositories$/, () => ({ total_count: searchRepos.length, incomplete_results: false, items: searchRepos })],
  [
    /^\/search\/topics$/,
    () => ({
      total_count: 2,
      incomplete_results: false,
      items: [
        { name: "banking", display_name: "Banking", short_description: "Software for banks.", featured: false, curated: true },
        { name: "fintech", display_name: "FinTech", short_description: "Financial technology.", featured: true, curated: true },
      ],
    }),
  ],
  [/^\/search\/issues$/, () => ({ total_count: 1, incomplete_results: false, items: [issue(12, "NullPointerException on startup")] })],
  [
    /^\/search\/code$/,
    () => ({
      total_count: 1,
      incomplete_results: false,
      items: [
        {
          path: "src/main/java/App.java",
          html_url: "https://github.com/mock-org/bank-core/blob/main/src/main/java/App.java",
          repository: { full_name: "mock-org/bank-core" },
          text_matches: [{ fragment: "@SpringBootApplication\npublic class App {" }],
        },
      ],
    }),
  ],
  [/^\/repos\/[^/]+\/[^/]+\/languages$/, () => ({ Java: 90_000, Kotlin: 8_000, Dockerfile: 2_000 })],
  [
    /^\/repos\/[^/]+\/[^/]+\/releases\/latest$/,
    () => ({ tag_name: "v2.1.0", name: "v2.1.0", published_at: daysAgo(30), html_url: "https://github.com/mock-org/bank-core/releases/tag/v2.1.0", draft: false, prerelease: false }),
  ],
  [/^\/repos\/[^/]+\/[^/]+\/releases$/, () => [{ tag_name: "v2.1.0", published_at: daysAgo(30), draft: false, prerelease: false }]],
  [/^\/repos\/[^/]+\/[^/]+\/readme$/, () => ({ path: "README.md", content: b64("# Bank Core\n\nA mock banking service.\n") })],
  [/^\/repos\/[^/]+\/[^/]+\/git\/trees\/[^/]+$/, () => ({ truncated: false, tree })],
  [
    /^\/repos\/[^/]+\/[^/]+\/contents$/,
    () => [
      { name: ".github", type: "dir" },
      { name: "README.md", type: "file" },
      { name: "pom.xml", type: "file" },
      { name: "src", type: "dir" },
    ],
  ],
  [
    /^\/repos\/[^/]+\/[^/]+\/contents\/\.github$/,
    () => [
      { name: "dependabot.yml", type: "file" },
      { name: "SECURITY.md", type: "file" },
      { name: "workflows", type: "dir" },
    ],
  ],
  [
    /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/,
    (m) => {
      const path = decodeURIComponent(m[1]);
      if (path === "src") return [{ type: "dir", name: "main", path: "src/main", size: 0 }];
      return { type: "file", name: path.split("/").pop(), path, size: pom.length, encoding: "base64", content: b64(pom) };
    },
  ],
  [/^\/repos\/[^/]+\/[^/]+\/issues$/, () => [issue(12, "NullPointerException on startup"), issue(7, "Add transfer limits", true)]],
  [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/files$/, () => [
    { filename: "src/main/java/Limits.java", status: "added", additions: 100, deletions: 0 },
    { filename: "src/main/java/App.java", status: "modified", additions: 20, deletions: 8 },
  ]],
  [/^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/, () => pull],
  [/^\/repos\/[^/]+\/[^/]+\/pulls$/, () => [pull]],
  [
    /^\/repos\/[^/]+\/[^/]+\/community\/profile$/,
    () => ({ files: { license: {}, readme: {}, contributing: {}, code_of_conduct: null, issue_template: {}, pull_request_template: null } }),
  ],
  [
    /^\/repos\/[^/]+\/[^/]+\/contributors$/,
    () => [
      { login: "alice", contributions: 400, type: "User" },
      { login: "bob", contributions: 250, type: "User" },
      { login: "carol", contributions: 150, type: "User" },
      { login: "dependabot[bot]", contributions: 90, type: "Bot" },
    ],
  ],
  [
    /^\/repos\/[^/]+\/[^/]+\/commits$/,
    () =>
      Array.from({ length: 42 }, (_, i) => ({
        sha: `sha${i}`,
        author: { login: committers[i % committers.length], type: "User" },
        commit: { author: { name: committers[i % committers.length], date: daysAgo(i * 2) }, verification: { verified: i % 3 !== 0 } },
      })),
  ],
  [/^\/repos\/[^/]+\/[^/]+\/branches\/[^/]+$/, () => ({ name: "main", protected: true })],
  [/^\/repos\/[^/]+\/[^/]+\/rules\/branches\/[^/]+$/, () => []],
  [/^\/repos\/[^/]+\/[^/]+\/private-vulnerability-reporting$/, () => ({ enabled: true })],
  [
    /^\/repos\/[^/]+\/[^/]+\/security-advisories$/,
    () => [{ ghsa_id: "GHSA-mock-0001-aaaa", severity: "high", summary: "SQL injection in account search", published_at: daysAgo(120), withdrawn_at: null }],
  ],
  // GitHub matches advisories against the requested package@version list; this fixture only knows Log4Shell.
  [/^\/advisories$/, (_m, q) => (q.type !== "malware" && String(q.affects ?? "").includes("log4j-core@2.14") ? [log4shell] : [])],
  [/^\/repos\/([^/]+)\/([^/]+)$/, (m) => repo(`${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`)],
];

export function mockResponse(path: string, query: Query): { data: unknown; link: string | null } {
  if (/^\/repos\/missing\//.test(path)) {
    throw new GitHubError(`Not found: ${path}. Check the owner, repo, path or ref spelling.`, 404);
  }
  for (const [pattern, handler] of routes) {
    const match = path.match(pattern);
    if (match) return { data: handler(match, query), link: null };
  }
  throw new GitHubError(`Mock mode has no fixture for ${path}`, 404);
}
