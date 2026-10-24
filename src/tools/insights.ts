import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gh, ghOptional, repoPath } from "../github.js";
import { ago, daysSince, day, licenseName, num, oneLine, ownerRepoShape, parseRepoRef, repoSummary, run, type Repo } from "../format.js";
import { normalizeTopic } from "./search.js";

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

interface CommunityProfile {
  files: Partial<Record<"license" | "readme" | "contributing" | "code_of_conduct" | "issue_template" | "pull_request_template", unknown>>;
}

interface Contributor {
  login?: string;
  contributions: number;
  type: string;
}

interface Release {
  tag_name: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
}

export interface HealthPart {
  name: string;
  max: number;
  points: number;
  detail: string;
}

export interface Health {
  repo: Repo;
  score: number;
  grade: string;
  parts: HealthPart[];
  warnings: string[];
}

function step(value: number, thresholds: Array<[number, number]>): number {
  for (const [limit, points] of thresholds) if (value <= limit) return points;
  return 0;
}

export async function computeHealth(owner: string, name: string): Promise<Health> {
  const base = repoPath(owner, name);
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const [repo, community, releases, contributors, commits] = await Promise.all([
    gh<Repo>(base),
    ghOptional<CommunityProfile>(`${base}/community/profile`),
    ghOptional<Release[]>(`${base}/releases`, { per_page: 10 }),
    ghOptional<Contributor[]>(`${base}/contributors`, { per_page: 100 }),
    ghOptional<unknown[]>(`${base}/commits`, { since, per_page: 100 }),
  ]);

  const parts: HealthPart[] = [];
  const warnings: string[] = [];

  const pushDays = daysSince(repo.pushed_at);
  parts.push({
    name: "Activity",
    max: 30,
    points: step(pushDays, [
      [30, 30],
      [90, 22],
      [180, 14],
      [365, 6],
    ]),
    detail: `last push ${ago(repo.pushed_at)} (${day(repo.pushed_at)})`,
  });
  if (pushDays > 365) warnings.push(`No pushes for over a year (${day(repo.pushed_at)}).`);

  if (commits) {
    const n = commits.data.length;
    const points = n >= 50 ? 15 : n >= 20 ? 11 : n >= 5 ? 7 : n >= 1 ? 3 : 0;
    parts.push({ name: "Recent commits", max: 15, points, detail: `${n >= 100 ? "100+" : n} commits on ${repo.default_branch} in the last 90 days` });
  } else {
    parts.push({ name: "Recent commits", max: 15, points: 0, detail: "commit history unavailable (empty repository?)" });
  }

  const published = (releases?.data ?? []).filter((r) => !r.draft && r.published_at);
  const latest = published.find((r) => !r.prerelease) ?? published[0];
  if (latest) {
    const relDays = daysSince(latest.published_at!);
    parts.push({
      name: "Releases",
      max: 15,
      points: relDays <= 180 ? 15 : relDays <= 365 ? 10 : 5,
      detail: `latest ${latest.tag_name} on ${day(latest.published_at)} (${ago(latest.published_at!)})`,
    });
  } else {
    parts.push({ name: "Releases", max: 15, points: 0, detail: "no GitHub releases (the project may still publish tags or packages)" });
  }

  const humans = (contributors?.data ?? []).filter((c) => c.type !== "Bot");
  if (humans.length > 0) {
    const more = contributors?.link?.includes('rel="last"') ?? false;
    const count = humans.length;
    const countPoints = more || count >= 20 ? 10 : count >= 5 ? 7 : count >= 2 ? 4 : 1;
    const total = humans.reduce((sum, c) => sum + c.contributions, 0);
    const topShare = total > 0 ? humans[0].contributions / total : 1;
    const sharePoints = topShare < 0.5 ? 10 : topShare < 0.75 ? 6 : topShare < 0.9 ? 3 : 0;
    parts.push({
      name: "Contributors",
      max: 20,
      points: countPoints + sharePoints,
      detail: `${more ? "100+" : count} contributors; top contributor (${humans[0].login ?? "anonymous"}) made ${Math.round(topShare * 100)}% of commits`,
    });
    if (count === 1) warnings.push("Single contributor: the project depends on one person.");
    else if (topShare >= 0.9) warnings.push(`One person (${humans[0].login}) made ${Math.round(topShare * 100)}% of commits: low bus factor.`);
  } else {
    parts.push({ name: "Contributors", max: 20, points: 0, detail: "contributor list unavailable (very large or empty repository)" });
  }

  const files = community?.data.files ?? {};
  const hasLicense = Boolean(files.license) || Boolean(repo.license);
  const checks: Array<[string, boolean, number]> = [
    ["license", hasLicense, 5],
    ["README", Boolean(files.readme), 3],
    ["CONTRIBUTING", Boolean(files.contributing), 4],
    ["code of conduct", Boolean(files.code_of_conduct), 2],
    ["issue template", Boolean(files.issue_template), 3],
    ["PR template", Boolean(files.pull_request_template), 3],
  ];
  parts.push({
    name: "Community files",
    max: 20,
    points: checks.reduce((sum, [, ok, pts]) => sum + (ok ? pts : 0), 0),
    detail: checks.map(([label, ok]) => `${label}: ${ok ? "yes" : "no"}`).join(", "),
  });
  if (!hasLicense) warnings.push("No license: legally you may not be allowed to use or modify this code.");

  let score = parts.reduce((sum, p) => sum + p.points, 0);
  let grade = score >= 80 ? "Healthy" : score >= 60 ? "Moderate" : score >= 40 ? "Weak" : "Poor";
  if (repo.archived) {
    score = Math.min(score, 20);
    grade = "Archived";
    warnings.unshift("Archived: the owner has marked this repository read-only and it is no longer maintained.");
  }
  if (repo.fork) warnings.push(`This is a fork of ${repo.parent?.full_name ?? "another repository"}; check the upstream project too.`);

  return { repo, score, grade, parts, warnings };
}

