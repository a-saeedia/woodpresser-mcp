/**
 * End-to-end integration test against real WordPress (WordPress Playground,
 * PHP-WASM). Boots a site, mounts the bridge plugin, then drives the actual MCP
 * tool handlers.
 *
 *   node tests/integration-playground.mjs
 *
 * Requires @wp-playground/cli. Resolution order:
 *   WOODPRESSER_PLAYGROUND_CLI, ../../Desktop/wordpresser/node_modules/.bin, npx
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const PORT = Number(process.env.WOODPRESSER_TEST_PORT || 9411);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = { user: 'admin', pass: 'password' };

const { WpClient } = await import(pathToFileURL(join(root, 'dist/wp/client.js')).href);
const { createContext } = await import(pathToFileURL(join(root, 'dist/tools/context.js')).href);
const { registerTools } = await import(pathToFileURL(join(root, 'dist/tools/register.js')).href);

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function parseResult(result) {
  const text = result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/* ------------------------------------------------------------- playground */

function resolvePlayground() {
  if (process.env.WOODPRESSER_PLAYGROUND_CLI) return process.env.WOODPRESSER_PLAYGROUND_CLI;
  const bin = process.platform === 'win32' ? 'wp-playground-cli.cmd' : 'wp-playground-cli';
  const candidates = [
    join(root, 'node_modules', '.bin', bin),
    join(root, 'node_modules', '.bin', 'wp-playground-cli'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['wp-playground-cli'], {
    encoding: 'utf8',
  });
  if (which.status === 0) return which.stdout.split(/\r?\n/)[0].trim();

  console.error('wp-playground-cli not found. Run `npm i -D @wp-playground/cli` or set WOODPRESSER_PLAYGROUND_CLI.');
  process.exit(2);
}

async function waitForSite(timeoutMs = 240_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${BASE}/wp-json/`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.name) return body;
      }
    } catch {
      // not up yet
    }
    await delay(1500);
  }
  throw new Error(`WordPress did not answer on ${BASE} within ${timeoutMs}ms`);
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('C:/Windows/System32/taskkill.exe', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // ignore
  }
}

async function portIsFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/wp-json/`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

/* -------------------------------------------------------------------- main */

const playground = resolvePlayground();
const blueprint = join(here, 'playground-blueprint.json');
const mountHost = join(root, 'bridge');

if (!(await portIsFree(PORT))) {
  console.error(`Port ${PORT} is already serving a site. Kill it first (stale Playground) or set WOODPRESSER_TEST_PORT.`);
  process.exit(2);
}

console.log(`\nBooting WordPress Playground on ${BASE}`);
console.log(`  cli:    ${playground}`);
console.log(`  mount:  ${mountHost} -> /wordpress/wp-content/plugins/woodpresser-bridge\n`);

const child = spawn(
  playground,
  [
    'server',
    '--port',
    String(PORT),
    '--blueprint',
    blueprint,
    '--mount-dir',
    mountHost,
    '/wordpress/wp-content/plugins/woodpresser-bridge',
  ],
  { cwd: root, shell: true, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
);

child.stdout.on('data', (chunk) => process.stderr.write(`[playground] ${chunk}`));
child.stderr.on('data', (chunk) => process.stderr.write(`[playground] ${chunk}`));

let exitCode = 0;

try {
  await waitForSite();

  const site = {
    url: BASE,
    username: ADMIN.user,
    appPassword: ADMIN.pass,
    bridgeToken: 'integration-test-token-0123456789abcdef',
    modes: ['core', 'php', 'elementor'],
  };

  const client = new WpClient(site);
  const ctx = createContext('playground', site);

  const handlers = new Map();
  const fakeServer = {
    registerTool: (name, _meta, handler) => {
      handlers.set(name, handler);
      return fakeServer;
    },
  };
  registerTools(fakeServer, ctx);

  const call = async (name, args = {}) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Tool ${name} not registered`);
    return parseResult(await handler(args));
  };

  const me = await client.rest('/users/me', { query: { context: 'edit' } });
  check('admin basic auth resolves to administrator', me.id > 0, `id=${me.id}`);

  console.log('\n[plugin]');
  const pluginFile = 'woodpresser-bridge/woodpresser-bridge.php';
  const pluginSlug = pluginFile.replace(/\.php$/, '');
  const plugins = await client.rest('/plugins');
  const bridgePlugin = plugins.find((plugin) => plugin.plugin === pluginFile || plugin.plugin === pluginSlug);
  check('bridge plugin is mounted and visible', Boolean(bridgePlugin), JSON.stringify(plugins.map((p) => p.plugin)));
  if (bridgePlugin && bridgePlugin.status !== 'active') {
    await client.rest(`/plugins/${pluginSlug}`, {
      method: 'POST',
      body: { status: 'active' },
    });
  }
  const afterActivate = await client.rest('/plugins');
  check('bridge plugin active', afterActivate.find((p) => p.plugin === pluginFile || p.plugin === pluginSlug)?.status === 'active');

  console.log('\n[bridge]');
  const ping = await client.bridge('/ping');
  check('bridge ping', ping.ok === true, JSON.stringify(ping).slice(0, 160));
  check('bridge starts unclaimed', ping.claimed === false);
  check('bridge reports WP version', Boolean(ping.wp_version), ping.wp_version);

  const claim = await client.bridge('/claim', { method: 'POST', body: { token: site.bridgeToken } });
  check('claim', claim.claimed === true);

  const claimedPing = await client.bridge('/ping');
  check('ping after claim', claimedPing.claimed === true);

  const wrongToken = new WpClient({ ...site, bridgeToken: 'wrong-token-wrong-token-wrong-token' });
  let rejected = false;
  try {
    await wrongToken.bridge('/php', { method: 'POST', body: { code: 'return 1;', mode: 'php' } });
  } catch (error) {
    rejected = error.status === 403;
  }
  check('wrong bridge token is rejected with 403', rejected);

  console.log('\n[php]');
  const php = await call('wp_php_run', { code: 'return [ "v" => get_bloginfo("version"), "url" => home_url() ];', mode: 'php', confirm: 'run' });
  check('wp_php_run returns WordPress version', Boolean(php.result?.return?.v), JSON.stringify(php).slice(0, 160));
  check('wp_php_run reports ok', php.result?.ok === true);

  const phpEcho = await call('wp_php_run', { code: '<p>hi</p><?php echo "hello from php"; ?>', mode: 'template', confirm: 'run' });
  check('template mode renders HTML with inline PHP', phpEcho.result?.output === '<p>hi</p>hello from php', JSON.stringify(phpEcho.result));

  const phpBlocked = await call('wp_php_run', { code: 'system("echo nope");', confirm: 'run' });
  check('shell function blocked by default', phpBlocked.result?.ok === false && /Blocked function/.test(phpBlocked.result?.error ?? ''));

  const phpGuard = await call('wp_php_run', { code: 'return 1;', confirm: 'nope' });
  check('php requires confirm literal', phpGuard.ok === false && /confirm/.test(phpGuard.error ?? ''));

  const fatal = await call('wp_php_run', { code: 'this is not php', confirm: 'run' });
  check('parse errors are reported, not fatal', fatal.result?.ok === false, JSON.stringify(fatal.result).slice(0, 120));

  console.log('\n[database]');
  const readQuery = await call('wp_db_query', { sql: 'SELECT COUNT(*) AS c FROM wp_posts' });
  check('select returns rows', readQuery.result?.ok === true && readQuery.result.row_count >= 1, JSON.stringify(readQuery).slice(0, 160));

  const writeBlocked = await call('wp_db_query', { sql: "UPDATE wp_options SET option_value='x' WHERE option_name='blogname'", confirm: 'write' });
  const blockedMessage = writeBlocked.error ?? writeBlocked.result?.error ?? '';
  check('writes blocked while allow_db_write is off', writeBlocked.ok === false && /read-only/i.test(blockedMessage), JSON.stringify(writeBlocked).slice(0, 200));

  await call('wp_bridge_flags', { allow_db_write: true });
  const writeOk = await call('wp_db_query', { sql: "UPDATE wp_options SET option_value='Woodpresser Test' WHERE option_name='blogname'", confirm: 'write' });
  check('write succeeds after enabling allow_db_write', writeOk.result?.ok === true && writeOk.result.row_count === 1, JSON.stringify(writeOk).slice(0, 200));
  await call('wp_bridge_flags', { allow_db_write: false });

  const multi = await call('wp_db_query', { sql: 'SELECT 1; SELECT 2;' });
  check('multi-statement blocked', multi.ok === false || multi.result?.ok === false);

  console.log('\n[filesystem]');
  const written = await call('wp_fs', { op: 'write', path: 'woodpresser-test/hello.txt', content: 'first' });
  check('fs write', written.result?.ok === true, JSON.stringify(written).slice(0, 160));
  const readBack = await call('wp_fs', { op: 'read', path: 'woodpresser-test/hello.txt' });
  check('fs read', readBack.result?.content === 'first');
  const second = await call('wp_fs', { op: 'write', path: 'woodpresser-test/hello.txt', content: 'second' });
  check('fs overwrite creates a backup', Boolean(second.result?.backup), JSON.stringify(second.result));
  const listed = await call('wp_fs', { op: 'list', path: 'woodpresser-test' });
  check('fs list', Array.isArray(listed.result?.entries) && listed.result.entries.length >= 1);
  const escaped = await call('wp_fs', { op: 'read', path: '../../wp-config.php' });
  check('path traversal blocked', escaped.ok === false || escaped.result === undefined || /traversal|escapes/i.test(escaped.error ?? escaped.result?.error ?? ''));
  const badExt = await call('wp_fs', { op: 'write', path: 'woodpresser-test/evil.exe', content: 'MZ' });
  check('non-allowlisted extension blocked', badExt.ok === false || badExt.result?.ok === false);

  console.log('\n[snippets]');
  const snippet = await call('wp_snippet_save', {
    name: 'integration snippet',
    code: 'return "snippet:" . (1 + 1);',
    scope: 'manual',
    active: false,
  });
  check('snippet create', snippet.id > 0, JSON.stringify(snippet));
  const snippetRun = await call('wp_snippet_run', { id: snippet.id });
  check('snippet runs and returns value', String(snippetRun.result?.return) === 'snippet:2', JSON.stringify(snippetRun).slice(0, 200));
  const snippetList = await call('wp_snippet_list');
  check('snippet list', (snippetList.snippets ?? []).some((row) => Number(row.id) === snippet.id));
  const snippetUpdate = await call('wp_snippet_save', { id: snippet.id, name: 'integration snippet v2', code: 'return "v2";', scope: 'manual', active: true });
  check('snippet update', snippetUpdate.updated === true);
  const snippetDelete = await call('wp_snippet_delete', { id: snippet.id, confirm: 'delete' });
  check('snippet delete', snippetDelete.deleted === true);

  console.log('\n[content]');
  const created = await call('wp_content_create', {
    type: 'page',
    title: 'Woodpresser Integration Page',
    content: '<!-- wp:paragraph --><p>hello</p><!-- /wp:paragraph -->',
    status: 'draft',
  });
  check('create page', created.id > 0, JSON.stringify(created));
  const pageId = created.id;

  const fetched = await call('wp_content_get', { id: pageId, type: 'page' });
  check('get page', fetched.item?.id === pageId);

  const updated = await call('wp_content_update', { id: pageId, type: 'page', title: 'Woodpresser Integration Page v2' });
  check('update page', updated.id === pageId);

  const listedContent = await call('wp_content_list', { type: 'page', status: 'draft', per_page: 10 });
  check('list pages', (listedContent.items ?? []).some((item) => item.id === pageId));

  console.log('\n[elementor]');
  const elStatus = await call('wp_el_status');
  check('elementor status reports inactive', elStatus.active === false, JSON.stringify(elStatus));

  const built = await call('wp_el_build', {
    dry_run: true,
    spec: {
      sections: [
        {
          settings: { layout: 'boxed' },
          columns: [
            { size: 60, widgets: [{ type: 'heading', settings: { title: 'Hero', header_size: 'h1' } }] },
            { size: 40, widgets: [{ type: 'button', settings: { text: 'Go', link: { url: '#' } } }] },
          ],
        },
        { layout: 'container', sections: [] },
      ],
    },
  });
  check('dry run builds an element tree', Array.isArray(built.tree) && built.tree.length >= 1, JSON.stringify(built).slice(0, 200));
  const section = built.tree?.[0];
  check('section has two columns', section?.elements?.length === 2);
  check('column carries width settings', section?.elements?.[0]?.settings?._column_size === 60, JSON.stringify(section?.elements?.[0]?.settings));
  check('widget ids are 7 hex chars', /^[0-9a-f]{7}$/.test(section?.elements?.[0]?.elements?.[0]?.id ?? ''));

  const written2 = await call('wp_el_build', {
    post_id: pageId,
    confirm: 'overwrite',
    dry_run: false,
    spec: {
      sections: [
        {
          columns: [
            { size: 100, widgets: [{ type: 'heading', settings: { title: 'Written by woodpresser', header_size: 'h2' } }] },
          ],
        },
      ],
    },
  });
  check('write elementor tree to page', written2.post_id === pageId && written2.bytes > 0, JSON.stringify(written2));

  const elGet = await call('wp_el_get', { post_id: pageId, format: 'both' });
  check('read elementor tree back', Array.isArray(elGet.data) && elGet.data.length === 1);
  check('summary is populated', Array.isArray(elGet.summary) && elGet.summary.length === 1);

  const patched = await call('wp_el_patch', {
    post_id: pageId,
    confirm: 'patch',
    patches: [{ path: '0/0/0', settings: { title: 'Patched title' } }],
  });
  check('patch widget settings', patched.applied?.[0]?.widgetType === 'heading', JSON.stringify(patched));

  const afterPatch = await call('wp_el_get', { post_id: pageId, format: 'raw' });
  const heading = afterPatch.data?.[0]?.elements?.[0]?.elements?.[0];
  check('patched value persisted', heading?.settings?.title === 'Patched title', JSON.stringify(heading?.settings));

  const snapshots = await call('wp_el_snapshots', { post_id: pageId });
  check('snapshot created before overwrite', (snapshots.snapshots ?? []).length >= 1, JSON.stringify(snapshots));

  const restored = await call('wp_el_restore', { post_id: pageId, index: 0, confirm: 'restore' });
  check('restore snapshot', restored.restored_index === 0);

  const afterRestore = await call('wp_el_get', { post_id: pageId, format: 'raw' });
  check('restore reverted the heading', afterRestore.data?.[0]?.elements?.[0]?.elements?.[0]?.settings?.title === 'Written by woodpresser');

  const elGuard = await call('wp_el_set', { post_id: pageId, data: [], confirm: 'nope' });
  check('elementor write requires confirm', elGuard.ok === false && /confirm/.test(elGuard.error ?? ''));

  console.log('\n[meta + audit]');
  const metaSet = await call('wp_post_meta', { post_id: pageId, action: 'set', key: 'woodpresser_probe', value: { a: 1, b: [2, 3] } });
  check('post meta set', metaSet.result?.ok === true, JSON.stringify(metaSet).slice(0, 200));
  const metaGet = await call('wp_post_meta', { post_id: pageId, action: 'get', key: 'woodpresser_probe' });
  check('post meta get round-trips arrays', JSON.stringify(metaGet.result?.return?.value?.[0]) === JSON.stringify({ a: 1, b: [2, 3] }), JSON.stringify(metaGet).slice(0, 240));

  const audit = await call('wp_audit_log', { limit: 100 });
  check('bridge audit recorded writes', (audit.entries ?? []).length >= 5, `${(audit.entries ?? []).length} entries`);

  console.log('\n[site]');
  const info = await call('wp_site_info');
  check('site info exposes bridge', Boolean(info.bridge?.plugin_version), JSON.stringify(info.bridge ?? {}).slice(0, 160));
  const health = await call('wp_health_check');
  check('health check is healthy', health.healthy === true, JSON.stringify(health.checks));

  const del = await call('wp_content_delete', { id: pageId, type: 'page', force: true, confirm: 'delete' });
  check('delete page', del.deleted === true);
} catch (error) {
  failed += 1;
  failures.push(`harness: ${error.message}`);
  console.error('\nHARNESS ERROR:', error);
  exitCode = 1;
} finally {
  killTree(child.pid);
  await delay(800);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed > 0 ? 1 : exitCode);
