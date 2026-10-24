import {
  resolveMavenSpec,
  resolvePipSpec,
  resolvePoetrySpec,
  resolveSemverRange,
  type Ecosystem,
  type Resolved,
} from "./versions.js";

export interface Dependency extends Resolved {
  name: string;
  /** The constraint as written in the manifest. */
  spec: string;
  /** Dev, test or optional dependency. */
  dev: boolean;
}

export interface Manifest {
  file: string;
  ecosystem: Ecosystem;
  deps: Dependency[];
}

export const MANIFESTS: Record<string, Ecosystem> = {
  "package.json": "npm",
  "requirements.txt": "pip",
  "pyproject.toml": "pip",
  "go.mod": "go",
  "Cargo.toml": "rust",
  "pom.xml": "maven",
  "composer.json": "composer",
};

export function parseManifest(file: string, text: string): Manifest {
  const name = file.split("/").pop()!;
  const ecosystem = MANIFESTS[name];
  if (!ecosystem) throw new Error(`${name} is not a supported manifest. Supported: ${Object.keys(MANIFESTS).join(", ")}.`);
  const parse: Record<string, (text: string) => Dependency[]> = {
    "package.json": parsePackageJson,
    "requirements.txt": parseRequirements,
    "pyproject.toml": parsePyproject,
    "go.mod": parseGoMod,
    "Cargo.toml": parseCargoToml,
    "pom.xml": parsePom,
    "composer.json": parseComposerJson,
  };
  return { file, ecosystem, deps: dedupe(parse[name](text)) };
}

/** Keeps the first entry per package, so a runtime dependency wins over the same package listed as dev. */
function dedupe(deps: Dependency[]): Dependency[] {
  const seen = new Map<string, Dependency>();
  for (const d of deps) {
    const prev = seen.get(d.name);
    if (!prev || (prev.version === null && d.version !== null)) seen.set(d.name, prev ? { ...d, dev: prev.dev && d.dev } : d);
  }
  return [...seen.values()];
}

function jsonDeps(text: string, fields: Array<[string, boolean]>, resolve: (spec: string) => Resolved, skip = (_: string) => false): Dependency[] {
  const pkg = JSON.parse(text) as Record<string, unknown>;
  const out: Dependency[] = [];
  for (const [field, dev] of fields) {
    for (const [name, raw] of Object.entries((pkg[field] ?? {}) as Record<string, unknown>)) {
      if (skip(name) || typeof raw !== "string") continue;
      out.push({ name, spec: raw, dev, ...resolve(raw) });
    }
  }
  return out;
}

export function parsePackageJson(text: string): Dependency[] {
  const deps = jsonDeps(
    text,
    [
      ["dependencies", false],
      ["optionalDependencies", false],
      ["devDependencies", true],
    ],
    (spec) => resolveSemverRange(spec, "npm")
  );
  // "npm:real-name@^1.0.0" installs a different package under an alias.
  return deps.map((d) => {
    const alias = d.spec.match(/^npm:((?:@[^/@]+\/)?[^@]+)@?(.*)$/);
    return alias ? { ...d, name: alias[1], ...resolveSemverRange(alias[2] || "*", "npm") } : d;
  });
}

export function parseComposerJson(text: string): Dependency[] {
  return jsonDeps(
    text,
    [
      ["require", false],
      ["require-dev", true],
    ],
    (spec) => resolveSemverRange(spec, "composer"),
    // Platform requirements (php, ext-json, lib-icu, composer-plugin-api) are not packages.
    (name) => !name.includes("/")
  );
}

const PEP508 = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/;

function pep508(requirement: string, dev: boolean): Dependency | null {
  const m = requirement.trim().match(PEP508);
  if (!m) return null;
  const [, name, rest] = m;
  const spec = rest.split(";")[0].trim();
  if (spec.startsWith("@")) return { name, spec, dev, version: null, exact: false, note: "direct URL reference" };
  return { name, spec, dev, ...resolvePipSpec(spec) };
}

export function parseRequirements(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const raw of text.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").replace(/\s--?\w[\w-]*(=\S+)?/g, "").trim();
    // Options (-r other.txt, -e ., --index-url) and bare URLs are not package requirements.
    if (!line || line.startsWith("-") || /^[a-z]+:\/\//i.test(line)) continue;
    const dep = pep508(line, false);
    if (dep) out.push(dep);
  }
  return out;
}

interface TomlEntry {
  section: string;
  key: string;
  value: string;
}

function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function openBrackets(value: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  return depth;
}