function formatHealth(h: Health): string {
  const r = h.repo;
  const lines = [`# Health: ${r.full_name} - ${h.score}/100 (${h.grade})`, ""];
  for (const p of h.parts) lines.push(`- ${p.name}: ${p.points}/${p.max} - ${p.detail}`);
  if (h.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of h.warnings) lines.push(`- ${w}`);
  }
  lines.push(
    "",
    `Other signals: ★ ${num(r.stargazers_count)} · forks ${num(r.forks_count)} · open issues + PRs ${num(r.open_issues_count)} · created ${day(r.created_at)} · license ${licenseName(r)}`,
    "",
    "The score is a heuristic from public activity data. It says whether a project is alive and well run, not whether its code is good."
  );
  return lines.join("\n");
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(cell).join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}

const GENERIC_TOPICS = new Set([
  "hacktoberfest",
  "awesome",
  "open-source",
  "opensource",
  "library",
  "framework",
  "tool",
  "tools",
  "cli",
  "api",
]);

export function pickCoreTopics(repo: Repo, max = 3): string[] {
  const language = repo.language?.toLowerCase();
  return (repo.topics ?? []).filter((t) => !GENERIC_TOPICS.has(t) && t !== language).slice(0, max);
}

export function registerInsightTools(server: McpServer): void {
  server.registerTool(
    "get_repo_health",
    {
      title: "Get repository health",
      description:
        "Score (0-100) for whether a repository is alive and well maintained, with a transparent breakdown: recent pushes, commits in the last 90 days, " +
        "releases, contributor count and concentration (bus factor), and community files (license, CONTRIBUTING, templates). Uses about 5 API requests.",
      inputSchema: ownerRepoShape,
      annotations: readOnly,
    },
    async (args) => run(async () => formatHealth(await computeHealth(args.owner, args.repo)))
  );

  server.registerTool(
    "compare_repositories",
    {
      title: "Compare repositories",
      description:
        "Compare 2-5 repositories side by side: stars, forks, language, license, activity and topics. " +
        "Set include_health to add health scores (about 5 extra API requests per repo).",
      inputSchema: {
        repos: z.array(z.string().min(3)).min(2).max(5).describe("Repositories as 'owner/repo' or github.com URLs"),
        include_health: z.boolean().default(false).describe("Also compute health scores (costs about 5 requests per repo)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const refs = args.repos.map(parseRepoRef);
        const results = await Promise.all(
          refs.map(async ({ owner, repo }) => {
            if (args.include_health) return computeHealth(owner, repo);
            return { repo: await gh<Repo>(repoPath(owner, repo)) } as Partial<Health> & { repo: Repo };
          })
        );

        const headers = ["", ...results.map((r) => r.repo.full_name)];
        const row = (label: string, value: (h: Partial<Health> & { repo: Repo }) => string) => [label, ...results.map(value)];
        const rows = [
          row("Stars", (h) => num(h.repo.stargazers_count)),
          row("Forks", (h) => num(h.repo.forks_count)),
          row("Open issues + PRs", (h) => num(h.repo.open_issues_count)),
          row("Language", (h) => h.repo.language ?? "-"),
          row("License", (h) => licenseName(h.repo)),
          row("Created", (h) => day(h.repo.created_at)),
          row("Last push", (h) => `${day(h.repo.pushed_at)} (${daysSince(h.repo.pushed_at)}d ago)`),
          row("Archived", (h) => (h.repo.archived ? "YES" : "no")),
          row("Topics", (h) => (h.repo.topics ?? []).slice(0, 6).join(", ") || "-"),
        ];
        if (args.include_health) {
          rows.push(row("Health score", (h) => `${h.score}/100 (${h.grade})`));
          for (const name of ["Activity", "Recent commits", "Releases", "Contributors", "Community files"]) {
            rows.push(row(`  ${name}`, (h) => {
              const part = h.parts?.find((p) => p.name === name);
              return part ? `${part.points}/${part.max}` : "-";
            }));
          }
        }

        const lines = [table(headers, rows), ""];
        for (const r of results) {
          lines.push(`- ${r.repo.full_name}: ${oneLine(r.repo.description, 160) || "(no description)"}`);
          for (const w of r.warnings ?? []) lines.push(`  warning: ${w}`);
        }
        return lines.join("\n");
      })
  );

  server.registerTool(
    "find_similar_repositories",
    {
      title: "Find similar repositories",
      description:
        "Find repositories similar to a given one, using its topics (and optionally its language). Results are ranked by how many topics they share, then by stars. " +
        "Each result has the same fields as search_repositories (stars, forks, open issues + PRs, language, license, last push, flags, description, topics, URL) " +
        "plus the list of shared topics. Uses up to 3 searches.",
      inputSchema: {
        ...ownerRepoShape,
        same_language: z.boolean().default(true).describe("Only return repos in the same primary language"),
        min_stars: z.number().int().min(0).default(10).describe("Minimum stars for results (default 10)"),
        limit: z.number().int().min(1).max(30).default(10).describe("Number of results (default 10)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const source = await gh<Repo>(repoPath(args.owner, args.repo));
        const core = pickCoreTopics(source);
        if (core.length === 0) {
          return (
            `${source.full_name} has no specific topics to match on${source.topics?.length ? ` (only generic ones: ${source.topics.join(", ")})` : ""}. ` +
            `Try search_repositories with keywords from its description instead: "${oneLine(source.description, 160)}"` +
            (source.language ? ` and language "${source.language}".` : ".")
          );
        }

        const sourceTopics = new Set(source.topics ?? []);
        const candidates = new Map<string, Repo>();
        for (const topic of core) {
          const q = [
            `topic:${normalizeTopic(topic)}`,
            args.same_language && source.language && `language:"${source.language}"`,
            `stars:>=${args.min_stars}`,
            "archived:false",
          ]
            .filter(Boolean)
            .join(" ");
          const data = await gh<{ items: Repo[] }>("/search/repositories", { q, sort: "stars", order: "desc", per_page: 30 });
          for (const r of data.items) if (r.full_name !== source.full_name) candidates.set(r.full_name, r);
        }

        const ranked = [...candidates.values()]
          .map((r) => ({ repo: r, shared: (r.topics ?? []).filter((t) => sourceTopics.has(t)) }))
          .sort((a, b) => b.shared.length - a.shared.length || b.repo.stargazers_count - a.repo.stargazers_count)
          .slice(0, args.limit);

        if (ranked.length === 0) {
          return `No similar repositories found for ${source.full_name} using topics ${core.join(", ")}. Try same_language=false or a lower min_stars.`;
        }
        const lines = [
          `Repositories similar to ${source.full_name} (matched on topics: ${core.join(", ")}${args.same_language && source.language ? `; language ${source.language}` : ""}):`,
          "",
        ];
        ranked.forEach(({ repo, shared }, i) => {
          lines.push(repoSummary(repo, i + 1));
          lines.push(`   shared topics (${shared.length}): ${shared.join(", ")}`, "");
        });
        return lines.join("\n").trim();
      })
  );
}
