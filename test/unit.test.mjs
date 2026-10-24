import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRepoQuery, normalizeTopic } from "../dist/tools/search.js";
import { renderTree, encodePath } from "../dist/tools/repo.js";
import { pickCoreTopics } from "../dist/tools/insights.js";
import { parseRepoRef } from "../dist/format.js";
import { buildUrl, hasPatchedTrustStore, repoPath } from "../dist/github.js";
import { compareVersions, inRange, queryNames, resolveMavenSpec, resolvePipSpec, resolveSemverRange } from "../dist/versions.js";
import { parseManifest } from "../dist/manifests.js";
import { hitFor, maintainerStats, releaseBurst } from "../dist/tools/security.js";

const depSummary = (file, text) => parseManifest(file, text).deps.map((d) => [d.name, d.version, d.dev]);

test("compareVersions orders releases, pre-releases and padded versions", () => {
  assert.ok(compareVersions("4.17.15", "4.17.21") < 0);
  assert.ok(compareVersions("4.10.0", "4.9.9") > 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("2.0-alpha1", "2.0") < 0);
  assert.ok(compareVersions("6.0a1", "6.0.8") < 0);
  assert.ok(compareVersions("2.0.0-beta9", "2.0.0-beta10") < 0);
  assert.equal(compareVersions("5.4.24.Final", "5.4.24"), 0);
});

test("inRange reads GitHub advisory ranges", () => {
  assert.equal(inRange("4.17.15", ">= 4.0.0, < 4.17.21"), true);
  assert.equal(inRange("4.17.21", ">= 4.0.0, < 4.17.21"), false);
  assert.equal(inRange("2.14.1", ">= 2.0-beta9, < 2.15.0"), true);
  assert.equal(inRange("1.5.0", "= 1.5.0"), true);
  assert.equal(inRange("1.4.0", "= 1.5.0"), false);
  assert.equal(inRange("9.9.9", null), true);
});

test("version constraints resolve to the lowest version they allow", () => {
  assert.deepEqual(resolveSemverRange("^4.17.0", "npm"), { version: "4.17.0", exact: false });
  assert.deepEqual(resolveSemverRange("4.17.15", "npm"), { version: "4.17.15", exact: true });
  assert.deepEqual(resolveSemverRange("~1.2", "npm"), { version: "1.2.0", exact: false });
  assert.deepEqual(resolveSemverRange("1.x || 2.x", "npm"), { version: "1.0.0", exact: false });
  assert.equal(resolveSemverRange("*", "npm").version, null);
  assert.equal(resolveSemverRange("<2.0.0", "npm").note, "no lower bound");
  assert.equal(resolveSemverRange("github:user/repo", "npm").note, "not from the registry");
  assert.deepEqual(resolveSemverRange("1.2.3", "rust"), { version: "1.2.3", exact: false });
  assert.deepEqual(resolveSemverRange("=1.2.3", "rust"), { version: "1.2.3", exact: true });
  assert.deepEqual(resolvePipSpec("==2.31.0"), { version: "2.31.0", exact: true });
  assert.deepEqual(resolvePipSpec(">=1.2,<2"), { version: "1.2", exact: false });
  assert.deepEqual(resolvePipSpec("==1.4.*"), { version: "1.4", exact: false });
  assert.equal(resolvePipSpec("<3").note, "no lower bound");
  assert.deepEqual(resolveMavenSpec("[1.0,2.0)"), { version: "1.0", exact: false });
  assert.deepEqual(resolveMavenSpec("[1.2.3]"), { version: "1.2.3", exact: true });
  assert.equal(resolveMavenSpec("").version, null);
});

test("pip packages are queried in every spelling GitHub may store", () => {
  assert.deepEqual(queryNames("pip", "Django"), ["Django", "django"]);
  assert.deepEqual(queryNames("pip", "typing_extensions"), ["typing_extensions", "typing-extensions"]);
  assert.deepEqual(queryNames("npm", "lodash"), ["lodash"]);
});

