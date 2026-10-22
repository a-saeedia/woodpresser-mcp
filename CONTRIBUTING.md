# Contributing

Bug reports and pull requests are welcome. This project talks to real sites with
real credentials, so the bar for changes to auth, the database and the filesystem
is "prove it with a test".

## Setup

```bash
git clone https://github.com/a-saeedia/woodpresser-mcp
cd woodpresser-mcp
npm install          # also runs tsc via the prepare script
npm test             # 33 unit tests, no WordPress needed
npm run test:integration
```

`test:integration` boots WordPress in Playground (PHP compiled to WASM) and
drives the real tool handlers against it. No PHP, MySQL or Docker on your
machine. It takes a minute or two. Point `WOODPRESSER_PLAYGROUND_CLI` at another
build if you need to.

Before opening a PR, all three must pass:

```bash
npm run build && npm test && npm run verify:package && npm run test:integration
```

`verify:package` packs the tarball, installs it into an empty prefix and runs the
CLI from there — it is what catches "works in the repo, broken when installed".

## Layout

| Path | What lives there |
| --- | --- |
| `src/wp/` | REST client, config, redaction. No MCP knowledge. |
| `src/tools/` | Tool definitions and handlers, grouped by mode (`core`, `php`, `elementor`). |
| `src/install/` | MCP client registration (JSONC editing with comments preserved). |
| `src/util/jsonc.ts` | The comment-preserving JSON editor used by `install-mcp`. |
| `bridge/woodpresser-bridge.php` | The companion plugin. One file, no build step. |
| `tests/` | Unit tests plus the Playground integration harness. |
| `scripts/` | `zip-bridge.mjs`, `verify-package.mjs`. |

## Adding a tool

1. Pick the mode. If it executes code, touches SQL or writes files, it belongs in
   `php`. If it only speaks REST, it belongs in `core`.
2. Define it with a Zod schema and a description written for a model: when to use
   it, what it returns, what it costs. Examples beat adjectives.
3. Any tool that changes state takes an explicit `confirm` literal and is
   audited with `audit(...)`.
4. Register the handler and add the tool to the mode list in
   `src/tools/register.ts`.
5. Add a unit test for the pure parts and an assertion in
   `tests/integration-playground.mjs` for anything that hits a site.
6. Run `woodpresser tools --modes <mode>` and check the count and descriptions.

## Bridge plugin rules

- PHP >= 7.4, WordPress >= 6.0, no Composer, no build step. One file stays one
  file: it gets uploaded by hand through a host's plugin screen.
- Every route needs a `permission_callback`. New state-changing routes use
  `authorize` (admin + token); only `/ping` and `/claim` use `require_admin`.
- SQL: one statement per request, `$wpdb->prepare()` for values, and only
  `{prefix}` interpolation for identifiers. Table names are never user input.
- Filesystem: everything goes through `resolve_path()`. No raw `file_put_contents`
  on a path that did not come out of it.
- Writes get a backup when they overwrite something a human may care about.
- Follow WordPress coding standards (tabs, Yoda conditions, docblocks). Inline
  `phpcs:ignore` only where the rule is genuinely wrong for the intent, and say
  why in the comment.

The bridge has never been through `php -l` on a machine without PHP. If you add
PHP, the Playground run is your syntax check: if the plugin fails to parse, the
integration suite fails at `/ping`.

## Style

- TypeScript strict, no `any` without a comment explaining why.
- Node built-ins first. Two runtime dependencies is the budget; do not spend it.
- Comments explain intent, not mechanics. If a line needs a comment to be
  readable, rewrite the line.
- No secrets, ever, including in tests. The fixtures use obviously fake values.
- Commit messages: `type(scope): imperative summary`, then the why. Types used
  here are `feat`, `fix`, `docs`, `test`, `chore`, `ci`.

## Releasing

`prepublishOnly` runs the build, the unit suite and the package check, so a
release cannot ship a tarball that does not install.

```bash
# 1. bump both, in one commit
#    package.json  "version"
#    src/version.ts VERSION   (a test fails if these drift)
# 2. CHANGELOG: move [Unreleased] to [x.y.z] - YYYY-MM-DD
npm run build && npm test && npm run verify:package
git commit -am "chore(release): x.y.z" && git tag -a vx.y.z -m "vx.y.z"
git push origin main --follow-tags
```

Then publish and prove it, in this order:

```bash
npm login            # once per machine
npm publish          # public scoped-free name: woodpresser-mcp
cd "$(mktemp -d)" && npx --yes woodpresser-mcp version   # must print x.y.z
```

Do not rewrite a tag that has a GitHub release. Cut the next patch version
instead; the release notes are the only record of what people installed.

## Security

Read [SECURITY.md](SECURITY.md) before touching auth, redaction or the
filesystem jail. Report vulnerabilities privately, not as a public issue.