/** Just enough TOML for dependency tables: section headers and key = value pairs, with multi-line arrays joined. */
export function tomlEntries(text: string): TomlEntry[] {
  const out: TomlEntry[] = [];
  const lines = text.split(/\r?\n/);
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = stripTomlComment(lines[i]).trim();
    if (!line) continue;
    const header = line.match(/^\[\[?\s*([^\]]+?)\s*\]\]?$/);
    if (header) {
      section = header[1].replace(/["'\s]/g, "");
      continue;
    }
    const kv = line.match(/^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2];
    while (openBrackets(value) > 0 && i + 1 < lines.length) value += "\n" + stripTomlComment(lines[++i]);
    out.push({ section, key: kv[1].replace(/^["']|["']$/g, ""), value: value.trim() });
  }
  return out;
}

function tomlStrings(value: string): string[] {
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
}

function inlineField(value: string, field: string): string | undefined {
  return value.match(new RegExp(`(?:^|[{,\\s])${field}\\s*=\\s*["']([^"']+)["']`))?.[1];
}

export function parsePyproject(text: string): Dependency[] {
  const out: Dependency[] = [];
  for (const { section, key, value } of tomlEntries(text)) {
    if ((section === "project" && key === "dependencies") || section === "project.optional-dependencies" || section === "dependency-groups") {
      const dev = section !== "project";
      for (const req of tomlStrings(value)) {
        const dep = pep508(req, dev);
        if (dep) out.push(dep);
      }
    } else if (section === "tool.poetry.dependencies" || section === "tool.poetry.dev-dependencies" || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)) {
      if (key === "python") continue;
      const dev = section !== "tool.poetry.dependencies";
      const spec = value.startsWith("{") ? inlineField(value, "version") : tomlStrings(value)[0];
      out.push(
        spec !== undefined
          ? { name: key, spec, dev, ...resolvePoetrySpec(spec) }
          : { name: key, spec: value, dev, version: null, exact: false, note: "not from the registry" }
      );
    }
  }
  return out;
}

export function parseCargoToml(text: string): Dependency[] {
  const out: Dependency[] = [];
  const tables = new Map<string, { dev: boolean; fields: Record<string, string> }>();
  for (const { section, key, value } of tomlEntries(text)) {
    // [dependencies], [dev-dependencies], [build-dependencies], [workspace.dependencies], [target.'cfg(..)'.dependencies]
    const inline = section.match(/^(?:workspace\.|target\..+\.)?(dev-|build-)?dependencies$/);
    if (inline) {
      const dev = Boolean(inline[1]);
      if (value.startsWith("{")) out.push(cargoDep(key, dev, { version: inlineField(value, "version"), package: inlineField(value, "package") }, value));
      else out.push(cargoDep(key, dev, { version: tomlStrings(value)[0] }, value));
      continue;
    }
    // [dependencies.serde] with version = "1" on the following lines
    const table = section.match(/^(?:target\..+\.)?(dev-|build-)?dependencies\.(.+)$/);
    if (table) {
      const entry = tables.get(table[2]) ?? { dev: Boolean(table[1]), fields: {} };
      entry.fields[key] = tomlStrings(value)[0] ?? value;
      tables.set(table[2], entry);
    }
  }
  for (const [name, { dev, fields }] of tables) out.push(cargoDep(name, dev, fields, JSON.stringify(fields)));
  return out;
}

function cargoDep(key: string, dev: boolean, fields: { version?: string; package?: string }, raw: string): Dependency {
  const name = fields.package ?? key;
  if (fields.version !== undefined) return { name, spec: fields.version, dev, ...resolveSemverRange(fields.version, "rust") };
  const note = /workspace\s*=\s*true/.test(raw) ? "version set in the workspace" : "not from the registry";
  return { name, spec: raw, dev, version: null, exact: false, note };
}

export function parseGoMod(text: string): Dependency[] {
  const out: Dependency[] = [];
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^require\s*\($/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ")") {
      inBlock = false;
      continue;
    }
    const m = inBlock ? line.match(/^(\S+)\s+(v\S+)(.*)$/) : line.match(/^require\s+(\S+)\s+(v\S+)(.*)$/);
    if (m) out.push({ name: m[1], spec: `${m[2]}${/\/\/\s*indirect/.test(m[3]) ? " (indirect)" : ""}`, dev: false, version: m[2], exact: true });
  }
  return out;
}

function xmlTag(block: string, tag: string): string | undefined {
  return block.match(new RegExp(`<${tag}>\\s*([^<]*?)\\s*</${tag}>`))?.[1];
}

export function parsePom(text: string): Dependency[] {
  // Build plugins and their own dependencies are not part of the application.
  const xml = text.replace(/<!--[\s\S]*?-->/g, "").replace(/<plugins>[\s\S]*?<\/plugins>/g, "");
  const props = new Map<string, string>();
  for (const block of xml.match(/<properties>[\s\S]*?<\/properties>/g) ?? []) {
    for (const m of block.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1], m[2]);
  }
  const project = xml.replace(/<parent>[\s\S]*?<\/parent>|<dependencies>[\s\S]*?<\/dependencies>|<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, "");
  const projectVersion = xmlTag(project, "version");
  if (projectVersion) props.set("project.version", projectVersion);
  const expand = (value: string) => {
    let out = value;
    for (let i = 0; i < 3 && out.includes("${"); i++) out = out.replace(/\$\{([^}]+)\}/g, (all, key: string) => props.get(key) ?? all);
    return out;
  };

  const out: Dependency[] = [];
  for (const m of xml.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const groupId = expand(xmlTag(m[1], "groupId") ?? "");
    const artifactId = expand(xmlTag(m[1], "artifactId") ?? "");
    if (!groupId || !artifactId) continue;
    const spec = xmlTag(m[1], "version") ?? "";
    const scope = xmlTag(m[1], "scope");
    // An "import" scope pulls in a BOM: a list of versions, not a dependency of its own.
    if (scope === "import") continue;
    out.push({ name: `${groupId}:${artifactId}`, spec: spec || "(managed)", dev: scope === "test", ...resolveMavenSpec(expand(spec)) });
  }
  return out;
}