test("package.json and composer.json: aliases, non-registry sources, dev flags", () => {
  const pkg = JSON.stringify({
    dependencies: { lodash: "^4.17.15", foo: "npm:bar@1.2.3", local: "file:../local" },
    devDependencies: { lodash: "^4.17.21", mocha: "10.0.0" },
  });
  assert.deepEqual(depSummary("package.json", pkg), [
    ["lodash", "4.17.15", false],
    ["bar", "1.2.3", false],
    ["local", null, false],
    ["mocha", "10.0.0", true],
  ]);
  const composer = JSON.stringify({
    require: { php: ">=8.1", "ext-json": "*", "monolog/monolog": "^2.0", "symfony/console": "v6.4.1" },
    "require-dev": { "phpunit/phpunit": "^10.0@dev" },
  });
  assert.deepEqual(depSummary("composer.json", composer), [
    ["monolog/monolog", "2.0.0", false],
    ["symfony/console", "6.4.1", false],
    ["phpunit/phpunit", "10.0.0", true],
  ]);
});

test("requirements.txt and pyproject.toml: PEP 508, Poetry and options", () => {
  const requirements = [
    "requests==2.31.0",
    "Django>=3.2,<4  # web",
    "numpy",
    "-r dev.txt",
    "-e git+https://github.com/x/y#egg=y",
    'flask[async] >= 2.0 ; python_version >= "3.8"',
    "pkg @ https://example.com/pkg.whl",
  ].join("\n");
  assert.deepEqual(depSummary("requirements.txt", requirements), [
    ["requests", "2.31.0", false],
    ["Django", "3.2", false],
    ["numpy", null, false],
    ["flask", "2.0", false],
    ["pkg", null, false],
  ]);
  const pyproject = `
[project]
name = "demo"
dependencies = [
  "httpx>=0.27",
  "pydantic[email]>=2.7,<3",  # validation
]
[project.optional-dependencies]
dev = ["pytest==8.4.0"]

[tool.poetry.dependencies]
python = "^3.10"
requests = "^2.31"
rich = { version = "13.7.1", optional = true }
mylib = { git = "https://github.com/x/mylib" }

[tool.poetry.group.dev.dependencies]
black = "24.1.0"
`;
  assert.deepEqual(depSummary("pyproject.toml", pyproject), [
    ["httpx", "0.27", false],
    ["pydantic", "2.7", false],
    ["pytest", "8.4.0", true],
    ["requests", "2.31.0", false],
    ["rich", "13.7.1", false],
    ["mylib", null, false],
    ["black", "24.1.0", true],
  ]);
});

test("go.mod and Cargo.toml: require blocks, workspace, renamed and table dependencies", () => {
  const gomod = `module example.com/m
go 1.22
require github.com/spf13/pflag v1.0.5
require (
	golang.org/x/net v0.17.0
	golang.org/x/text v0.14.0 // indirect
)
replace golang.org/x/net => golang.org/x/net v0.20.0
`;
  assert.deepEqual(depSummary("go.mod", gomod), [
    ["github.com/spf13/pflag", "v1.0.5", false],
    ["golang.org/x/net", "v0.17.0", false],
    ["golang.org/x/text", "v0.14.0", false],
  ]);
  const cargo = `
[package]
name = "demo"
version = "0.1.0"

[dependencies]
serde = { version = "1.0.100", features = ["derive"] }
regex = "1.5"
local = { path = "../local" }
shared = { workspace = true }
renamed = { package = "real-crate", version = "=2.0.1" }

[dev-dependencies]
tempfile = "3"

[target.'cfg(windows)'.dependencies]
winapi = "0.3.9"

[dependencies.tokio]
version = "1.28"
features = ["full"]
`;
  const deps = parseManifest("Cargo.toml", cargo).deps;
  assert.deepEqual(
    deps.map((d) => [d.name, d.version, d.dev]),
    [
      ["serde", "1.0.100", false],
      ["regex", "1.5.0", false],
      ["local", null, false],
      ["shared", null, false],
      ["real-crate", "2.0.1", false],
      ["tempfile", "3.0.0", true],
      ["winapi", "0.3.9", false],
      ["tokio", "1.28.0", false],
    ]
  );
  assert.equal(deps.find((d) => d.name === "shared").note, "version set in the workspace");
  assert.equal(deps.find((d) => d.name === "real-crate").exact, true);
});

