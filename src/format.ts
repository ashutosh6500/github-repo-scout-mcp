import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GitHubError } from "./github.js";

export interface Repo {
  full_name: string;
  owner?: { login: string; type?: string };
  private?: boolean;
  description: string | null;
  html_url: string;
  homepage: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  subscribers_count?: number;
  language: string | null;
  license: { spdx_id: string | null; name: string } | null;
  topics?: string[];
  archived: boolean;
  fork: boolean;
  parent?: { full_name: string };
  created_at: string;
  pushed_at: string;
  default_branch: string;
}

export const ownerRepoShape = {
  owner: z.string().min(1).describe("Repository owner (user or organization), e.g. 'spring-projects'"),
  repo: z.string().min(1).describe("Repository name, e.g. 'spring-boot'"),
};

export function pagingShape(defaultLimit: number) {
  return {
    limit: z.number().int().min(1).max(100).default(defaultLimit).describe(`Number of results to return (1-100, default ${defaultLimit})`),
    offset: z.number().int().min(0).default(0).describe("Number of results to skip, for paging (default 0)"),
  };
}

export const dateShape = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date in YYYY-MM-DD format");

export async function run(fn: () => Promise<string>): Promise<CallToolResult> {
  try {
    return { content: [{ type: "text", text: await fn() }] };
  } catch (err) {
    const message = err instanceof GitHubError ? err.message : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

export function num(n: number): string {
  return n.toLocaleString("en-US");
}

export function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "n/a";
}

export function daysSince(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

export function ago(iso: string): string {
  const d = daysSince(iso);
  if (d <= 0) return "today";
  if (d === 1) return "1 day ago";
  if (d < 60) return `${d} days ago`;
  if (d < 730) return `${Math.round(d / 30)} months ago`;
  return `${(d / 365).toFixed(1)} years ago`;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated: showing ${num(max)} of ${num(text.length)} characters]`;
}

export function oneLine(text: string | null | undefined, max = 200): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function licenseName(repo: Repo): string {
  const id = repo.license?.spdx_id;
  return id && id !== "NOASSERTION" ? id : repo.license ? "other" : "none";
}

export function repoSummary(repo: Repo, index?: number): string {
  const flags = [repo.archived ? "ARCHIVED" : "", repo.fork ? "fork" : ""].filter(Boolean).join(", ");
  const head = `${index !== undefined ? `${index}. ` : ""}${repo.full_name}  ★ ${num(repo.stargazers_count)} · forks ${num(
    repo.forks_count
  )} · open issues+PRs ${num(repo.open_issues_count)} · ${repo.language ?? "no language"} · ${licenseName(repo)} · pushed ${day(repo.pushed_at)}${
    flags ? ` · ${flags}` : ""
  }`;
  const lines = [head];
  const desc = oneLine(repo.description);
  if (desc) lines.push(`   ${desc}`);
  if (repo.topics?.length) lines.push(`   topics: ${repo.topics.join(", ")}`);
  lines.push(`   ${repo.html_url}`);
  return lines.join("\n");
}

export function pageFooter(offset: number, shown: number, total: number | undefined, searchCap = false): string {
  const lines: string[] = [];
  if (total !== undefined && offset + shown < total) {
    if (searchCap && offset + shown >= 1000) {
      lines.push("GitHub search returns at most the first 1,000 results. Add filters to reach the rest.");
    } else {
      lines.push(`More results available: call again with offset=${offset + shown}.`);
    }
  }
  return lines.join("\n");
}

export function parseRepoRef(ref: string): { owner: string; repo: string } {
  const cleaned = ref
    .trim()
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  const [owner, repo] = cleaned.split("/");
  if (!owner || !repo) throw new GitHubError(`"${ref}" is not a repository reference. Use "owner/repo" or a github.com URL.`, 400);
  return { owner, repo };
}
