import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchRange, GitHubError, isMock, token } from "../github.js";
import { dateShape, day, num, oneLine, pageFooter, pagingShape, repoSummary, run, type Repo } from "../format.js";

const SEARCH_CAP = 1000;
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function normalizeTopic(topic: string): string {
  return topic.trim().toLowerCase().replace(/\s+/g, "-");
}

export interface RepoQueryInput {
  query?: string;
  topics?: string[];
  language?: string;
  min_stars?: number;
  pushed_after?: string;
  created_after?: string;
  license?: string;
  include_archived?: boolean;
}

export function buildRepoQuery(input: RepoQueryInput): string {
  const criteria = [
    input.query?.trim(),
    ...(input.topics ?? []).map((t) => `topic:${normalizeTopic(t)}`),
    input.language && `language:${quote(input.language.trim())}`,
    input.min_stars !== undefined && `stars:>=${input.min_stars}`,
    input.pushed_after && `pushed:>=${input.pushed_after}`,
    input.created_after && `created:>=${input.created_after}`,
    input.license && `license:${input.license.trim().toLowerCase()}`,
  ].filter((part): part is string => Boolean(part));

  if (criteria.length === 0) {
    throw new GitHubError("Provide at least one of: query, topics, language, min_stars, pushed_after, created_after, license.", 400);
  }
  if (!input.include_archived) criteria.push("archived:false");
  return criteria.join(" ");
}

function checkSearchWindow(offset: number, limit: number): number {
  if (offset >= SEARCH_CAP) {
    throw new GitHubError("GitHub search only returns the first 1,000 results. Use offset below 1000 and add filters to narrow the search.", 400);
  }
  return Math.min(limit, SEARCH_CAP - offset);
}

function searchExtract<T>(data: { total_count: number; incomplete_results: boolean; items: T[] }) {
  return { items: data.items, total: data.total_count, incomplete: data.incomplete_results };
}