test("pom.xml: properties, managed versions, test scope, BOMs and plugins", () => {
  const pom = `<project>
  <version>1.0.0</version>
  <properties><log4j.version>2.14.1</log4j.version></properties>
  <dependencyManagement><dependencies>
    <dependency><groupId>com.example</groupId><artifactId>bom</artifactId><version>1</version><type>pom</type><scope>import</scope></dependency>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId><version>2.0.9</version></dependency>
  </dependencies></dependencyManagement>
  <dependencies>
    <!-- <dependency><groupId>commented</groupId><artifactId>out</artifactId><version>1</version></dependency> -->
    <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>\${log4j.version}</version></dependency>
    <dependency><groupId>org.slf4j</groupId><artifactId>slf4j-api</artifactId></dependency>
    <dependency><groupId>com.example</groupId><artifactId>sibling</artifactId><version>\${project.version}</version></dependency>
    <dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency>
  </dependencies>
  <build><plugins><plugin><artifactId>maven-shade-plugin</artifactId><dependencies>
    <dependency><groupId>org.ow2.asm</groupId><artifactId>asm</artifactId><version>9.0</version></dependency>
  </dependencies></plugin></plugins></build>
</project>`;
  assert.deepEqual(depSummary("pom.xml", pom), [
    ["org.slf4j:slf4j-api", "2.0.9", false],
    ["org.apache.logging.log4j:log4j-core", "2.14.1", false],
    ["com.example:sibling", "1.0.0", false],
    ["junit:junit", "4.13.2", true],
  ]);
});

test("hitFor picks the advisory entry for the installed version line", () => {
  const advisory = {
    ghsa_id: "GHSA-test",
    vulnerabilities: [
      { package: { ecosystem: "npm", name: "express" }, vulnerable_version_range: "< 4.22.0", first_patched_version: "4.22.0" },
      { package: { ecosystem: "npm", name: "express" }, vulnerable_version_range: ">= 5.0.0, < 5.2.0", first_patched_version: "5.2.0" },
      { package: { ecosystem: "npm", name: "other" }, vulnerable_version_range: null, first_patched_version: null },
    ],
  };
  assert.equal(hitFor(advisory, "npm", "express", "5.1.0").fixed, "5.2.0");
  assert.equal(hitFor(advisory, "npm", "express", "4.17.1").fixed, "4.22.0");
  assert.equal(hitFor(advisory, "npm", "express", "5.2.0"), null);
  assert.equal(hitFor(advisory, "npm", "express", null).range, "< 4.22.0 or >= 5.0.0, < 5.2.0");
  assert.deepEqual(hitFor(advisory, "npm", "other", "1.0.0").ranges, [null]);
});

test("maintainerStats finds the bus factor and a newcomer taking over", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  const commit = (login, daysAgo) => ({
    author: { login, type: "User" },
    commit: { author: { date: new Date(now - daysAgo * 86_400_000).toISOString() }, verification: { verified: login !== "veteran" } },
  });
  const commits = [
    ...Array.from({ length: 12 }, (_, i) => commit("newcomer", i)),
    ...Array.from({ length: 6 }, (_, i) => commit("veteran", 20 + i)),
    ...Array.from({ length: 30 }, (_, i) => commit("veteran", 120 + i)),
    commit("dependabot[bot]", 1),
  ];
  const stats = maintainerStats(commits, new Map([["veteran", 900], ["newcomer", 12]]), now);
  assert.equal(stats.humans, 48);
  assert.equal(stats.busFactor, 1);
  assert.deepEqual(stats.newcomers.map((n) => n.who), ["newcomer"]);
  assert.equal(stats.verified, 13);
});

test("releaseBurst spots several releases after a long silence", () => {
  const now = Date.parse("2026-10-24T00:00:00Z");
  const ago = (d) => new Date(now - d * 86_400_000).toISOString();
  assert.deepEqual(releaseBurst([ago(5), ago(20), ago(600), ago(700)], now), { gapDays: 580, count: 2 });
  assert.equal(releaseBurst([ago(5), ago(20), ago(80), ago(200)], now), null);
  assert.equal(releaseBurst([ago(5), ago(600)], now), null);
});

