// Version helpers for security checks. GitHub normalizes every advisory range to clauses like
// ">= 4.0.0, < 4.17.21", so one comparator serves npm, pip, Maven, Go, Cargo and Composer versions.

export const ECOSYSTEMS = ["npm", "pip", "maven", "go", "rust", "composer", "rubygems", "nuget", "pub", "erlang", "swift", "actions"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

/** The version to check against advisories, or null with the reason it cannot be checked. */
export interface Resolved {
  version: string | null;
  exact: boolean;
  note?: string;
}

type Token = number | string;

// Maven release qualifiers that mean "final release", not a pre-release.
const RELEASE_WORDS = new Set(["final", "ga", "release"]);

function tokens(version: string): Token[] {
  const core = version.trim().replace(/^[v=\s]+/i, "").split("+")[0];
  return (core.match(/\d+|[a-z]+/gi) ?? [])
    .map((t) => (/^\d+$/.test(t) ? Number(t) : t.toLowerCase()))
    .filter((t) => !RELEASE_WORDS.has(String(t)));
}

/** Negative when a < b, 0 when equal, positive when a > b. Pre-releases ("2.0-alpha1", "6.0a1") sort before the release. */
export function compareVersions(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  for (let i = 0; i < Math.max(ta.length, tb.length); i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined || y === undefined) {
      const rest = (x === undefined ? tb : ta).slice(i);
      const next = rest.find((t) => t !== 0);
      if (next === undefined) return 0; // "1.0" equals "1.0.0"
      const restIsPreRelease = typeof next === "string";
      return x === undefined ? (restIsPreRelease ? 1 : -1) : restIsPreRelease ? -1 : 1;
    }
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    if (typeof x === "string" && typeof y === "string") return x < y ? -1 : 1;
    return typeof x === "string" ? -1 : 1;
  }
  return 0;
}

/** Whether version falls in a GitHub advisory range such as ">= 4.0.0, < 4.17.21". A missing range means all versions. */
export function inRange(version: string, range: string | null | undefined): boolean {
  if (!range?.trim()) return true;
  return range.split(",").every((clause) => {
    const m = clause.trim().match(/^(>=|<=|>|<|=)?\s*(.+)$/);
    if (!m) return true;
    const c = compareVersions(version, m[2]);
    switch (m[1]) {
      case ">=":
        return c >= 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}

const VERSION_TOKEN = /(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?/;
const NOT_REGISTRY = /^(file:|link:|workspace:|portal:|git\+|git:|github:|gitlab:|bitbucket:|https?:|[\w.-]+\/[\w.-]+(#.*)?$)/;

/**
 * npm, Composer and Cargo ranges (^1.2.0, ~1.2, >=1.2 <2, 1.2.x, "1.0 - 2.0"): the lowest version the range allows.
 * Cargo treats a bare "1.2.3" as a caret range, so only "=1.2.3" is exact there.
 */
export function resolveSemverRange(spec: string, ecosystem: "npm" | "composer" | "rust"): Resolved {
  let s = spec.trim();
  if (ecosystem === "composer") s = s.replace(/@[a-z]+$/i, "");
  if (!s || s === "*" || /^(latest|next|x)$/i.test(s)) return { version: null, exact: false, note: "any version" };
  if (ecosystem === "composer" && /^dev-|-dev$/i.test(s)) return { version: null, exact: false, note: "development branch" };
  if (ecosystem === "npm" && NOT_REGISTRY.test(s)) return { version: null, exact: false, note: "not from the registry" };
  const first = s.split("||")[0].trim();
  if (/^</.test(first)) return { version: null, exact: false, note: "no lower bound" };
  const m = first.match(VERSION_TOKEN);
  if (!m) return { version: null, exact: false, note: "unrecognized version" };
  const part = (p: string | undefined) => (p === undefined || /^[xX*]$/.test(p) ? "0" : p);
  const version = `${m[1]}.${part(m[2])}.${part(m[3])}${m[4] ?? ""}`;
  const exact = ecosystem === "rust" ? /^=\s*\d+\.\d+\.\d+\S*$/.test(first) : /^=?v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(first);
  return { version, exact };
}

/** PEP 440 specifiers (==1.2.3, >=1.2,<2, ~=1.4, ==1.2.*): the pinned version, or the highest lower bound. */
export function resolvePipSpec(spec: string): Resolved {
  const s = spec.trim().replace(/^\((.*)\)$/, "$1");
  if (!s) return { version: null, exact: false, note: "any version" };
  let lower: string | null = null;
  for (const clause of s.split(",")) {
    const m = clause.trim().match(/^(===|==|~=|!=|<=|>=|<|>)\s*(.+)$/);
    if (!m) continue;
    const [, op, v] = m;
    if ((op === "==" || op === "===") && !v.includes("*")) return { version: v, exact: true };
    if (op === "==" || op === "~=" || op === ">=" || op === ">") {
      const candidate = v.replace(/\.\*$/, "");
      if (!lower || compareVersions(candidate, lower) > 0) lower = candidate;
    }
  }
  return lower ? { version: lower, exact: false } : { version: null, exact: false, note: "no lower bound" };
}

/** Poetry constraints: a bare "1.2.3" is exact, ^ and ~ work like npm, anything else is PEP 440. */
export function resolvePoetrySpec(spec: string): Resolved {
  const s = spec.trim();
  if (/^\d[\w.-]*$/.test(s)) return { version: s, exact: true };
  if (/^[\^~](?!=)/.test(s) || s === "*") return resolveSemverRange(s, "npm");
  return resolvePipSpec(s);
}

/** Maven: "1.2.3" (exact), "[1.2.3]" (exact), "[1.0,2.0)" (lowest bound). */
export function resolveMavenSpec(spec: string): Resolved {
  const s = spec.trim();
  if (!s) return { version: null, exact: false, note: "version managed by a parent POM or BOM" };
  if (s.includes("${")) return { version: null, exact: false, note: `unresolved property ${s}` };
  const range = s.match(/^[[(]\s*([^,\])]*)\s*(,)?/);
  if (!range) return { version: s, exact: true };
  if (!range[2]) return { version: range[1], exact: true };
  return range[1] ? { version: range[1], exact: false } : { version: null, exact: false, note: "no lower bound" };
}

/** Package names as the advisory database stores them. pip names are case- and separator-insensitive (PEP 503). */
export function packageKey(ecosystem: Ecosystem, name: string): string {
  return ecosystem === "pip" ? name.toLowerCase().replace(/[-_.]+/g, "-") : name.toLowerCase();
}

/**
 * Spellings to send in the advisories query. GitHub matches pip names case-sensitively and advisories use both
 * "Django" and "django", so pip packages are queried under each spelling.
 */
export function queryNames(ecosystem: Ecosystem, name: string): string[] {
  if (ecosystem !== "pip") return [name];
  return [...new Set([name, name.toLowerCase(), packageKey("pip", name)])];
}
