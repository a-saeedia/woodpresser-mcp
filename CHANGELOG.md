# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Startup guard: on Node older than 22 the CLI and server exit immediately with
  the version they found and the upgrade command, instead of a link error naming
  an export the user has never heard of.
- `doctor` explains a rejected login instead of echoing the status code: it
  separates a wrong Application Password from a host that strips the
  `Authorization` header, and prints the `curl` line and `.htaccess` rule that
  tell them apart. Bridge failures point at `bridge claim`.
- `init` warns when the site URL is plain HTTP, because Application Passwords are
  only offered over HTTPS (or with `WP_ENVIRONMENT_TYPE=local`).
- `WpError` hints are code-aware now: `woodpresser_bad_token`,
  `woodpresser_not_claimed`, `application_passwords_disabled`, `rest_no_route`,
  `rest_forbidden` and network failures each name their fix.
- Tests: a fake WordPress exercises the 401 / unreachable / bad-token /
  missing-route paths of `doctor`, and a config test proves the token survives a
  re-init across an `http`→`https` change (43 unit tests total).

- `init` writes `woodpresser-bridge.zip` alongside the plugin file and prints the
  wp-admin upload URL. wp-admin only accepts archives, so the old "upload this
  .php" instruction was a dead end for anyone without SFTP. `woodpresser bridge
  copy` writes the same pair.
- `src/util/zip.ts` — the ZIP writer is now shared by the CLI and
  `scripts/zip-bridge.mjs`, with tests covering the archive structure, CRCs and
  the folder layout wp-admin expects.

### Changed

- `init` reuses the bridge token already stored for that URL instead of minting a
  new one. Re-running init was rotating the token and breaking every other
  machine pointed at the site; `--token` forces a rotation.
- A site record with no `modes` now falls back to `core` only. The old fallback
  enabled everything, so a hand-edited config could hand a model PHP execution.
- README leads with the install form that works today
  (`npm i -g github:a-saeedia/woodpresser-mcp`); `npx` takes over once the
  package is on the registry.
- `npm run bridge:zip` builds first, so there is one implementation of the
  archive writer rather than two.

## [0.1.0] — 2026-10-20

First public release.

### Added

- MCP server over stdio exposing 39 WordPress tools in three mode-gated groups:
  `core` (19), `php` (11, requires the bridge) and `elementor` (9).
- Companion bridge plugin, `bridge/woodpresser-bridge.php` — one file, no
  Composer, PHP >= 7.4 — providing PHP evaluation with captured output, SQL,
  a filesystem jail under `wp-content`, snippet management, Elementor snapshot
  history and an audit log (JSONL locally, `{prefix}woodpresser_audit` on site).
- `woodpresser` CLI: `init`, `mcp`, `doctor`, `tools`, `sites`, `bridge`,
  `install-mcp`, `uninstall-mcp`, `version`.
- Comment-preserving MCP registration for opencode, Claude Code and VS Code, with
  a `.woodpresser.bak` written before every edit.
- `woodpresser-bridge.zip` build (`npm run bridge:zip`, dependency-free, uses
  `zlib.crc32`) for the WordPress "Upload Plugin" flow.
- Unit tests (33) and a WordPress Playground integration suite (54 assertions)
  that boots real PHP in WASM — no Docker, no PHP install.
- GitHub Actions on ubuntu and windows, Node 22 and 24, including a check that
  the packaged tarball installs and runs from an empty prefix.

### Changed

- New sites default to `core` mode. `php` and `elementor` are opt-in at `init`
  time, in `~/.woodpresser/config.json`, or via `WOODPRESSER_MODES`; the bridge
  token is root-equivalent on the site, so it should not arrive by pressing
  Enter.

### Fixed

- `WITH ... DELETE/UPDATE/INSERT` was classified as a read, so a CTE could write
  even with `allow_db_write` off. Keyword sniffing now runs on a copy with
  string literals and comments stripped, and a CTE counts as a write when a
  write verb follows it.
- The filesystem tool rejected every path on hosts where `wp-content` is a
  symlink, because `realpath()` output was compared against the unresolved
  `WP_CONTENT_DIR`. Paths are now compared against `realpath()`, case-folded on
  Windows.
- `execute_php` leaked its output buffer when a snippet threw; the buffer is now
  drained in a `finally` block.
- The CLI now survives a closed stdout pipe (EPIPE) instead of exiting 1, which
  is what made `woodpresser tools | grep -q …` fail in CI.

[Unreleased]: https://github.com/a-saeedia/woodpresser-mcp/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/a-saeedia/woodpresser-mcp/releases/tag/v0.1.0
