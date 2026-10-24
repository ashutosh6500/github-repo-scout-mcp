# Changelog

## 0.3.1 - 2026-10-24

### Changed

- The npm page now links to the GitHub repository, issue tracker and GitHub Sponsors page. `npm fund` shows the sponsor link.
- The package description and keywords now mention the security tools, so npm search finds them.

## 0.3.0 - 2026-10-24

### Added

- **Security toolkit.** Three new tools with a shared `security_` prefix. The server tells the AI to use them together for security questions about a repository.
  - `security_advisories`: known vulnerabilities and malware reports for one package from the GitHub Advisory Database. Shows severity, CVE, affected and fixed versions, and the chance of exploitation (EPSS). With a version, it says which version to upgrade to.
  - `security_audit_dependencies`: checks every dependency in a repository's `package.json`, `requirements.txt`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml` or `composer.json` against the same database, without cloning it.
  - `security_supply_chain_risk`: looks for the warning signs behind attacks like xz-utils and event-stream. Checks the bus factor, a newcomer suddenly taking over, a dormant package suddenly releasing again, branch protection, commit and release signing, the security policy, private vulnerability reporting and Dependabot or Renovate. Also includes the OpenSSF Scorecard result.

## 0.2.0 - 2026-10-24

### Security

- **Fixed:** tool calls could reach GitHub API endpoints other than the requested repository. A `..` in `owner`, `repo`, `path` or `ref` let a tool call another endpoint with your token. For example, `get_file_contents` with path `../../../../user/repos` listed the token owner's private repositories. Paths containing `.` or `..` segments are now rejected. All 0.1.0 users should upgrade.
- The server now warns at startup if your Node.js version still trusts the compromised eMudhra certificates. On those versions, someone could intercept your traffic to GitHub, including your token.
- The server now tells the AI model that READMEs, files, issues and pull requests are written by third parties, and should be treated as data, never as instructions. This reduces the risk of prompt injection from repository content.
- Now requires zod 4.6.6 or newer, which fixes a memory exhaustion issue ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).

### Changed

- **Requires Node.js 22.23.4, 24.22.1, 26.12.1 or newer** (previously 18 or newer). These releases stop trusting the compromised eMudhra certificates. Node.js 18 and 20 are end-of-life and will not get the fix. On older versions the server still runs, but npm and the server both print a warning.

### Development

- `npm test` now works on Node.js 22 and newer.
- `npm run smoke` now also tests `get_pull_request`.

## 0.1.0 - 2026-10-06

First release.
