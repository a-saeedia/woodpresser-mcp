# Woodpresser

[![CI](https://github.com/a-saeedia/woodpresser-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/a-saeedia/woodpresser-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/woodpresser-mcp.svg)](https://www.npmjs.com/package/woodpresser-mcp)
[![node](https://img.shields.io/node/v/woodpresser-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A WordPress MCP server for coding agents.** Give Claude, opencode, Cursor or any MCP client structured access to a real WordPress site — content, plugins, PHP, the database, the filesystem, and Elementor page data — through one typed tool surface.

```
npx woodpresser-mcp init
```

You need three things: the site URL, a username, and an [Application Password](https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/). Everything else is automated.

---

## Why

WordPress is where a huge share of the web lives, but agents are bad at it. They guess at REST routes, paste PHP into the wrong file, or rewrite an Elementor page by hand-editing JSON they do not understand. Woodpresser gives them:

- **A typed tool surface** — 39 tools, Zod-validated, with descriptions written for a model, not a human.
- **Mode gating** — a content-only site never gets a PHP execution tool registered. No dead tools, no accidental damage.
- **A companion bridge plugin** for the things REST cannot do: evaluating PHP with captured output, running SQL, reading and writing files inside `wp-content`, managing snippet-like PHP, and reading/writing Elementor's `_elementor_data`.
- **Safety rails** — destructive tools require an explicit `confirm` literal, `wp_el_build` defaults to a dry run, every write is audited locally and on the site, and secrets are scrubbed from every payload before it reaches the transcript.

## Install

```bash
npm i -g github:a-saeedia/woodpresser-mcp
woodpresser init
```

That form works today and always builds from source (`prepare` runs `tsc`), so it needs `git` on PATH and about a minute. Once 0.1.0 is on the registry, `npm i -g woodpresser-mcp` and `npx woodpresser-mcp init` do the same thing faster.

Node >= 22 is the only prerequisite.

Install it globally. The MCP entry `install-mcp` writes contains an absolute path to the install, so a clone inside a temp directory works until something cleans temp and then your client cannot start the server.

After your credentials, `init` asks whether to enable **php + elementor**. The default is no: you get 19 content tools and nothing that can execute code. Answer `y` when you actually want PHP, SQL and filesystem access, or be explicit in a script with `--modes core,php,elementor`.

`init` walks through:

1. **Credentials** — verifies the Application Password against `/wp/v2/users/me`.
2. **Bridge detection** — probes `/wp-json/woodpresser/v1/ping`.
3. **Claim** — binds the bridge to your token (constant-time compared on the server).
4. **Config** — writes `~/.woodpresser/config.json` (mode `0600`).
5. **MCP registration** — adds the server to opencode, Claude Code and/or VS Code, preserving your comments and formatting.

If the bridge is not installed yet, `init` writes `woodpresser-bridge.php` to the current directory and prints the three-step upload. Re-run `woodpresser bridge claim` once it is active.

### Register only

```bash
woodpresser install-mcp --target all --scope user
woodpresser install-mcp --target opencode --scope project
woodpresser uninstall-mcp --target opencode
```

| Client | File | Key |
| --- | --- | --- |
| opencode | `~/.config/opencode/opencode.jsonc` (or project `opencode.jsonc`) | `mcp.<name>` |
| Claude Code | `~/.mcp.json` or `./.mcp.json` | `mcpServers.<name>` |
| VS Code | `./.vscode/mcp.json` | `servers.<name>` |

The entry looks like this:

```jsonc
{
  "mcp": {
    "woodpresser": {
      "type": "local",
      "command": ["C:/Program Files/nodejs/node.exe", "/path/to/woodpresser/dist/cli.js", "mcp", "--site", "example-com"],
      "enabled": true
    }
  }
}
```

Restart the client afterwards.

## The bridge plugin

The core REST API covers posts, media, terms, users, plugins, themes and settings. It cannot evaluate PHP, inspect the database, or touch files. The bridge fills that gap.

- **Single file.** `bridge/woodpresser-bridge.php`, no build step, no Composer.
- **Upload once.** `woodpresser init` writes `woodpresser-bridge.zip` next to you when the bridge is missing; upload it at **wp-admin → Plugins → Add New → Upload Plugin** and activate. The archive already contains the `woodpresser-bridge/` folder wp-admin expects. No SFTP needed; `npm run bridge:zip` builds the same file into `dist/`.
- **Or pin the token** in `wp-config.php` and skip the claim flow entirely:

```php
define( 'WOODPRESSER_TOKEN', 'your-token' );
```

The token source is reported by `wp_bridge_status` as `constant` or `option`.

### Authentication

Three factors, all required:

1. A valid WordPress user with `manage_options` (Application Password over Basic auth).
2. A matching `X-Woodpresser-Token`.
3. A per-user rate limit of 240 requests/minute.

The token is compared with `hash_equals`. Without `WOODPRESSER_TOKEN`, the first `POST /claim` stores it in an option; the route requires `manage_options`, so only an administrator can claim a fresh bridge.

## Modes

Set per site. A new site starts in `core` only; add `php` and/or `elementor` at init time (`--modes core,php,elementor`), in `~/.woodpresser/config.json`, or via `WOODPRESSER_MODES`.

A mode you did not enable registers no tools at all. The model cannot call what is not in its tool list, so the safest configuration is also the one with the smallest prompt.

| Mode | Tools | Use when |
| --- | --- | --- |
| `core` | 19 | Content editing, media, users, plugins, settings. No code execution. |
| `php` | 11 | PHP eval, SQL, filesystem, snippets, post meta, audit log. Requires the bridge. |
| `elementor` | 9 | Read, build, patch, snapshot and restore Elementor pages. |

Tools from a mode you did not enable are **not registered** — the model never sees them.

## Tools

### Core (`core`)
`wp_site_info` · `wp_health_check` · `wp_content_list` · `wp_content_get` · `wp_content_create` · `wp_content_update` · `wp_content_delete` · `wp_media_list` · `wp_media_upload` · `wp_terms_list` · `wp_term_create` · `wp_users_list` · `wp_plugins_list` · `wp_plugin_action` · `wp_themes_list` · `wp_theme_activate` · `wp_settings_get` · `wp_settings_set` · `wp_search`

### PHP / site (`php`)
`wp_bridge_status` · `wp_bridge_flags` · `wp_php_run` · `wp_db_query` · `wp_fs` · `wp_snippet_list` · `wp_snippet_save` · `wp_snippet_run` · `wp_snippet_delete` · `wp_post_meta` · `wp_audit_log`

`wp_php_run` takes `code` plus `mode`: `php` (a PHP program; `return` is serialized back) or `template` (HTML with inline `<?php ?>` blocks). Output buffering, fatal-error capture, a 512 KB source cap and a shell-function blocklist apply in both.

`wp_fs` is jailed to `wp-content`. Reads are broad; writes are limited to an extension allowlist, and `.htaccess`, `.user.ini` and `index.php` are never writable. Overwrites are backed up to `wp-content/woodpresser-backups` (last 40 kept).

### Elementor (`elementor`)
`wp_el_status` · `wp_el_widgets` · `wp_el_get` · `wp_el_build` · `wp_el_set` · `wp_el_patch` · `wp_el_snapshots` · `wp_el_restore` · `wp_el_clear_cache`

`wp_el_build` accepts a compact spec and expands it into Elementor's tree (section → column → widget, or flexbox containers), generating 7-hex ids:

```json
{
  "layout": "section",
  "page_settings": { "template": "elementor_canvas" },
  "sections": [
    {
      "settings": { "layout": "boxed", "gap": "extended" },
      "columns": [
        { "size": 60, "widgets": [{ "type": "heading", "settings": { "title": "Hello", "header_size": "h1" } }] },
        { "size": 40, "widgets": [{ "type": "button", "settings": { "text": "Go", "link": { "url": "#" } } }] }
      ]
    }
  ]
}
```

It defaults to `dry_run: true` and returns the tree without writing. Set `dry_run: false` and `confirm: "overwrite"` to persist. Every write snapshots the previous data (five deep) into `woodpresser_el_snap_<post_id>`, so `wp_el_restore` can put it back.

`wp_el_patch` takes paths from `wp_el_get` (e.g. `0/1/2`) and **deep-merges** settings, so changing `typography_font_size.size` does not erase `unit`.

## Safety model

| Control | Behaviour |
| --- | --- |
| `confirm` literal | `run`, `write`, `overwrite`, `patch`, `restore`, `delete`, `activate` must be spelled exactly. |
| Dry run | `wp_el_build` writes nothing unless asked. |
| Feature flags | `allow_php`, `allow_shell`, `allow_db_write`, `allow_file_write`, `allow_plugins` — off by default except PHP read/exec. |
| SQL | Single statement only; `DROP DATABASE`, `GRANT`, `CREATE USER`, `OUTFILE`, `LOAD_FILE` blocked; writes need `allow_db_write`. |
| Filesystem | Realpath jail under `wp-content`, traversal rejected, extension allowlist, protected filenames. |
| Secrets | `redact()` scrubs registered passwords, tokens, `Authorization` headers and Application-Password shapes from every result and error. |
| Audit | Local `~/.woodpresser/audit.jsonl` plus a `{prefix}woodpresser_audit` table on the site. |

The bridge is a deliberate remote-code-execution surface guarded by an administrator credential. Treat the token like a root password, keep `allow_*` flags off on production until you need them, and read `wp_audit_log` after an agent session.

## Configuration

Precedence, highest first:

1. Environment: `WOODPRESSER_SITE_URL`, `WOODPRESSER_USER`, `WOODPRESSER_APP_PASSWORD`, `WOODPRESSER_BRIDGE_TOKEN`, `WOODPRESSER_MODES`, `WOODPRESSER_SITE`, `WOODPRESSER_CONFIG`, `WOODPRESSER_BRIDGE_FILE`.
2. Project file: `./.woodpresser.json`.
3. User file: `~/.woodpresser/config.json`.

Multiple sites live side by side; each MCP entry pins one with `--site <name>`.

```bash
woodpresser sites
woodpresser sites default clinic
woodpresser doctor --site clinic
```

`doctor` reports REST, auth, bridge, WordPress and PHP versions, Elementor presence and every flag — the fastest way to tell whether a failure is credentials, a plugin, or a permission.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `401` on every call | Login password instead of an Application Password, or the `Authorization` header is stripped by the host | Create one at **Users → Profile → Application Passwords**; on LiteSpeed/Apache check that `HTTP_AUTHORIZATION` reaches PHP |
| `403 woodpresser_bad_token` | Config and bridge disagree after a re-init or restore | `woodpresser bridge claim --site <name>` re-binds both sides |
| `404 rest_no_route` | Bridge installed but not activated, or the plugin folder was uploaded inside another folder | Activate it in **Plugins**; the plugin file must be `wp-content/plugins/woodpresser-bridge/woodpresser-bridge.php` |
| `428 woodpresser_not_claimed` | Bridge is active but no token was ever claimed | `woodpresser bridge claim --site <name>` |
| `429 woodpresser_rate_limited` | More than 240 requests in a minute from one administrator | Batch your calls; the bucket resets after 60s |
| `Path escapes wp-content` | Path resolved outside the jail, or a symlinked upload directory | Pass paths relative to `wp-content`; the jail follows real paths |
| Tools missing in the client | Mode not enabled, or the client has not reloaded the server | `woodpresser tools --site <name>`, then restart the client |
| `node: bad option` / `ERR_UNKNOWN_FILE_EXTENSION` | Node older than 22 | `node -v`, upgrade to 22 or 24 |

`woodpresser doctor --site <name>` prints each layer — REST, auth, bridge, versions, flags — and says which one failed.

## Requirements

- Node.js >= 22 (uses `zlib.crc32`, `node:test` globbing, `AbortSignal.timeout`).
- WordPress >= 6.0 with Application Passwords (HTTPS or a `local` environment).
- PHP >= 7.4 for the bridge.

## Development

```bash
npm install
npm run build          # tsc
npm test               # unit tests (node:test)
npm run test:integration
npm run bridge:zip
```

`test:integration` boots a real WordPress in **WordPress Playground** (PHP-WASM, no Docker, no PHP install), mounts `bridge/`, activates the plugin, and drives the actual MCP tool handlers through 50+ assertions: auth, claim, PHP eval, SQL guard rails, filesystem jail, snippets, content CRUD, Elementor build/patch/snapshot/restore, meta and audit.

`@wp-playground/cli` is a dev dependency, so `npm run test:integration` works after `npm install`. To use a different build, set `WOODPRESSER_PLAYGROUND_CLI` to its path.

## License

MIT (c) Arman Saeedi

Change history: [CHANGELOG.md](CHANGELOG.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security: [SECURITY.md](SECURITY.md).
