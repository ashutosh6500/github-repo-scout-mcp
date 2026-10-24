import { createRequire } from "node:module";
import { mockResponse } from "./mock.js";

const require = createRequire(import.meta.url);
export const VERSION: string = require("../package.json").version;

export const token = process.env.GITHUB_TOKEN?.trim() || process.env.GITHUB_PAT?.trim() || undefined;
export const isMock = process.env.MOCK === "true";
const API_URL = (process.env.GITHUB_API_URL?.trim() || "https://api.github.com").replace(/\/+$/, "");
/** False for GitHub Enterprise Server, whose repositories public services like OpenSSF Scorecard do not cover. */
export const usesPublicGitHub = API_URL === "https://api.github.com";

// First release on each supported line that rejects chains through the eight compromised
// eMudhra intermediates (October 2026). Older lines (18, 20) are end-of-life and never got the fix.
const PATCHED_NODE: Record<number, [minor: number, patch: number]> = { 22: [23, 4], 24: [22, 1], 26: [12, 1] };
export const PATCHED_NODE_VERSIONS = "22.23.4, 24.22.1 or 26.12.1";

/** True when this Node build no longer trusts the compromised eMudhra certificates. */
export function hasPatchedTrustStore(version: string = process.versions.node): boolean {
  const [major, minor, patch] = version.replace(/^v/, "").split(".").map(Number);
  if (major > 26) return true;
  const fixed = PATCHED_NODE[major];
  if (!fixed) return false;
  return minor > fixed[0] || (minor === fixed[0] && patch >= fixed[1]);
}

export class GitHubError extends Error {
  constructor(message: string, readonly status: number, readonly rateLimited = false) {
    super(message);
  }
}

type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

interface RequestOptions {
  accept?: string;
}

interface CachedResponse {
  data: unknown;
  link: string | null;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map<string, { expires: number; value: CachedResponse }>();

export function buildUrl(path: string, query: Query): string {
  // encodeURIComponent leaves "." alone, so a ".." in owner, repo, path or ref would let URL parsing
  // walk out of /repos/... to any other endpoint (e.g. /user/repos) while sending the token.
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new GitHubError(`Invalid path "${path}": "." and ".." segments are not allowed in owner, repo, path or ref.`, 400);
  }
  const url = new URL(API_URL + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function toError(res: Response, path: string): Promise<GitHubError> {
  let message = res.statusText;
  let details = "";
  try {
    const body = (await res.json()) as { message?: string; errors?: Array<{ message?: string; code?: string }> };
    if (body.message) message = body.message;
    if (body.errors?.length) {
      details = " " + body.errors.map((e) => e.message ?? e.code).filter(Boolean).join("; ");
    }
  } catch {
    // non-JSON error body
  }

  const remaining = res.headers.get("x-ratelimit-remaining");
  const reset = res.headers.get("x-ratelimit-reset");
  const retryAfter = res.headers.get("retry-after");
  const isRateLimit =
    (res.status === 403 || res.status === 429) &&
    (remaining === "0" || retryAfter !== null || /rate limit/i.test(message));

  if (isRateLimit) {
    let minutes: number | null = null;
    if (retryAfter) minutes = Math.ceil(Number(retryAfter) / 60);
    else if (reset) minutes = Math.ceil((Number(reset) * 1000 - Date.now()) / 60000);
    let text = `GitHub rate limit exceeded${minutes !== null ? `; resets in about ${Math.max(1, minutes)} min` : ""}.`;
    if (!token) {
      text +=
        " Set GITHUB_TOKEN (a token with no scopes is enough) to raise limits from 60 to 5,000 requests/hour and from 10 to 30 searches/minute.";
    }
    return new GitHubError(text, res.status, true);
  }
  if (res.status === 401) {
    return new GitHubError("GitHub rejected the token in GITHUB_TOKEN/GITHUB_PAT (401 Bad credentials). Fix or remove it.", 401);
  }
  if (res.status === 404) {
    return new GitHubError(
      `Not found: ${path}. Check the owner, repo, path or ref spelling${token ? "" : " (private repositories need a token with access)"}.`,
      404
    );
  }
  return new GitHubError(`GitHub API error ${res.status}: ${message}${details}`, res.status);
}

export async function request(path: string, query: Query = {}, options: RequestOptions = {}): Promise<CachedResponse> {
  if (isMock) return mockResponse(path, query);

  const url = buildUrl(path, query);
  const accept = options.accept ?? "application/vnd.github+json";
  const key = `${accept} ${url}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  const headers: Record<string, string> = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `github-repo-scout-mcp/${VERSION}`,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new GitHubError(`Could not reach ${API_URL}: ${(err as Error).message}`, 0);
  }
  if (!res.ok) throw await toError(res, path);

  const isJson = (res.headers.get("content-type") ?? "").includes("json");
  const data = res.status === 204 ? null : isJson ? await res.json() : await res.text();
  const value: CachedResponse = { data, link: res.headers.get("link") };

  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

export async function gh<T>(path: string, query: Query = {}, options: RequestOptions = {}): Promise<T> {
  return (await request(path, query, options)).data as T;
}

/** Returns null when the resource is missing or unavailable, but still throws on rate limits and auth errors. */
export async function ghOptional<T>(path: string, query: Query = {}): Promise<{ data: T; link: string | null } | null> {
  try {
    const res = await request(path, query);
    return res.data === null ? null : { data: res.data as T, link: res.link };
  } catch (err) {
    if (err instanceof GitHubError && !err.rateLimited && [403, 404, 409, 422].includes(err.status)) return null;
    throw err;
  }
}

export function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/**
 * Fetches items [offset, offset+limit) from a paginated endpoint. Uses one request when offset is a
 * multiple of limit, otherwise walks 100-item pages.
 */
export async function fetchRange<T>(
  path: string,
  query: Query,
  offset: number,
  limit: number,
  extract: (data: any) => { items: T[]; total?: number; incomplete?: boolean },
  options: RequestOptions = {}
): Promise<{ items: T[]; total?: number; incomplete?: boolean }> {
  const perPage = offset % limit === 0 ? limit : 100;
  const firstPage = Math.floor(offset / perPage) + 1;
  const lastPage = Math.floor((offset + limit - 1) / perPage) + 1;

  const collected: T[] = [];
  let total: number | undefined;
  let incomplete = false;
  for (let page = firstPage; page <= lastPage; page++) {
    const data = await gh<unknown>(path, { ...query, per_page: perPage, page }, options);
    const result = extract(data);
    total ??= result.total;
    incomplete ||= Boolean(result.incomplete);
    collected.push(...result.items);
    if (result.items.length < perPage) break;
  }
  const start = offset - (firstPage - 1) * perPage;
  return { items: collected.slice(start, start + limit), total, incomplete };
}
