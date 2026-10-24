import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gh, ghOptional, GitHubError, isMock, repoPath, request, usesPublicGitHub, type Query } from "../github.js";
import { ago, day, daysSince, num, oneLine, ownerRepoShape, run, type Repo } from "../format.js";
import { MANIFESTS, parseManifest, type Dependency, type Manifest } from "../manifests.js";
import { mockScorecard } from "../mock.js";
import { compareVersions, ECOSYSTEMS, inRange, packageKey, queryNames, type Ecosystem } from "../versions.js";
import { encodePath } from "./repo.js";

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;
const DAY_MS = 86_400_000;

interface AdvisoryPackage {
  package: { ecosystem: string; name: string } | null;
  vulnerable_version_range: string | null;
  first_patched_version: string | { identifier: string } | null;
}

export interface Advisory {
  ghsa_id: string;
  cve_id: string | null;
  html_url: string;
  summary: string;
  type: string;
  severity: string | null;
  published_at: string | null;
  withdrawn_at: string | null;
  vulnerabilities: AdvisoryPackage[];
  epss?: { percentage: number; percentile: number } | null;
}

/** An advisory as it applies to one package. */
export interface Hit {
  advisory: Advisory;
  /** For display, e.g. ">= 4.0.0, < 4.17.21 or >= 5.0.0, < 5.0.2". */
  range: string;
  /** The raw ranges behind it; null means all versions. */
  ranges: Array<string | null>;
  fixed: string | null;
}

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, moderate: 2, low: 1 };
const severityRank = (s: string | null | undefined) => SEVERITY_RANK[s?.toLowerCase() ?? ""] ?? 0;

function fixedVersion(v: AdvisoryPackage): string | null {
  const f = v.first_patched_version;
  return typeof f === "string" ? f : (f?.identifier ?? null);
}

/** How an advisory applies to a package: the entry covering this version, or every entry when no version is given. */
export function hitFor(advisory: Advisory, ecosystem: Ecosystem, name: string, version: string | null): Hit | null {
  const key = packageKey(ecosystem, name);
  const entries = advisory.vulnerabilities.filter((v) => v.package && packageKey(ecosystem, v.package.name) === key);
  if (!entries.length) return null;
  const chosen = version ? entries.filter((v) => inRange(version, v.vulnerable_version_range)).slice(0, 1) : entries;
  if (!chosen.length) return null;
  const fixes = chosen.map(fixedVersion).filter(Boolean);
  return {
    advisory,
    range: chosen.map((v) => v.vulnerable_version_range ?? "all versions").join(" or "),
    ranges: chosen.map((v) => v.vulnerable_version_range),
    fixed: fixes.length ? fixes.join(" / ") : null,
  };
}

function nextCursor(link: string | null): string | undefined {
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  const url = next?.match(/<([^>]+)>/)?.[1];
  return url ? (new URL(url).searchParams.get("after") ?? undefined) : undefined;
}

/** The global advisories endpoint pages with a cursor ("after") instead of page numbers. */
async function fetchAdvisories(query: Query, maxPages: number): Promise<{ items: Advisory[]; complete: boolean }> {
  const items: Advisory[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res = await request("/advisories", { ...query, per_page: 100, after });
    items.push(...(res.data as Advisory[]).filter((a) => !a.withdrawn_at));
    after = nextCursor(res.link);
    if (!after) return { items, complete: true };
  }
  return { items, complete: false };
}

/** Joins package specs into comma-separated batches, each short enough for one request URL. */
function batches(specs: string[], maxChars = 3000): string[] {
  const out: string[] = [];
  let current = "";
  for (const s of specs) {
    if (current && current.length + s.length + 1 > maxChars) {
      out.push(current);
      current = "";
    }
    current = current ? `${current},${s}` : s;
  }
  if (current) out.push(current);
  return out;
}

function uniqueAdvisories(list: Advisory[]): Advisory[] {
  return [...new Map(list.map((a) => [a.ghsa_id, a])).values()];
}

function bySeverity(a: Hit, b: Hit): number {
  return severityRank(b.advisory.severity) - severityRank(a.advisory.severity) || (b.advisory.published_at ?? "").localeCompare(a.advisory.published_at ?? "");
}