test("buildUrl refuses dot segments that would escape /repos/ to other endpoints", () => {
  assert.throws(() => buildUrl(repoPath("..", "user"), {}), /not allowed/);
  assert.throws(() => buildUrl(`${repoPath("x", "y")}/contents/${encodePath("../../../../user/repos")}`, {}), /not allowed/);
  assert.throws(() => buildUrl(`${repoPath("x", "y")}/git/trees/${encodeURIComponent("..")}`, {}), /not allowed/);
  assert.equal(buildUrl(`${repoPath("o", "r")}/contents/${encodePath(".github/..x/a..b")}`, { ref: "v1" }), "https://api.github.com/repos/o/r/contents/.github/..x/a..b?ref=v1");
});

test("hasPatchedTrustStore accepts only Node builds with the eMudhra distrust", () => {
  for (const v of ["22.23.4", "22.24.0", "24.22.1", "v24.23.0", "26.12.1", "26.13.0", "27.0.0"]) {
    assert.equal(hasPatchedTrustStore(v), true, v);
  }
  for (const v of ["18.20.8", "20.20.2", "22.23.3", "22.22.9", "23.11.1", "24.22.0", "25.9.0", "26.12.0"]) {
    assert.equal(hasPatchedTrustStore(v), false, v);
  }
});

test("buildRepoQuery combines topics and filters, excluding archived by default", () => {
  const q = buildRepoQuery({
    topics: ["Java", "Spring Boot", "banking"],
    language: "Java",
    min_stars: 100,
    pushed_after: "2026-01-01",
    license: "Apache-2.0",
  });
  assert.equal(q, "topic:java topic:spring-boot topic:banking language:Java stars:>=100 pushed:>=2026-01-01 license:apache-2.0 archived:false");
});

test("buildRepoQuery quotes multi-word languages and can include archived repos", () => {
  assert.equal(buildRepoQuery({ language: "Jupyter Notebook", include_archived: true }), 'language:"Jupyter Notebook"');
});

test("buildRepoQuery requires at least one criterion", () => {
  assert.throws(() => buildRepoQuery({}), /at least one/);
  assert.throws(() => buildRepoQuery({ query: "   " }), /at least one/);
});

test("normalizeTopic lowercases and hyphenates", () => {
  assert.equal(normalizeTopic("  Machine Learning "), "machine-learning");
});

test("renderTree keeps folder contents under their folder and respects depth", () => {
  const entries = [
    { path: "src-docs", type: "tree" },
    { path: "src/main/App.java", type: "blob", size: 900 },
    { path: "src", type: "tree" },
    { path: "src/main", type: "tree" },
    { path: "README.md", type: "blob", size: 2048 },
  ];
  const full = renderTree(entries, "", 5, 100);
  assert.equal(full.text, ["README.md (2.0 KB)", "src/", "  main/", "    App.java (900 B)", "src-docs/"].join("\n"));

  const shallow = renderTree(entries, "", 1, 100);
  assert.equal(shallow.shown, 3);
  assert.equal(shallow.hidden, 2);

  const sub = renderTree(entries, "src", 5, 100);
  assert.equal(sub.text, ["main/", "  App.java (900 B)"].join("\n"));
});

test("encodePath encodes segments but keeps slashes", () => {
  assert.equal(encodePath("/docs/my file#1.md"), "docs/my%20file%231.md");
});

test("pickCoreTopics drops generic topics and the language", () => {
  const repo = { language: "Java", topics: ["java", "hacktoberfest", "spring-boot", "banking", "awesome", "kafka", "redis"] };
  assert.deepEqual(pickCoreTopics(repo), ["spring-boot", "banking", "kafka"]);
});

test("parseRepoRef accepts owner/repo and GitHub URLs", () => {
  assert.deepEqual(parseRepoRef("spring-projects/spring-boot"), { owner: "spring-projects", repo: "spring-boot" });
  assert.deepEqual(parseRepoRef("https://github.com/facebook/react.git"), { owner: "facebook", repo: "react" });
  assert.throws(() => parseRepoRef("react"), /not a repository reference/);
});
