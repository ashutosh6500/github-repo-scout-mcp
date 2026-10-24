import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchRange, gh, ghOptional, repoPath } from "../github.js";
import { ago, day, licenseName, num, oneLine, ownerRepoShape, pagingShape, run, truncate, type Repo } from "../format.js";

const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

interface Release {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
}

interface Issue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  comments: number;
  created_at: string;
  updated_at: string;
  user: { login: string } | null;
  labels: Array<{ name: string }>;
  pull_request?: unknown;
}

interface PullRequest {
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  base: { ref: string };
  head: { ref: string; label: string };
  body?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  commits?: number;
  comments?: number;
  review_comments?: number;
  labels?: Array<{ name: string }>;
  requested_reviewers?: Array<{ login: string }>;
}

interface TreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  size?: number;
}

interface ContentEntry {
  type: "file" | "dir" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
  content?: string;
  encoding?: string;
  target?: string;
  submodule_git_url?: string;
}

export function encodePath(path: string): string {
  return path
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function comparePaths(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

export function renderTree(entries: TreeEntry[], prefix: string, maxDepth: number, maxEntries: number): { text: string; shown: number; hidden: number } {
  const base = prefix ? `${prefix}/` : "";
  const inScope = entries
    .filter((e) => !base || e.path.startsWith(base))
    .sort((a, b) => comparePaths(a.path, b.path));

  const lines: string[] = [];
  let hidden = 0;
  for (const entry of inScope) {
    const relative = entry.path.slice(base.length);
    const depth = relative.split("/").length;
    if (depth > maxDepth || lines.length >= maxEntries) {
      hidden++;
      continue;
    }
    const name = relative.split("/").pop()!;
    const indent = "  ".repeat(depth - 1);
    if (entry.type === "tree") lines.push(`${indent}${name}/`);
    else if (entry.type === "commit") lines.push(`${indent}${name} (submodule)`);
    else lines.push(`${indent}${name}${entry.size !== undefined ? ` (${formatSize(entry.size)})` : ""}`);
  }
  return { text: lines.join("\n"), shown: lines.length, hidden };
}

function decodeBase64(content: string): Buffer {
  return Buffer.from(content.replace(/\n/g, ""), "base64");
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function issueLines(it: Issue, index: number): string[] {
  const lines = [
    `${index}. [${it.state}] #${it.number} ${oneLine(it.title, 160)}`,
    `   by ${it.user?.login ?? "unknown"} · comments: ${it.comments} · created ${day(it.created_at)} · updated ${day(it.updated_at)}`,
  ];
  if (it.labels.length) lines.push(`   labels: ${it.labels.map((l) => l.name).join(", ")}`);
  lines.push(`   ${it.html_url}`, "");
  return lines;
}

function prState(pr: PullRequest): string {
  const state = pr.merged_at ? "merged" : pr.state;
  return pr.draft ? `${state}, draft` : state;
}

export function registerRepoTools(server: McpServer): void {
  server.registerTool(
    "get_repository",
    {
      title: "Get repository",
      description:
        "Details for one repository: stars, forks, language breakdown, license, topics, activity dates, latest release and the start of the README.",
      inputSchema: {
        ...ownerRepoShape,
        include_readme: z.boolean().default(true).describe("Include the README text"),
        readme_max_chars: z.number().int().min(200).max(50_000).default(4000).describe("Maximum README characters to return"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const base = repoPath(args.owner, args.repo);
        const [repo, languages, release, readme] = await Promise.all([
          gh<Repo>(base),
          ghOptional<Record<string, number>>(`${base}/languages`),
          ghOptional<Release>(`${base}/releases/latest`),
          args.include_readme ? ghOptional<{ content: string; path: string }>(`${base}/readme`) : Promise.resolve(null),
        ]);

        const lines = [`# ${repo.full_name}`];
        if (repo.description) lines.push(repo.description);
        lines.push("");
        lines.push(`URL: ${repo.html_url}`);
        if (repo.homepage) lines.push(`Homepage: ${repo.homepage}`);
        lines.push(
          `Stars: ${num(repo.stargazers_count)} · Forks: ${num(repo.forks_count)} · Watchers: ${num(repo.subscribers_count ?? 0)} · Open issues + PRs: ${num(repo.open_issues_count)}`
        );

        const langTotal = Object.values(languages?.data ?? {}).reduce((a, b) => a + b, 0);
        if (langTotal > 0) {
          const parts = Object.entries(languages!.data)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 8)
            .map(([name, bytes]) => `${name} ${((bytes / langTotal) * 100).toFixed(1)}%`);
          lines.push(`Languages: ${parts.join(", ")}`);
        } else {
          lines.push(`Language: ${repo.language ?? "unknown"}`);
        }
        lines.push(`License: ${licenseName(repo)}${repo.license && licenseName(repo) === "other" ? ` (${repo.license.name})` : ""}`);
        if (repo.topics?.length) lines.push(`Topics: ${repo.topics.join(", ")}`);
        lines.push(`Default branch: ${repo.default_branch}`);
        lines.push(`Created: ${day(repo.created_at)} · Last push: ${day(repo.pushed_at)} (${ago(repo.pushed_at)})`);
        if (repo.archived) lines.push("Status: ARCHIVED (read-only, no longer maintained)");
        if (repo.fork) lines.push(`Fork of: ${repo.parent?.full_name ?? "another repository"}`);
        if (release) {
          const r = release.data;
          lines.push(`Latest release: ${r.tag_name}${r.name && r.name !== r.tag_name ? ` "${r.name}"` : ""} on ${day(r.published_at)} - ${r.html_url}`);
        } else {
          lines.push("Latest release: none published");
        }

        if (args.include_readme) {
          if (readme) {
            const text = decodeBase64(readme.data.content).toString("utf8");
            lines.push("", `## README (${readme.data.path})`, truncate(text, args.readme_max_chars));
          } else {
            lines.push("", "No README found.");
          }
        }
        return lines.join("\n");
      })
  );

  server.registerTool(
    "get_repo_tree",
    {
      title: "Get repository file tree",
      description:
        "The folder and file structure of a repository, as an indented tree. Use path to focus on a subfolder and max_depth to control detail.",
      inputSchema: {
        ...ownerRepoShape,
        ref: z.string().optional().describe("Branch, tag or commit SHA (default: the default branch)"),
        path: z.string().optional().describe("Only show this subfolder, e.g. 'src/main/java'"),
        max_depth: z.number().int().min(1).max(20).default(3).describe("How many folder levels to show below path (default 3)"),
        max_entries: z.number().int().min(10).max(2000).default(300).describe("Maximum lines to return (default 300)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const base = repoPath(args.owner, args.repo);
        const ref = args.ref ?? (await gh<Repo>(base)).default_branch;
        const tree = await gh<{ tree: TreeEntry[]; truncated: boolean }>(`${base}/git/trees/${encodeURIComponent(ref)}`, { recursive: 1 });
        const prefix = args.path?.replace(/^\/+|\/+$/g, "") ?? "";
        const { text, shown, hidden } = renderTree(tree.tree, prefix, args.max_depth, args.max_entries);

        if (shown === 0) {
          return prefix ? `No files under "${prefix}" at ${ref}. Check the path with a smaller max_depth from the root.` : `The repository is empty at ${ref}.`;
        }
        const lines = [`${args.owner}/${args.repo} @ ${ref}${prefix ? ` : ${prefix}/` : ""}`, "", text];
        if (hidden > 0) lines.push("", `${num(hidden)} more entries not shown. Increase max_depth or max_entries, or set path to a subfolder.`);
        if (tree.truncated) lines.push("Note: GitHub truncated this tree because the repository is very large. Use path to look at subfolders.");
        return lines.join("\n");
      })
  );

  server.registerTool(
    "get_file_contents",
    {
      title: "Get file contents",
      description:
        "Read one file from a repository (e.g. 'pom.xml', 'package.json', 'src/main.go'). If the path is a folder, lists its contents instead.",
      inputSchema: {
        ...ownerRepoShape,
        path: z.string().min(1).describe("File or folder path, e.g. 'package.json'"),
        ref: z.string().optional().describe("Branch, tag or commit SHA (default: the default branch)"),
        max_chars: z.number().int().min(200).max(200_000).default(20_000).describe("Maximum characters to return (default 20,000)"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const path = `${repoPath(args.owner, args.repo)}/contents/${encodePath(args.path)}`;
        const data = await gh<ContentEntry | ContentEntry[]>(path, { ref: args.ref });

        if (Array.isArray(data)) {
          const sorted = [...data].sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
          const lines = [`Folder ${args.path} (${data.length} entries):`];
          for (const e of sorted) lines.push(e.type === "dir" ? `  ${e.name}/` : `  ${e.name} (${formatSize(e.size)})`);
          return lines.join("\n");
        }
        if (data.type === "symlink") return `${data.path} is a symlink to ${data.target}.`;
        if (data.type === "submodule") return `${data.path} is a git submodule: ${data.submodule_git_url}`;

        let buf: Buffer;
        if (data.content && data.encoding === "base64") {
          buf = decodeBase64(data.content);
        } else {
          // Files over 1 MB come back without content; fetch the raw bytes instead.
          const raw = await gh<string>(path, { ref: args.ref }, { accept: "application/vnd.github.raw+json" });
          buf = Buffer.from(raw, "utf8");
        }
        if (isBinary(buf)) return `${data.path} is a binary file (${formatSize(data.size)}); its contents are not shown.`;
        return `${data.path} (${formatSize(data.size)})\n\n${truncate(buf.toString("utf8"), args.max_chars)}`;
      })
  );

  server.registerTool(
    "list_issues",
    {
      title: "List issues",
      description: "List issues in a repository (pull requests are excluded). Filter by state and labels.",
      inputSchema: {
        ...ownerRepoShape,
        state: z.enum(["open", "closed", "all"]).default("open"),
        labels: z.array(z.string().min(1)).max(10).optional().describe("Must have ALL of these labels"),
        sort: z.enum(["created", "updated", "comments"]).default("created"),
        direction: z.enum(["desc", "asc"]).default("desc"),
        ...pagingShape(20),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        // The issues endpoint mixes in pull requests, so walk pages and filter them out.
        const MAX_PAGES = 5;
        const wanted = args.offset + args.limit;
        const issues: Issue[] = [];
        let page = 1;
        let exhausted = false;
        while (issues.length < wanted && page <= MAX_PAGES) {
          const batch = await gh<Issue[]>(`${repoPath(args.owner, args.repo)}/issues`, {
            state: args.state,
            labels: args.labels?.join(","),
            sort: args.sort,
            direction: args.direction,
            per_page: 100,
            page,
          });
          issues.push(...batch.filter((it) => !it.pull_request));
          if (batch.length < 100) {
            exhausted = true;
            break;
          }
          page++;
        }

        const items = issues.slice(args.offset, wanted);
        if (items.length === 0) {
          return exhausted
            ? `No ${args.state === "all" ? "" : `${args.state} `}issues found in ${args.owner}/${args.repo}${args.labels?.length ? ` with labels ${args.labels.join(", ")}` : ""}.`
            : "No issues in the first 500 items scanned (the rest may be pull requests). Use search_issues_and_prs with repo set to search deeper.";
        }
        const lines = [`${args.owner}/${args.repo} issues (${args.state}), ${args.offset + 1}-${args.offset + items.length}:`, ""];
        items.forEach((it, i) => lines.push(...issueLines(it, args.offset + i + 1)));
        if (!exhausted || issues.length > wanted) lines.push(`More may be available: call again with offset=${args.offset + items.length}.`);
        return lines.join("\n").trim();
      })
  );

  server.registerTool(
    "list_pull_requests",
    {
      title: "List pull requests",
      description: "List pull requests in a repository. Filter by state and target branch.",
      inputSchema: {
        ...ownerRepoShape,
        state: z.enum(["open", "closed", "all"]).default("open"),
        base: z.string().optional().describe("Only PRs targeting this branch, e.g. 'main'"),
        sort: z.enum(["created", "updated", "popularity", "long-running"]).default("created"),
        direction: z.enum(["desc", "asc"]).default("desc"),
        ...pagingShape(20),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const { items } = await fetchRange<PullRequest>(
          `${repoPath(args.owner, args.repo)}/pulls`,
          { state: args.state, base: args.base, sort: args.sort, direction: args.direction },
          args.offset,
          args.limit,
          (data: PullRequest[]) => ({ items: data })
        );
        if (items.length === 0) return `No ${args.state === "all" ? "" : `${args.state} `}pull requests found in ${args.owner}/${args.repo}.`;

        const lines = [`${args.owner}/${args.repo} pull requests (${args.state}), ${args.offset + 1}-${args.offset + items.length}:`, ""];
        items.forEach((pr, i) => {
          lines.push(`${args.offset + i + 1}. [${prState(pr)}] #${pr.number} ${oneLine(pr.title, 160)}`);
          lines.push(`   ${pr.head.label} -> ${pr.base.ref} · by ${pr.user?.login ?? "unknown"} · created ${day(pr.created_at)} · updated ${day(pr.updated_at)}`);
          lines.push(`   ${pr.html_url}`, "");
        });
        if (items.length === args.limit) lines.push(`More may be available: call again with offset=${args.offset + items.length}.`);
        return lines.join("\n").trim();
      })
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "Get pull request",
      description: "Details for one pull request: status, branches, size, description and the list of changed files.",
      inputSchema: {
        ...ownerRepoShape,
        number: z.number().int().min(1).describe("Pull request number"),
        include_files: z.boolean().default(true).describe("List changed files (up to 100)"),
        body_max_chars: z.number().int().min(100).max(50_000).default(3000).describe("Maximum description characters"),
      },
      annotations: readOnly,
    },
    async (args) =>
      run(async () => {
        const base = `${repoPath(args.owner, args.repo)}/pulls/${args.number}`;
        const [pr, files] = await Promise.all([
          gh<PullRequest>(base),
          args.include_files
            ? gh<Array<{ filename: string; status: string; additions: number; deletions: number; previous_filename?: string }>>(`${base}/files`, {
                per_page: 100,
              })
            : Promise.resolve(null),
        ]);

        const lines = [
          `# PR #${pr.number}: ${pr.title}`,
          `Status: ${prState(pr)} · ${pr.head.label} -> ${pr.base.ref} · by ${pr.user?.login ?? "unknown"}`,
          `Created ${day(pr.created_at)} · updated ${day(pr.updated_at)}${pr.merged_at ? ` · merged ${day(pr.merged_at)}` : pr.closed_at ? ` · closed ${day(pr.closed_at)}` : ""}`,
          `Size: +${num(pr.additions ?? 0)} -${num(pr.deletions ?? 0)} in ${num(pr.changed_files ?? 0)} files, ${num(pr.commits ?? 0)} commits · comments: ${num(
            (pr.comments ?? 0) + (pr.review_comments ?? 0)
          )}`,
        ];
        if (pr.labels?.length) lines.push(`Labels: ${pr.labels.map((l) => l.name).join(", ")}`);
        if (pr.requested_reviewers?.length) lines.push(`Requested reviewers: ${pr.requested_reviewers.map((r) => r.login).join(", ")}`);
        lines.push(pr.html_url, "", "## Description", pr.body?.trim() ? truncate(pr.body.trim(), args.body_max_chars) : "(no description)");

        if (files) {
          const code: Record<string, string> = { added: "A", removed: "D", modified: "M", renamed: "R", copied: "C", changed: "M" };
          lines.push("", `## Changed files${files.length === 100 ? " (first 100)" : ""}`);
          for (const f of files) {
            const name = f.status === "renamed" && f.previous_filename ? `${f.previous_filename} -> ${f.filename}` : f.filename;
            lines.push(`${code[f.status] ?? "?"} ${name} (+${f.additions} -${f.deletions})`);
          }
        }
        return lines.join("\n");
      })
  );
}
