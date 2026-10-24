# github-repo-scout-mcp

A read-only MCP server for **finding and judging GitHub repositories** from your AI assistant. It works with no setup and no token.

Ask things like:

- "Find Java + Spring Boot banking projects with recent activity"
- "Is `some-org/some-lib` still maintained?"
- "Compare these three state-management libraries"
- "Show me repos similar to `modelcontextprotocol/python-sdk`"

## Why

GitHub search can combine several **topics** in one query (`topic:java topic:spring-boot topic:banking`), along with language, stars, last push date and license. Few people know this, and you need the exact topic names for it to work. This server:

- turns plain filters into the right search syntax and shows you the final query
- finds the exact topic names for a concept (`search_topics`)
- scores whether a repo is alive and well run (`get_repo_health`)
- compares repos side by side and finds similar ones
- returns short, readable results instead of GitHub's raw JSON, which carries about 40 URL fields per repo

It never writes to GitHub. Every tool is marked read-only.

## Install

### Claude Code

```bash
claude mcp add github-repo-scout -- npx -y github-repo-scout-mcp
```

With a token (optional, see below):

```bash
claude mcp add github-repo-scout -e GITHUB_TOKEN=ghp_yourtoken -- npx -y github-repo-scout-mcp
```

### Claude Desktop, Cursor and other MCP clients

