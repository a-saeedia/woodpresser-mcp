# Security Policy

## The short version

Woodpresser gives an AI agent a remote-code-execution path into a WordPress
site. That is the product, not a bug. Treat the bridge token the way you would
treat a root password.

## Threat model

| Asset | Exposure | Mitigation |
| --- | --- | --- |
| Application Password | Sent on every request via Basic auth over HTTPS | Never logged; scrubbed by `redact()`; stored in a `0600` file |
| Bridge token | `X-Woodpresser-Token` header | `hash_equals` comparison; can be pinned in `wp-config.php` |
| PHP execution | `wp_php_run`, snippets | Requires `manage_options` + token; `allow_shell` off by default; `disable_functions` respected |
| Database | `wp_db_query` | Single statement only; destructive verbs blocked; writes need `allow_db_write` |
| Filesystem | `wp_fs` | Realpath jail under `WP_CONTENT_DIR`; extension allowlist; protected filenames; backups on overwrite |
| Audit trail | local + site table | Append-only; readable through `wp_audit_log` |

### Out of scope

- A compromised administrator account. If an attacker has an application
  password and the bridge token, they own the site — by design.
- Hosts that block `Authorization` headers. Use HTTPS or an `http_authorization`
  shim; a Wordfence-style drop makes auth fail with a confusing 401.
- `wp_php_run` escaping `open_basedir` or `disable_functions`. The bridge cannot
  be stronger than the PHP it runs inside.

## Hardening checklist

- [ ] Serve over HTTPS only; never send an Application Password over plain HTTP.
- [ ] Use a dedicated administrator account, not your personal login.
- [ ] Keep `allow_db_write`, `allow_file_write`, `allow_shell` and `allow_plugins`
      off until a task needs them.
- [ ] Review `wp_audit_log` after every agent session.
- [ ] Rotate the bridge token (`woodpresser bridge claim --rotate`) if it was ever
      pasted into a chat, a commit, or a screenshot.
- [ ] Deactivate the bridge plugin when you are not using it.

## Reporting a vulnerability

Open a private security advisory at
<https://github.com/a-saeedia/woodpresser-mcp/security/advisories/new>.

Please do not file public issues for auth bypasses, token leakage, path
traversal, SQL guard bypasses, or PHP sandbox escapes. Expect an initial
response within 72 hours.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