function severityCounts(hits: Hit[]): string {
  const counts = new Map<string, number>();
  for (const h of hits) {
    const s = (h.advisory.severity ?? "unknown").toLowerCase();
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return ["critical", "high", "medium", "moderate", "low", "unknown"]
    .filter((s) => counts.has(s))
    .map((s) => `${counts.get(s)} ${s}`)
    .join(", ");
}

function upgradeAdvice(hits: Hit[]): string {
  const fixes = hits.map((h) => h.fixed).filter((f): f is string => Boolean(f));
  const unfixed = hits.length - fixes.length;
  const noFix = unfixed ? `${unfixed} ${unfixed === 1 ? "has" : "have"} no fix yet.` : "";
  if (!fixes.length) return noFix;
  const target = fixes.reduce((max, f) => (compareVersions(f, max) > 0 ? f : max));
  return `Upgrade to ${target} or later to fix ${unfixed ? `the ${fixes.length} with a fix` : hits.length === 1 ? "it" : "all of them"}. ${noFix}`.trim();
}

function epssText(a: Advisory): string {
  return a.epss?.percentage ? ` · EPSS ${(a.epss.percentage * 100).toFixed(1)}%` : "";
}

function advisoryLines(hit: Hit, index: number): string[] {
  const a = hit.advisory;
  return [
    `${index}. ${(a.severity ?? "unknown").toUpperCase()} · ${[a.ghsa_id, a.cve_id].filter(Boolean).join(" · ")} · published ${day(a.published_at)}`,
    `   ${oneLine(a.summary, 200)}`,
    `   Vulnerable: ${hit.range} · Fixed in: ${hit.fixed ?? "no fix yet"}${epssText(a)}`,
    `   ${a.html_url}`,
  ];
}

const EPSS_NOTE = "EPSS is the estimated chance that a vulnerability is exploited in the wild in the next 30 days.";

/** Malware advisories list the malicious versions; a range of all versions means the whole package is malicious. */
function malwareVerdict(hit: Hit, version: string | null, exact: boolean): string {
  if (!version) return `Malicious versions: ${hit.range}.`;
  if (hit.ranges.some((r) => inRange(version, r))) {
    return `Malicious versions: ${hit.range}. ${exact ? `Version ${version} is one of them: remove it now.` : `The range allows ${version}, which is malicious.`}`;
  }
  return `Malicious versions: ${hit.range}. ${exact ? `Version ${version} is not one of them, but check how this package was chosen.` : "Check that your lockfile does not install one of them."}`;
}

const ecosystemShape = z
  .enum(ECOSYSTEMS)
  .describe("Package ecosystem: npm, pip (Python), maven (Java), go, rust (crates.io), composer (PHP), rubygems, nuget, pub, erlang, swift or actions");

async function fetchText(base: string, path: string, ref?: string): Promise<string> {
  const p = `${base}/contents/${encodePath(path)}`;
  const data = await gh<{ content?: string; encoding?: string }>(p, { ref });
  if (data.content && data.encoding === "base64") return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf8");
  return gh<string>(p, { ref }, { accept: "application/vnd.github.raw+json" });
}

type AuditDep = Dependency & { ecosystem: Ecosystem; file: string };

interface Audit {
  manifests: Manifest[];
  problems: string[];
  deps: AuditDep[];
  skippedDev: number;
  hits: Map<AuditDep, Hit[]>;
  malware: Map<AuditDep, Hit[]>;
  complete: boolean;
}

async function auditDependencies(base: string, files: string[], ref: string | undefined, includeDev: boolean): Promise<Audit> {
  const manifests: Manifest[] = [];
  const problems: string[] = [];
  await Promise.all(
    files.map(async (file) => {
      try {
        manifests.push(parseManifest(file, await fetchText(base, file, ref)));
      } catch (err) {
        if (err instanceof GitHubError && err.rateLimited) throw err;
        problems.push(`${file}: ${(err as Error).message}`);
      }
    })
  );
  manifests.sort((a, b) => files.indexOf(a.file) - files.indexOf(b.file));

  const all = manifests.flatMap((m) => m.deps.map((d) => ({ ...d, ecosystem: m.ecosystem, file: m.file })));
  const deps = includeDev ? all : all.filter((d) => !d.dev);
  const hits = new Map<AuditDep, Hit[]>();
  const malware = new Map<AuditDep, Hit[]>();
  const add = (map: Map<AuditDep, Hit[]>, dep: AuditDep, hit: Hit) => map.set(dep, [...(map.get(dep) ?? []), hit]);
  let complete = true;

  for (const ecosystem of new Set(deps.map((d) => d.ecosystem))) {
    const group = deps.filter((d) => d.ecosystem === ecosystem);
    const versioned = group.filter((d) => d.version);
    const specs = [...new Set(versioned.flatMap((d) => queryNames(ecosystem, d.name).map((n) => `${n}@${d.version}`)))];
    const names = [...new Set(group.flatMap((d) => queryNames(ecosystem, d.name)))];
    const [reviewed, bad] = await Promise.all([
      Promise.all(batches(specs).map((affects) => fetchAdvisories({ ecosystem, affects }, 3))),
      Promise.all(batches(names).map((affects) => fetchAdvisories({ ecosystem, affects, type: "malware" }, 2))),
    ]);
    complete &&= [...reviewed, ...bad].every((r) => r.complete);

    for (const advisory of uniqueAdvisories(reviewed.flatMap((r) => r.items))) {
      let matched = false;
      for (const d of versioned) {
        const hit = hitFor(advisory, ecosystem, d.name, d.version);
        if (hit) {
          add(hits, d, hit);
          matched = true;
        }
      }
      // GitHub matched this advisory to one of the queried versions. When only one queried package is named
      // in it, it must be that one, even if its range uses a version format the comparator does not handle.
      if (!matched) {
        const named = versioned.filter((d) => hitFor(advisory, ecosystem, d.name, null));
        if (named.length === 1) add(hits, named[0], hitFor(advisory, ecosystem, named[0].name, null)!);
      }
    }
    for (const advisory of uniqueAdvisories(bad.flatMap((r) => r.items))) {
      for (const d of group) {
        const hit = hitFor(advisory, ecosystem, d.name, null);
        if (hit) add(malware, d, hit);
      }
    }
  }
  return { manifests, problems, deps, skippedDev: all.length - deps.length, hits, malware, complete };
}

function formatAudit(owner: string, repo: string, audit: Audit): string {
  const { manifests, deps, hits, malware } = audit;
  const checked = deps.filter((d) => d.version);
  const unchecked = deps.filter((d) => !d.version);
  const vulnerable = [...hits.entries()].map(([dep, list]) => ({ dep, list: list.sort(bySeverity) }));
  vulnerable.sort((a, b) => severityRank(b.list[0].advisory.severity) - severityRank(a.list[0].advisory.severity) || b.list.length - a.list.length);
  const clean = checked.filter((d) => !hits.has(d) && !malware.has(d));

  const lines = [`# Dependency audit: ${owner}/${repo}`, ""];
  lines.push(`Scanned: ${manifests.map((m) => `${m.file} (${m.ecosystem}, ${m.deps.length} dependencies)`).join(", ") || "nothing"}`);
  for (const p of audit.problems) lines.push(`Could not read ${p}`);
  lines.push(
    `Result: ${vulnerable.length} vulnerable, ${malware.size} with malware alerts, ${clean.length} clean, ${unchecked.length} not checked` +
      (audit.skippedDev ? ` (${audit.skippedDev} dev dependencies skipped; set include_dev to check them)` : "") +
      "."
  );
  if (deps.some((d) => d.version && !d.exact)) {
    lines.push(
      "",
      "How versions were checked: exact pins as written. For ranges (like ^1.2.0 or >=1.2) the lowest version the range allows, so a hit means the range permits a vulnerable version. A lockfile may already install a fixed one."
    );
  }

  lines.push("", "## Malware");
  if (malware.size === 0) lines.push("No dependency is listed as malware in the GitHub Advisory Database.");
  for (const [dep, list] of malware) {
    for (const hit of list) {
      lines.push(`- ${dep.name} (${dep.ecosystem}, ${dep.file}): ${oneLine(hit.advisory.summary, 160)} ${hit.advisory.html_url}`);
      lines.push(`  ${malwareVerdict(hit, dep.version, dep.exact)}`);
    }
  }

  lines.push("", `## Vulnerable (${vulnerable.length})`);
  if (!vulnerable.length) lines.push("No known vulnerabilities in the checked versions.");
  vulnerable.forEach(({ dep, list }, i) => {
    const checkedAs = dep.exact ? dep.version : `${dep.spec} -> checked ${dep.version}`;
    lines.push(`${i + 1}. ${dep.name} ${checkedAs} · ${dep.ecosystem} · ${dep.file}${dep.dev ? " · dev" : ""}`);
    lines.push(`   ${list.length} ${list.length === 1 ? "advisory" : "advisories"}: ${severityCounts(list)}. ${upgradeAdvice(list)}`);
    for (const h of list.slice(0, 5)) {
      lines.push(`   - ${(h.advisory.severity ?? "unknown").toUpperCase()} ${h.advisory.ghsa_id}${h.advisory.cve_id ? ` (${h.advisory.cve_id})` : ""}: ${oneLine(h.advisory.summary, 140)} (fixed in ${h.fixed ?? "no fix yet"})`);
    }
    if (list.length > 5) lines.push(`   - ${list.length - 5} more: call security_advisories with ecosystem ${dep.ecosystem}, package ${dep.name}, version ${dep.version}.`);
  });

  if (unchecked.length) {
    lines.push("", `## Not checked (${unchecked.length})`);
    for (const d of unchecked.slice(0, 25)) lines.push(`- ${d.name} (${d.spec || "no version"}): ${d.note ?? "no version to check"}`);
    if (unchecked.length > 25) lines.push(`- ${unchecked.length - 25} more`);
  }
  if (clean.length) {
    const names = clean.map((d) => d.name);
    lines.push("", `## Clean (${clean.length})`, names.slice(0, 60).join(", ") + (names.length > 60 ? `, and ${names.length - 60} more` : ""));
  }
  if (!audit.complete) lines.push("", "Note: some advisory lists were longer than this tool fetches, so results may be incomplete.");
  lines.push(
    "",
    "Only direct dependencies declared in the manifest were checked, not the packages they pull in. Source: GitHub Advisory Database. For how the project itself is run, call security_supply_chain_risk."
  );
  return lines.join("\n");
}

interface CommitInfo {
  author: { login: string; type?: string } | null;
  commit: { author: { name?: string; date?: string } | null; verification?: { verified: boolean } | null };
}

interface Contributor {
  login?: string;
  contributions: number;
}

interface ReleaseInfo {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets?: Array<{ name: string }>;
}

interface RepoAdvisory {
  ghsa_id: string;
  severity: string | null;
  summary: string;
  published_at: string | null;
  withdrawn_at: string | null;
}

interface Scorecard {
  date: string;
  score: number;
  checks: Array<{ name: string; score: number; reason: string }>;
}

const isBot = (c: CommitInfo) => c.author?.type === "Bot" || /\[bot\]$/i.test(c.author?.login ?? c.commit.author?.name ?? "");
const authorOf = (c: CommitInfo) => c.author?.login ?? c.commit.author?.name ?? "unknown";

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

export function maintainerStats(commits: CommitInfo[], allTime: Map<string, number>, now = Date.now()) {
  const humans = commits.filter((c) => !isBot(c));
  const ranked = [...countBy(humans.map(authorOf)).entries()].sort((a, b) => b[1] - a[1]);
  // Bus factor: the fewest people who together made at least half of the commits.
  let covered = 0;
  let busFactor = 0;
  for (const [, n] of ranked) {
    if (covered * 2 >= humans.length) break;
    covered += n;
    busFactor++;
  }
  // A newcomer is someone with a large share of the last 90 days whose all-time commits are almost all recent.
  const recent = humans.filter((c) => now - Date.parse(c.commit.author?.date ?? "") <= 90 * DAY_MS);
  const newcomers = [...countBy(recent.map(authorOf)).entries()]
    .filter(([who, n]) => n >= 5 && n / recent.length >= 0.25 && (allTime.get(who) ?? Infinity) <= n + 5)
    .map(([who, n]) => ({ who, share: n / recent.length }));
  const sample = commits.slice(0, 100);
  return { humans: humans.length, ranked, busFactor, newcomers, verified: sample.filter((c) => c.commit.verification?.verified).length, sampled: sample.length };
}

/** Several releases in the last 60 days after a year or more without one: the pattern of the event-stream takeover. */
export function releaseBurst(dates: string[], now = Date.now()): { gapDays: number; count: number } | null {
  const times = dates
    .map((d) => Date.parse(d))
    .filter(Number.isFinite)
    .sort((a, b) => b - a);
  const recent = times.filter((t) => now - t <= 60 * DAY_MS);
  if (recent.length < 2 || times.length <= recent.length) return null;
  const gapDays = Math.round((recent[recent.length - 1] - times[recent.length]) / DAY_MS);
  return gapDays >= 365 ? { gapDays, count: recent.length } : null;
}

async function fetchScorecard(owner: string, repo: string): Promise<Scorecard | null> {
  if (isMock) return mockScorecard;
  if (!usesPublicGitHub) return null;
  try {
    // A third-party service: it receives only the public repository name, never the GitHub token.
    const url = `https://api.securityscorecards.dev/projects/github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    return res.ok ? ((await res.json()) as Scorecard) : null;
  } catch {
    return null;
  }
}

async function commitsSince(base: string, since: string, pages: number): Promise<CommitInfo[]> {
  const all: CommitInfo[] = [];
  for (let page = 1; page <= pages; page++) {
    const res = await ghOptional<CommitInfo[]>(`${base}/commits`, { since, per_page: 100, page });
    if (!res) break;
    all.push(...res.data);
    if (res.data.length < 100) break;
  }
  return all;
}

const SECURITY_FILE = /^security(\.(md|markdown|rst|txt|adoc))?$/i;
const RENOVATE_FILE = /^(renovate\.json5?|\.renovaterc(\.json5?)?)$/i;
const SIGNATURE_ASSET = /\.(sig|asc|sigstore|sigstore\.json|intoto\.jsonl|pem|cert)$/i;

type Level = "high" | "medium" | "low";

async function supplyChainRisk(owner: string, name: string): Promise<string> {
  const base = repoPath(owner, name);
  const repo = await gh<Repo>(base);
  const branch = repo.default_branch;
  const since = new Date(Date.now() - 365 * DAY_MS).toISOString();
  type Entry = { name: string; type: string };
  const [commits, contributors, branchInfo, rules, root, dotGithub, reporting, advisories, releases, scorecard] = await Promise.all([
    commitsSince(base, since, 2),
    ghOptional<Contributor[]>(`${base}/contributors`, { per_page: 100 }),
    ghOptional<{ protected: boolean }>(`${base}/branches/${encodeURIComponent(branch)}`),
    ghOptional<Array<{ type: string }>>(`${base}/rules/branches/${encodeURIComponent(branch)}`),
    ghOptional<Entry[]>(`${base}/contents`),
    ghOptional<Entry[]>(`${base}/contents/.github`),
    ghOptional<{ enabled: boolean }>(`${base}/private-vulnerability-reporting`),
    ghOptional<RepoAdvisory[]>(`${base}/security-advisories`, { state: "published", per_page: 100 }),
    ghOptional<ReleaseInfo[]>(`${base}/releases`, { per_page: 30 }),
    repo.private ? Promise.resolve(null) : fetchScorecard(owner, name),
  ]);

  const rootNames = Array.isArray(root?.data) ? root.data.map((e) => e.name) : [];
  const githubNames = Array.isArray(dotGithub?.data) ? dotGithub.data.map((e) => e.name) : [];
  let policy: string | null = rootNames.find((n) => SECURITY_FILE.test(n)) ?? null;
  if (!policy && githubNames.some((n) => SECURITY_FILE.test(n))) policy = `.github/${githubNames.find((n) => SECURITY_FILE.test(n))}`;
  if (!policy && rootNames.includes("docs") && (await ghOptional(`${base}/contents/docs/SECURITY.md`))) policy = "docs/SECURITY.md";
  // GitHub applies an organization's default policy from its .github repository.
  if (!policy && (await ghOptional(`${repoPath(owner, ".github")}/contents/SECURITY.md`))) policy = `inherited from ${owner}/.github`;
  const updater = githubNames.some((n) => /^dependabot\.ya?ml$/i.test(n))
    ? "Dependabot"
    : [...rootNames, ...githubNames].some((n) => RENOVATE_FILE.test(n))
      ? "Renovate"
      : null;

  const allTime = new Map((contributors?.data ?? []).filter((c) => c.login).map((c) => [c.login!, c.contributions]));
  const stats = maintainerStats(commits, allTime);
  const oldest = commits.at(-1)?.commit.author?.date;
  const windowText = commits.length >= 200 && oldest ? `in the most recent 200 commits (back to ${day(oldest)})` : "in the last 365 days";
  const published = (releases?.data ?? []).filter((r) => !r.draft && r.published_at);
  const burst = releaseBurst(published.map((r) => r.published_at!));
  const withAssets = published.slice(0, 5).filter((r) => r.assets?.length);
  const signedAssets = withAssets.some((r) => r.assets!.some((a) => SIGNATURE_ASSET.test(a.name)));
  // Projects sometimes keep a rejected report published, with a summary starting "REJECTED".
  const repoAdvisories = (advisories?.data ?? []).filter((a) => !a.withdrawn_at && !/^(rejected|withdrawn)\b/i.test(a.summary));
  const ruleTypes = [...new Set((rules?.data ?? []).map((r) => r.type))];
  const isProtected = branchInfo?.data.protected === true || ruleTypes.length > 0;

  const findings: Array<{ level: Level; text: string }> = [];
  const flag = (level: Level, text: string) => findings.push({ level, text });
  if (repo.archived) flag("high", "Archived: the owner no longer maintains it, so security issues will not be fixed.");
  if (stats.humans === 0 && daysSince(repo.pushed_at) > 365) flag("high", `No commits in the last year (last push ${day(repo.pushed_at)}): security issues are unlikely to be fixed.`);
  if (stats.humans > 0 && stats.busFactor === 1) {
    const [top, n] = stats.ranked[0];
    flag(
      "medium",
      `Bus factor 1: ${top} made ${Math.round((n / stats.humans) * 100)}% of commits ${windowText}. A project that depends on one person is the easiest to take over, which is how the xz-utils backdoor began.`
    );
  }
  if (daysSince(repo.created_at) > 365) {
    for (const n of stats.newcomers) {
      flag(
        "medium",
        `${n.who} is new to the project but made ${Math.round(n.share * 100)}% of the last 90 days' commits. This is usually a welcome new maintainer, but a fast takeover by a newcomer is the xz-utils pattern: check who they are.`
      );
    }
  }
  if (burst) flag("medium", `${burst.count} releases in the last 60 days after ${burst.gapDays} days without one. A dormant package that suddenly publishes again is the pattern of the event-stream takeover: check what changed.`);
  if (branchInfo && !isProtected) flag("medium", `The default branch (${branch}) is not protected: anyone with write access can push to it directly or rewrite its history.`);
  if (!policy && reporting?.data.enabled !== true) flag("medium", "No security policy and no private vulnerability reporting: there is no private way to report a vulnerability, so reports may be posted publicly first.");
  else if (!policy) flag("low", "No SECURITY.md, though private vulnerability reporting is enabled.");
  if (!updater) flag("low", "No Dependabot or Renovate configuration: its own dependencies may not be updated when fixes come out.");
  if (stats.sampled >= 10 && stats.verified / stats.sampled < 0.5) flag("low", `Only ${stats.verified} of the last ${stats.sampled} commits have verified signatures.`);
  if (withAssets.length && !signedAssets) flag("low", "Release downloads have no signatures (.sig, .asc or Sigstore files), so you cannot verify they were built by the maintainers.");
  if (scorecard) {
    const dangerous = scorecard.checks.find((c) => c.name === "Dangerous-Workflow");
    if (dangerous?.score === 0) flag("high", `OpenSSF Scorecard found dangerous GitHub Actions workflow patterns (${dangerous.reason}). Untrusted code running with repository secrets has been behind several CI supply chain attacks.`);
    if (scorecard.score < 4) flag("medium", `OpenSSF Scorecard rates its security practices ${scorecard.score}/10.`);
  }

  const order: Level[] = ["high", "medium", "low"];
  findings.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const count = (level: Level) => findings.filter((f) => f.level === level).length;
  const overall = count("high") ? "HIGH" : count("medium") ? "MODERATE" : "LOW";

  const lines = [
    `# Supply chain risk: ${repo.full_name} - ${overall} RISK`,
    `${count("high")} high, ${count("medium")} medium and ${count("low")} low findings. These are public signals about how the project is run; they cannot detect malicious code.`,
    "",
    "## Findings",
  ];
  if (!findings.length) lines.push("None.");
  for (const f of findings) lines.push(`- [${f.level.toUpperCase()}] ${f.text}`);

  lines.push("", "## Signals");
  if (stats.humans) {
    const top = stats.ranked
      .slice(0, 3)
      .map(([who, n]) => `${who} ${Math.round((n / stats.humans) * 100)}%`)
      .join(", ");
    lines.push(`- Maintainers: ${stats.ranked.length} people made ${num(stats.humans)} commits ${windowText}. Bus factor ${stats.busFactor}. Most active: ${top}.`);
  } else {
    lines.push(`- Maintainers: no commits by people ${windowText}.`);
  }
  lines.push(`- New maintainers: ${stats.newcomers.length ? stats.newcomers.map((n) => n.who).join(", ") : "none with an unusual share of recent commits"}.`);
  if (stats.sampled) lines.push(`- Commit signatures: ${stats.verified} of the last ${stats.sampled} commits verified.`);
  lines.push(
    `- Default branch (${branch}): ${!branchInfo ? "unknown" : ruleTypes.length ? `protected by rulesets (${ruleTypes.join(", ")})` : isProtected ? "protected" : "not protected"}.`
  );
  lines.push(`- Security policy: ${policy ?? "none found"}. Private vulnerability reporting: ${reporting ? (reporting.data.enabled ? "enabled" : "disabled") : "unknown"}.`);
  lines.push(`- Dependency updates: ${updater ?? "none configured"}.`);
  if (repoAdvisories.length) {
    const latest = repoAdvisories[0];
    lines.push(
      `- Security advisories published by the project: ${repoAdvisories.length}. Latest: ${(latest.severity ?? "unknown").toUpperCase()} ${latest.ghsa_id} on ${day(latest.published_at)} - ${oneLine(latest.summary, 120)}. Publishing advisories is a good sign: issues get disclosed.`
    );
  } else {
    lines.push("- Security advisories published by the project: none.");
  }
  if (published.length) {
    const latest = published[0];
    const signing = withAssets.length ? (signedAssets ? "release files are signed" : "release files are not signed") : "no downloadable release files";
    lines.push(`- Releases: latest ${latest.tag_name} on ${day(latest.published_at)} (${ago(latest.published_at!)}); ${signing}.`);
  } else {
    lines.push("- Releases: none on GitHub (it may publish packages elsewhere).");
  }
  if (repo.owner) lines.push(`- Owner: ${repo.owner.type === "Organization" ? "organization" : "personal account"} ${repo.owner.login}.`);

  lines.push("");
  if (scorecard) {
    const scored = scorecard.checks.filter((c) => c.score >= 0);
    const weak = scored.filter((c) => c.score < 5).sort((a, b) => a.score - b.score);
    const middle = scored.filter((c) => c.score >= 5 && c.score < 8);
    const strong = scored.filter((c) => c.score >= 8);
    lines.push(`## OpenSSF Scorecard: ${scorecard.score}/10 (scanned ${day(scorecard.date)})`);
    if (weak.length) lines.push(`Weak: ${weak.map((c) => `${c.name} ${c.score} (${oneLine(c.reason, 80)})`).join("; ")}`);
    if (middle.length) lines.push(`Fair: ${middle.map((c) => `${c.name} ${c.score}`).join(", ")}`);
    if (strong.length) lines.push(`Strong: ${strong.map((c) => c.name).join(", ")}`);
    lines.push(`Details: https://scorecard.dev/viewer/?uri=github.com/${repo.full_name}`);
  } else if (repo.private) {
    lines.push("OpenSSF Scorecard: not checked for private repositories.");
  } else {
    lines.push("OpenSSF Scorecard: no result. Scorecard scans popular projects weekly; this one may not be covered.");
  }
  lines.push("", "Next: call security_audit_dependencies for known vulnerabilities in its dependencies, and security_advisories for a specific package version.");
  return lines.join("\n");
}