function resultHeader(q: string, offset: number, shown: number, total: number | undefined, sortNote: string): string {
  const range = shown === 0 ? "No results" : `Results ${num(offset + 1)}-${num(offset + shown)} of ${num(total ?? shown)}`;
  return `Query: ${q}${sortNote}\n${range}`;
}

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    "search_repositories",
    {
      title: "Search repositories",
      description:
        "Search public GitHub repositories (GET /search/repositories) by any combination of keywords, topics, language, stars, activity dates and license.\n" +
        "Matching: 'query' keywords match the repo name, description and topics (not the README unless you add in:readme). " +
        "'topics' is stricter: each listed topic must be an exact tag on the repo, and all of them must be present (AND). " +
        "If you are unsure of exact topic names, call search_topics first. Archived repos are excluded unless include_archived is true; forks are excluded by GitHub by default.\n" +
        "Each result includes: full_name (owner/repo), stars, forks, open issues + PRs (GitHub counts both together), primary language, license (SPDX id), " +
        "last push date, ARCHIVED/fork flags, description, topics and URL. The response also shows the exact GitHub query used and the total match count.\n" +
        "Other GitHub repo attributes can be filtered by adding qualifiers to 'query' (see its description), e.g. forks, size, owner, template status, help-wanted issue count.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Keywords matched against name, description and topics. You can also append raw GitHub qualifiers: " +
              "in:name | in:description | in:topics | in:readme (where keywords must appear), user:NAME or org:NAME (owner), " +
              "forks:>=N, size:>=N (KB), topics:>=N (number of topics), followers:>=N, " +
              "good-first-issues:>=N, help-wanted-issues:>=N, template:true, fork:true or fork:only (include forks), mirror:false, " +
              "created:/pushed: with date ranges like 2025-01-01..2025-06-30. Example: 'payment gateway org:stripe forks:>=50'."
          ),
        topics: z.array(z.string().min(1)).max(10).optional().describe("Repos must have ALL of these topics, e.g. ['java','spring-boot']"),
        language: z.string().optional().describe("Primary language, e.g. 'Java', 'TypeScript', 'Go'"),
        min_stars: z.number().int().min(0).optional().describe("Minimum star count"),
        pushed_after: dateShape.optional().describe("Only repos with a push on or after this date (YYYY-MM-DD). Good proxy for 'still maintained'."),
        created_after: dateShape.optional().describe("Only repos created on or after this date (YYYY-MM-DD)"),
        license: z.string().optional().describe("License key, e.g. 'mit', 'apache-2.0', 'gpl-3.0'"),
        include_archived: z.boolean().default(false).describe("Include archived (read-only) repositories"),
        sort: z
          .enum(["best-match", "stars", "forks", "updated", "help-wanted-issues"])
          .optional()
          .describe("Sort order. Defaults to 'stars' when no free-text query is given, otherwise 'best-match'."),
        order: z.enum(["desc", "asc"]).default("desc"),
        ...pagingShape(10),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const q = buildRepoQuery(args);
        const sort = args.sort ?? (args.query?.trim() ? "best-match" : "stars");
        const limit = checkSearchWindow(args.offset, args.limit);
        const { items, total, incomplete } = await fetchRange<Repo>(
          "/search/repositories",
          { q, sort: sort === "best-match" ? undefined : sort, order: sort === "best-match" ? undefined : args.order },
          args.offset,
          limit,
          searchExtract
        );
        const lines = [resultHeader(q, args.offset, items.length, total, `  (sorted by ${sort})`), ""];
        items.forEach((repo, i) => lines.push(repoSummary(repo, args.offset + i + 1), ""));
        if (incomplete) lines.push("Note: GitHub timed out part of this search, so results may be incomplete.");
        lines.push(pageFooter(args.offset, items.length, total, true));
        if (items.length === 0 && args.topics?.length) {
          lines.push("Tip: topic names must match exactly. Use search_topics to find the names GitHub actually uses.");
        }
        return lines.join("\n").trim();
      })
  );

  server.registerTool(
    "search_topics",
    {
      title: "Search topics",
      description:
        "Find the exact GitHub topic names for a concept, e.g. 'banking' -> fintech, core-banking, payments. " +
        "Use the returned names in search_repositories. Featured topics are highlighted by GitHub; curated topics have extra descriptions.",
      inputSchema: {
        query: z.string().min(1).describe("Concept or keyword, e.g. 'banking', 'state management', 'kubernetes operator'"),
        featured_only: z.boolean().default(false).describe("Only topics GitHub features"),
        curated_only: z.boolean().default(false).describe("Only curated topics"),
        ...pagingShape(20),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const q = [args.query.trim(), args.featured_only && "is:featured", args.curated_only && "is:curated"].filter(Boolean).join(" ");
        const limit = checkSearchWindow(args.offset, args.limit);
        const { items, total } = await fetchRange<{
          name: string;
          display_name: string | null;
          short_description: string | null;
          featured: boolean;
          curated: boolean;
        }>("/search/topics", { q }, args.offset, limit, searchExtract);

        if (items.length === 0) return `No topics found for "${args.query}". Try a shorter or more general word.`;
        const lines = [`Topics matching "${args.query}" (${num(total ?? items.length)} total):`, ""];
        for (const t of items) {
          const tags = [t.featured && "featured", t.curated && "curated"].filter(Boolean).join(", ");
          const label = t.display_name && t.display_name.toLowerCase() !== t.name ? ` (${t.display_name})` : "";
          const desc = oneLine(t.short_description, 140);
          lines.push(`- ${t.name}${label}${tags ? ` [${tags}]` : ""}${desc ? ` - ${desc}` : ""}`);
        }
        lines.push("", "Use these names in search_repositories, e.g. topics: [\"" + items[0].name + "\"].");
        const footer = pageFooter(args.offset, items.length, total, true);
        if (footer) lines.push(footer);
        return lines.join("\n");
      })
  );

  server.registerTool(
    "search_issues_and_prs",
    {
      title: "Search issues and pull requests",
      description:
        "Search issues or pull requests across all public repositories, or within one repo. " +
        "Useful for finding how others hit and solved a problem (e.g. an error message), or for good-first-issue hunting.",
      inputSchema: {
        query: z.string().optional().describe("Keywords, e.g. an error message. Raw qualifiers like 'author:x' also work."),
        type: z.enum(["issue", "pr"]).default("issue").describe("Search issues or pull requests"),
        state: z.enum(["open", "closed", "any"]).default("any"),
        repo: z.string().optional().describe("Limit to one repository: 'owner/repo'"),
        labels: z.array(z.string().min(1)).max(5).optional().describe("Must have ALL of these labels, e.g. ['good first issue']"),
        language: z.string().optional().describe("Repository language, e.g. 'Python'"),
        sort: z.enum(["best-match", "comments", "reactions", "created", "updated"]).default("best-match"),
        order: z.enum(["desc", "asc"]).default("desc"),
        ...pagingShape(10),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        if (!args.query?.trim() && !args.repo && !args.labels?.length && !args.language) {
          throw new GitHubError("Provide at least one of: query, repo, labels, language.", 400);
        }
        const q = [
          args.query?.trim(),
          args.type === "pr" ? "is:pr" : "is:issue",
          args.state !== "any" && `state:${args.state}`,
          args.repo && `repo:${args.repo.trim()}`,
          ...(args.labels ?? []).map((l) => `label:"${l}"`),
          args.language && `language:${quote(args.language)}`,
        ]
          .filter(Boolean)
          .join(" ");
        const limit = checkSearchWindow(args.offset, args.limit);
        const { items, total, incomplete } = await fetchRange<{
          title: string;
          number: number;
          state: string;
          html_url: string;
          repository_url: string;
          comments: number;
          created_at: string;
          updated_at: string;
          user: { login: string } | null;
          labels: Array<{ name: string }>;
          pull_request?: { merged_at: string | null };
        }>(
          "/search/issues",
          { q, sort: args.sort === "best-match" ? undefined : args.sort, order: args.sort === "best-match" ? undefined : args.order },
          args.offset,
          limit,
          searchExtract
        );

        const lines = [resultHeader(q, args.offset, items.length, total, ""), ""];
        items.forEach((it, i) => {
          const repo = it.repository_url.split("/").slice(-2).join("/");
          const state = it.pull_request?.merged_at ? "merged" : it.state;
          lines.push(`${args.offset + i + 1}. [${state}] ${repo}#${it.number} ${oneLine(it.title, 160)}`);
          lines.push(
            `   by ${it.user?.login ?? "unknown"} · comments: ${it.comments} · created ${day(it.created_at)} · updated ${day(it.updated_at)}`
          );
          if (it.labels.length) lines.push(`   labels: ${it.labels.map((l) => l.name).join(", ")}`);
          lines.push(`   ${it.html_url}`, "");
        });
        if (incomplete) lines.push("Note: GitHub timed out part of this search, so results may be incomplete.");
        lines.push(pageFooter(args.offset, items.length, total, true));
        return lines.join("\n").trim();
      })
  );

  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Search source code in public repositories (GitHub requires a token for this endpoint, so it only works when GITHUB_TOKEN or GITHUB_PAT is set). " +
        "Returns matching files with a short snippet.",
      inputSchema: {
        query: z.string().min(1).describe("Code or text to find, e.g. 'useSyncExternalStore'"),
        repo: z.string().optional().describe("Limit to one repository: 'owner/repo'"),
        owner: z.string().optional().describe("Limit to a user or organization"),
        language: z.string().optional().describe("e.g. 'TypeScript'"),
        path: z.string().optional().describe("Limit to files under this path, e.g. 'src/'"),
        filename: z.string().optional().describe("Exact file name, e.g. 'pom.xml'"),
        extension: z.string().optional().describe("File extension without dot, e.g. 'yml'"),
        ...pagingShape(10),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        if (!token && !isMock) {
          throw new GitHubError(
            "search_code needs a GitHub token: GitHub does not allow code search without authentication. " +
              "Set GITHUB_TOKEN (or GITHUB_PAT) in this server's environment. A token with no scopes is enough for public code.",
            401
          );
        }
        const q = [
          args.query.trim(),
          args.repo && `repo:${args.repo.trim()}`,
          args.owner && `user:${args.owner.trim()}`,
          args.language && `language:${quote(args.language)}`,
          args.path && `path:${args.path.trim()}`,
          args.filename && `filename:${args.filename.trim()}`,
          args.extension && `extension:${args.extension.replace(/^\./, "")}`,
        ]
          .filter(Boolean)
          .join(" ");
        const limit = checkSearchWindow(args.offset, args.limit);
        const { items, total, incomplete } = await fetchRange<{
          path: string;
          html_url: string;
          repository: { full_name: string };
          text_matches?: Array<{ fragment: string }>;
        }>("/search/code", { q }, args.offset, limit, searchExtract, { accept: "application/vnd.github.text-match+json" });

        const lines = [resultHeader(q, args.offset, items.length, total, ""), ""];
        items.forEach((it, i) => {
          lines.push(`${args.offset + i + 1}. ${it.repository.full_name}: ${it.path}`);
          const fragment = it.text_matches?.[0]?.fragment;
          if (fragment) lines.push(`   ${oneLine(fragment, 240)}`);
          lines.push(`   ${it.html_url}`, "");
        });
        if (incomplete) lines.push("Note: GitHub timed out part of this search, so results may be incomplete.");
        lines.push(pageFooter(args.offset, items.length, total, true));
        return lines.join("\n").trim();
      })
  );
}