Add this to your client's MCP config (for Claude Desktop, `claude_desktop_config.json`; for Cursor, `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "github-repo-scout": {
      "command": "npx",
      "args": ["-y", "github-repo-scout-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_yourtoken"
      }
    }
  }
}
```

Leave out the `env` block to run without a token.

## Token (optional)

Without a token everything except `search_code` works, within GitHub's limits for anonymous use. If you set `GITHUB_TOKEN` (or `GITHUB_PAT`), it is sent with **every** request.

| | No token | With token |
|---|---|---|
| Regular requests | 60 per hour | 5,000 per hour |
| Searches | 10 per minute | 30 per minute |
| `search_code` | not available (GitHub requires a token) | 10 per minute |

The token needs **no permissions**. All this server does is read, so the token only raises your limits. Create one at [github.com/settings/tokens](https://github.com/settings/tokens) in either of two ways:

- **Fine-grained token:** choose "Public repositories (read-only)" and add no permissions.
- **Classic token:** select no scopes.

If you want it to read your private repositories too, give it read access to them.

## Tools

### Search

| Tool | What it does | Key inputs |
|---|---|---|
| `search_repositories` | Search repos by any mix of filters. `query` keywords match name, description and topics; `topics` must all be exact tags on the repo. Archived repos are excluded by default. | `topics[]`, `query`, `language`, `min_stars`, `pushed_after`, `created_after`, `license`, `include_archived`, `sort`, `limit`, `offset` |
| `search_topics` | Find the exact topic names for a concept, e.g. "banking" gives `banking`, `open-banking`, `fintech` | `query`, `featured_only`, `curated_only` |
| `search_issues_and_prs` | Search issues or PRs everywhere or in one repo, e.g. by an error message | `query`, `type`, `state`, `repo`, `labels[]`, `language` |
| `search_code` | Search source code (needs a token) | `query`, `repo`, `owner`, `language`, `path`, `filename`, `extension` |

Each `search_repositories` result shows stars, forks, open issues + PRs, language, license, last push, archived/fork flags, description, topics and URL.

For attributes without a named input, add GitHub qualifiers to `query`: `org:NAME`, `user:NAME`, `forks:>=N`, `size:>=N` (KB), `topics:>=N`, `good-first-issues:>=N`, `help-wanted-issues:>=N`, `template:true`, `fork:true`, `mirror:false`, `in:readme`, or date ranges like `created:2025-01-01..2025-06-30`.

### Repository details

| Tool | What it does |
|---|---|
| `get_repository` | Stars, forks, language breakdown, license, topics, dates, latest release and the start of the README |
| `get_repo_tree` | The folder structure as an indented tree, with depth and subfolder controls |
| `get_file_contents` | Read one file (e.g. `pom.xml`, `package.json`), or list a folder |
| `list_issues` | Issues in a repo, without pull requests mixed in |
| `list_pull_requests` | Pull requests in a repo |
| `get_pull_request` | One PR's status, size, description and changed files |

### Evaluation

| Tool | What it does |
|---|---|
| `get_repo_health` | A 0-100 score with a breakdown (see below) and warnings |
| `compare_repositories` | 2-5 repos side by side, optionally with health scores |
| `find_similar_repositories` | Repos that share the most topics with a given repo, ranked by overlap and stars |

### Security

Ask "is this repo safe to use?" and the assistant calls these together.

| Tool | What it does | Key inputs |
|---|---|---|
| `security_advisories` | Known vulnerabilities and malware reports for one package: severity, CVE, affected and fixed versions, and the chance of exploitation (EPSS) | `ecosystem`, `package`, `version` |
| `security_audit_dependencies` | Checks every dependency a repo declares for known vulnerabilities and malware, without cloning it. Reads `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` and `composer.json` | `owner`, `repo`, `path`, `include_dev` |
| `security_supply_chain_risk` | Warning signs behind real supply chain attacks such as xz-utils and event-stream: one-person projects, a newcomer suddenly taking over, a dormant package suddenly releasing again, unprotected branches, no security policy, unsigned releases, plus the OpenSSF Scorecard result | `owner`, `repo` |

Limits to know:

- **Ranges are checked at their lowest version.** For `^4.17.0` the audit checks 4.17.0. A hit means the range allows a vulnerable version; your lockfile may already install a fixed one.
- **Only direct dependencies are checked,** not the packages they pull in.
- **No findings does not mean safe.** These tools report known advisories and public signals about how a project is run. They cannot detect malicious code nobody has reported yet.
- `security_supply_chain_risk` sends the repository name (never your token) to the public [OpenSSF Scorecard API](https://scorecard.dev). It skips this for private repositories and GitHub Enterprise Server.

## How the health score works

`get_repo_health` uses about 5 requests and adds up five parts:

| Part | Points | Full points when |
|---|---|---|
| Activity | 30 | last push within 30 days |
| Recent commits | 15 | 50+ commits on the default branch in 90 days |
| Releases | 15 | a release within 180 days |
| Contributors | 20 | 20+ contributors and no one person making half the commits |
| Community files | 20 | license, README, CONTRIBUTING, code of conduct, issue and PR templates |

80+ is "Healthy", 60-79 "Moderate", 40-59 "Weak", below 40 "Poor". Archived repos are capped at 20. The score shows whether a project is alive and well run. It does not judge code quality.

## Other settings

| Variable | Purpose |
|---|---|
| `GITHUB_TOKEN` or `GITHUB_PAT` | Optional token, sent on every request |
| `GITHUB_API_URL` | API base URL for GitHub Enterprise Server, e.g. `https://github.example.com/api/v3` |
| `MOCK=true` | Return built-in sample data with no network calls, for trying the server or testing |

Results are cached in memory for 5 minutes to save your rate limit.

## Development

```bash
npm install
npm test          # builds, then runs unit tests and end-to-end MCP tests in mock mode
npm run smoke     # calls each tool against the real GitHub API (about 20 requests)
```

Requires Node.js 22.23.4, 24.22.1 or 26.12.1 or newer. These releases (October 2026) stop trusting the compromised eMudhra certificates. Older Node versions could let someone intercept your traffic to GitHub, including your token. Node 18 and 20 are end-of-life and will not get the fix. On an older version the server still runs but prints a warning at startup.

## Support

If this server saves you time, you can [sponsor its development on GitHub](https://github.com/sponsors/ashutosh6500). Bug reports and feature requests are welcome in [issues](https://github.com/ashutosh6500/github-repo-scout-mcp/issues).

## License

MIT