export function registerSecurityTools(server: McpServer): void {
  server.registerTool(
    "security_advisories",
    {
      title: "Security advisories for a package",
      description:
        "Known vulnerabilities (CVEs) and malware reports for one package from the GitHub Advisory Database: severity, affected and fixed versions, " +
        "and EPSS exploit likelihood. Pass version to see only advisories that affect it. Part of the security toolkit: for a repository, also use " +
        "security_audit_dependencies and security_supply_chain_risk. Uses 2 API requests.",
      inputSchema: {
        ecosystem: ecosystemShape,
        package: z
          .string()
          .min(1)
          .describe("Package name as published: 'lodash', '@babel/core', 'Django', 'golang.org/x/net', 'org.apache.logging.log4j:log4j-core' (Maven groupId:artifactId)"),
        version: z.string().min(1).optional().describe("Exact version to check, e.g. '4.17.15'. Without it, every advisory ever published is listed."),
        min_severity: z.enum(["low", "medium", "high", "critical"]).optional().describe("Only show advisories at or above this severity"),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum advisories to list (default 20)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const { ecosystem, version } = args;
        const names = queryNames(ecosystem, args.package);
        const [reviewed, bad] = await Promise.all([
          fetchAdvisories({ ecosystem, affects: names.map((n) => (version ? `${n}@${version}` : n)).join(",") }, 3),
          fetchAdvisories({ ecosystem, affects: names.join(","), type: "malware" }, 1),
        ]);
        const label = `${ecosystem} ${args.package}${version ? `@${version}` : ""}`;
        const minRank = args.min_severity ? severityRank(args.min_severity) : 0;
        // GitHub already filtered by version; fall back to all entries when a range uses a format the comparator does not handle.
        const hits = uniqueAdvisories(reviewed.items)
          .map((a) => hitFor(a, ecosystem, args.package, version ?? null) ?? hitFor(a, ecosystem, args.package, null))
          .filter((h): h is Hit => h !== null && severityRank(h.advisory.severity) >= minRank)
          .sort(version ? bySeverity : (a, b) => (b.advisory.published_at ?? "").localeCompare(a.advisory.published_at ?? ""));
        const malware = uniqueAdvisories(bad.items)
          .map((a) => hitFor(a, ecosystem, args.package, null))
          .filter((h): h is Hit => h !== null);

        const lines = [`# Security advisories: ${label}`, ""];
        for (const m of malware) {
          lines.push(`MALWARE: ${oneLine(m.advisory.summary, 160)} (${m.advisory.ghsa_id}). ${malwareVerdict(m, version ?? null, Boolean(version))}`, `   ${m.advisory.html_url}`, "");
        }
        if (!hits.length) {
          lines.push(
            `No ${args.min_severity ? `${args.min_severity}-or-higher ` : ""}advisories ${version ? "affect this version" : "have been published for this package"} in the GitHub Advisory Database.`,
            "Check the spelling and ecosystem: names must match the registry exactly. No advisories does not prove a package is safe; call security_supply_chain_risk on its repository to see how it is maintained."
          );
          return lines.join("\n").trim();
        }
        if (version) {
          lines.push(`${hits.length} ${hits.length === 1 ? "advisory affects" : "advisories affect"} this version: ${severityCounts(hits)}. ${upgradeAdvice(hits)}`);
        } else {
          lines.push(`${hits.length} ${hits.length === 1 ? "advisory has" : "advisories have"} been published for this package (${severityCounts(hits)}), including ones fixed long ago. Pass version to see only those that affect you.`);
        }
        lines.push("");
        hits.slice(0, args.limit).forEach((h, i) => lines.push(...advisoryLines(h, i + 1), ""));
        if (hits.length > args.limit) lines.push(`${hits.length - args.limit} more not shown. Raise limit or set min_severity.`);
        if (!reviewed.complete) lines.push("More advisories exist than this tool fetches; the list above is the most recent.");
        if (hits.some((h) => h.advisory.epss?.percentage)) lines.push(EPSS_NOTE);
        return lines.join("\n").trim();
      })
  );

  server.registerTool(
    "security_audit_dependencies",
    {
      title: "Audit a repository's dependencies",
      description:
        "Checks every dependency a repository declares against the GitHub Advisory Database for known vulnerabilities and malware, without cloning it. " +
        `Finds manifests at the repository root automatically (${Object.keys(MANIFESTS).join(", ")}), or pass path. ` +
        "Part of the security toolkit: also call security_supply_chain_risk for how the project is run, and security_advisories for details on one package. " +
        "Uses about 2 API requests per manifest plus 2 per ecosystem.",
      inputSchema: {
        ...ownerRepoShape,
        path: z.string().optional().describe("Path to one manifest, e.g. 'backend/requirements.txt' (default: every supported manifest at the root)"),
        ref: z.string().optional().describe("Branch, tag or commit SHA (default: the default branch)"),
        include_dev: z.boolean().default(true).describe("Also check dev, test and optional dependencies (default true)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const base = repoPath(args.owner, args.repo);
        let files: string[];
        if (args.path) {
          const file = args.path.replace(/^\/+/, "");
          if (!MANIFESTS[file.split("/").pop()!]) {
            throw new GitHubError(`${file} is not a supported manifest. Supported: ${Object.keys(MANIFESTS).join(", ")}.`, 400);
          }
          files = [file];
        } else {
          const root = await gh<Array<{ name: string; type: string }>>(`${base}/contents`, { ref: args.ref });
          files = root.filter((e) => e.type === "file" && MANIFESTS[e.name]).map((e) => e.name);
          if (!files.length) {
            return `No supported manifest at the root of ${args.owner}/${args.repo}. Supported: ${Object.keys(MANIFESTS).join(", ")}. If the project keeps it in a subfolder, pass path, e.g. 'backend/requirements.txt' (get_repo_tree shows where).`;
          }
        }
        return formatAudit(args.owner, args.repo, await auditDependencies(base, files, args.ref, args.include_dev));
      })
  );

  server.registerTool(
    "security_supply_chain_risk",
    {
      title: "Supply chain risk of a repository",
      description:
        "Is this project safe to depend on? Checks the warning signs behind real supply chain attacks (xz-utils, event-stream): bus factor, " +
        "a newcomer suddenly taking over, dormant-then-burst releases, branch protection, commit and release signing, security policy, private " +
        "vulnerability reporting, Dependabot or Renovate, published advisories, and the OpenSSF Scorecard result. Part of the security toolkit: " +
        "also call security_audit_dependencies for known vulnerabilities in its dependencies. Uses about 12 GitHub API requests, plus one call " +
        "to the public OpenSSF Scorecard API with the repository name.",
      inputSchema: ownerRepoShape,
      annotations: readOnly,
    },
    async (args) => run(() => supplyChainRisk(args.owner, args.repo))
  );
}
