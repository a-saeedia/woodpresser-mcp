#!/usr/bin/env node
/**
 * Woodpresser CLI: connect a site, install the bridge, register the MCP server,
 * and diagnose problems. `woodpresser mcp` is what the MCP client launches.
 */
import './boot.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import {
  DEFAULT_MODES,
  ALL_MODES,
  findSiteByUrl,
  loadConfig,
  mask,
  normalizeUrl,
  readConfigFile,
  resolveSite,
  upsertSite,
  userConfigPath,
  writeConfigFile,
} from './config.js';
import { WpClient } from './wp/client.js';
import type { Mode, SiteConfig } from './wp/types.js';
import type { WpError } from './wp/types.js';
import { startServer } from './index.js';
import { installMcp, uninstallMcp, ALL_TARGETS, type McpTarget } from './install/mcp.js';
import { VERSION } from './version.js';
import { bridgeZip } from './util/zip.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createContext } from './tools/context.js';
import { registerTools } from './tools/register.js';

/* ------------------------------------------------------------------ output */

const noColor = Boolean(process.env.NO_COLOR) || !process.stdout.isTTY;
const paint = (code: number) => (text: string) => (noColor ? text : `\x1b[${code}m${text}\x1b[0m`);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const yellow = paint(33);
const red = paint(31);
const cyan = paint(36);

function line(text = ''): void {
  process.stdout.write(`${text}\n`);
}

// A closed pipe (`woodpresser tools | head`) must not look like a crash: Node
// turns the EPIPE into an unhandled 'error' event and exits non-zero.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

function fail(message: string, hint?: string): never {
  process.stderr.write(`${red('error')} ${message}\n`);
  if (hint) process.stderr.write(`${dim(hint)}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------- args */

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    if (body.includes('=')) {
      const [key, ...rest] = body.split('=');
      flags[key!] = rest.join('=');
      continue;
    }
    if (body.startsWith('no-')) {
      flags[body.slice(3)] = false;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      flags[body] = next;
      i += 1;
    } else {
      flags[body] = true;
    }
  }

  return { positional, flags };
}

function str(flags: Parsed['flags'], key: string): string | undefined {
  const value = flags[key];
  return typeof value === 'string' ? value : undefined;
}

function bool(flags: Parsed['flags'], key: string, fallback = false): boolean {
  const value = flags[key];
  if (value === undefined) return fallback;
  return value === true || value === 'true';
}

async function ask(question: string, fallback?: string): Promise<string> {
  if (!process.stdin.isTTY) {
    if (fallback !== undefined) return fallback;
    fail(`Missing value for "${question}" and stdin is not a TTY. Pass it as a flag.`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? dim(` [${fallback}]`) : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || fallback || '';
  } finally {
    rl.close();
  }
}

/* ------------------------------------------------------------------ bridge */

function bridgeSource(): string {
  const override = process.env.WOODPRESSER_BRIDGE_FILE;
  if (override && existsSync(override)) return override;

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'bridge', 'woodpresser-bridge.php'),
    join(here, '..', '..', 'bridge', 'woodpresser-bridge.php'),
    join(process.cwd(), 'bridge', 'woodpresser-bridge.php'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    fail('Bridge plugin file not found. Reinstall the package, or set WOODPRESSER_BRIDGE_FILE.');
  }
  return found;
}

interface BridgeFiles {
  php: string;
  zip: string;
}

/**
 * Drop the plugin and an uploadable archive next to each other.
 *
 * wp-admin only accepts archives, so writing the bare .php and telling the
 * user to zip it is a dead end for anyone without SFTP.
 */
function copyBridge(outDir: string): BridgeFiles {
  const source = bridgeSource();
  const dir = resolve(outDir);
  const php = join(dir, 'woodpresser-bridge.php');
  const zip = join(dir, 'woodpresser-bridge.zip');
  mkdirSync(dirname(php), { recursive: true });
  copyFileSync(source, php);
  const plugin = readFileSync(source);
  writeFileSync(zip, bridgeZip(plugin, statSync(source).mtime));
  return { php, zip };
}

function printBridgeInstructions(files: BridgeFiles, site?: SiteConfig): void {
  line();
  line(bold('Install the bridge plugin (one time)'));
  line(`  1. Open ${cyan('wp-admin → Plugins → Add New → Upload Plugin')}`);
  if (site) line(`     ${cyan(`${site.url}/wp-admin/plugin-install.php?tab=upload`)}`);
  line(`  2. Upload ${cyan(files.zip)} and activate ${bold('Woodpresser Bridge')}.`);
  line(`     ${dim(`Without wp-admin access: unzip it into wp-content/plugins/, or copy ${files.php} to`)}`);
  line(`     ${dim('wp-content/plugins/woodpresser-bridge/woodpresser-bridge.php and activate it.')}`);
  line(
    `  3. Run: ${cyan('woodpresser bridge claim' + (site ? ` --site ${site.label ?? 'default'}` : ''))}`,
  );
  line();
  line(dim("  Hardened alternative: add to wp-config.php before /* That's all */"));
  line(dim(`    define('WOODPRESSER_TOKEN', '<the token in your config>');`));
}

/** Plain HTTP means no Application Passwords, and that deserves a warning. */
function warnInsecureTransport(url: string): void {
  if (!url.startsWith('http://')) return;
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local') || host.endsWith('.test')) return;
  line();
  line(`${yellow('!')} ${url} is plain HTTP. WordPress only offers Application Passwords over HTTPS,`);
  line(dim('  or with WP_ENVIRONMENT_TYPE=local in wp-config.php. Use the https:// URL if the site has one.'));
}

/**
 * Explain a rejected login in terms the user can act on.
 *
 * A 401 has two causes that are indistinguishable from here: the password is
 * wrong, or a proxy in front of WordPress drops the Authorization header. The
 * public REST index tells us the site itself is fine; the curl line in the hint
 * separates the two.
 */
async function explainAuthFailure(client: WpClient, url: string): Promise<string> {
  try {
    await client.request<Record<string, unknown>>('/wp-json/');
  } catch {
    return [
      'The site did not answer /wp-json/ at all.',
      'Check the URL, that WordPress is running, and that a security plugin is not blocking the REST API.',
    ].join('\n');
  }

  return [
    'The site answers REST but rejects the credentials. Two causes look identical here:',
    '  1. Wrong password. Create one at',
    `     ${url}/wp-admin/profile.php#application-passwords-section`,
    '     (Application Passwords, not your login password).',
    '  2. The host strips the Authorization header (LiteSpeed, Apache, some CDNs).',
    "     Test it: curl -sS -u 'USER:APP PASSWORD' '" + url + "/wp-json/wp/v2/users/me?context=edit'",
    '     If curl works and this does not, it is the header. Fix: add',
    '     RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]',
    '     to the top of .htaccess, or ship the mu-plugin from SECURITY.md.',
  ].join('\n');
}

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/* -------------------------------------------------------------------- init */

async function cmdInit(parsed: Parsed): Promise<void> {
  const flags = parsed.flags;

  const urlInput = str(flags, 'url') ?? (await ask('WordPress URL (https://example.com)'));
  if (!urlInput) fail('A site URL is required.');

  const username = str(flags, 'user') ?? (await ask('WordPress username'));
  if (!username) fail('A username is required.');

  const password =
    str(flags, 'password') ??
    process.env.WOODPRESSER_APP_PASSWORD ??
    (await ask('Application Password (Users → Profile → Application Passwords)'));
  if (!password) fail('An application password is required.');

  const modes = await resolveInitModes(flags);
  const url = normalizeUrl(urlInput);
  const host = new URL(url).hostname.replace(/^www\./, '');
  const siteName = str(flags, 'site') ?? host.replace(/[^a-z0-9]+/gi, '-');

  // Re-running init is the most common "fix", and a fresh token would break every
  // other machine pointed at this site. Reuse what is already stored.
  const existing = findSiteByUrl(url);
  const token = str(flags, 'token') ?? existing?.site.bridgeToken ?? randomToken();
  warnInsecureTransport(url);

  const site: SiteConfig = {
    url,
    username,
    appPassword: password.replace(/\s+/g, ''),
    bridgeToken: token,
    modes,
    label: siteName,
  };

  line();
  line(`${dim('site')}    ${bold(url)}`);
  line(`${dim('user')}    ${username}`);
  line(`${dim('modes')}   ${modes.join(', ')}`);
  line(`${dim('token')}   ${mask(token)}${existing ? dim(' (reused)') : ''}`);
  line();

  const client = new WpClient(site);

  line(dim('checking credentials…'));
  let me: Record<string, unknown>;
  try {
    me = await client.rest<Record<string, unknown>>('/users/me', { query: { context: 'edit' } });
  } catch (error) {
    const hint = await explainAuthFailure(client, url);
    fail(`Authentication failed: ${(error as Error).message}`, hint);
  }
  line(`${green('ok')} authenticated as ${bold(String(me.slug ?? me.name))} (id ${me.id})`);

  const probe = await client.probe();
  let bridgeReady = false;

  if (probe.bridge) {
    const ping = (probe.data ?? {}) as Record<string, unknown>;
    line(`${green('ok')} bridge v${ping.plugin_version} reachable (WP ${ping.wp_version}, PHP ${ping.php_version})`);

    if (ping.claimed) {
      try {
        await client.bridge('/claim', { method: 'POST', body: { token } });
        line(`${green('ok')} bridge token rotated to the new value`);
        bridgeReady = true;
      } catch (error) {
        line(`${yellow('!')} bridge is already claimed: ${(error as Error).message}`);
        line(dim('  Pass the existing token with --token to reuse it, or claim with a new one from the current holder.'));
        line(dim('  The token saved now is the one the CLI will use.'));
        bridgeReady = true;
      }
    } else {
      try {
        await client.bridge('/claim', { method: 'POST', body: { token } });
        line(`${green('ok')} bridge claimed`);
        bridgeReady = true;
      } catch (error) {
        fail(`Could not claim the bridge: ${(error as Error).message}`);
      }
    }
  } else {
    line(`${yellow('!')} bridge not detected (${probe.error ?? 'route missing'})`);
    const outDir = str(flags, 'out') ?? process.cwd();
    const target = copyBridge(outDir);
    printBridgeInstructions(target, site);
  }

  const configPath = str(flags, 'config') ?? (bool(flags, 'project') ? join(process.cwd(), '.woodpresser.json') : userConfigPath());
  const config = readConfigFile(configPath) ?? { version: 1 as const, sites: {} };
  config.sites[siteName] = site;
  config.defaultSite = config.defaultSite ?? siteName;
  writeConfigFile(configPath, config);

  line();
  line(`${green('ok')} saved ${cyan(configPath)}`);

  if (bool(flags, 'mcp', true)) {
    installInto(parsed, siteName);
  }

  line();
  if (bridgeReady) {
    line(bold('Ready.'));
  } else {
    line(bold('Almost there.') + ' Install and activate the bridge plugin, then run:');
    line(`  ${cyan(`woodpresser bridge claim --site ${siteName}`)}`);
  }
  line(dim('Restart your MCP client (opencode) to load the server.'));
  line();
}

/**
 * Modes for a new site.
 *
 * Without an explicit --modes flag this asks, defaulting to no: php mode is
 * root-equivalent on the site and nobody should get it by pressing Enter.
 */
async function resolveInitModes(flags: Parsed['flags']): Promise<Mode[]> {
  const explicit = str(flags, 'modes');
  if (explicit) return parseModes(explicit);

  const answer = (await ask('Also enable php + elementor modes? [y/N]', 'n')).toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return DEFAULT_MODES;

  line();
  line(`${yellow('!')} php mode runs arbitrary PHP, SQL and file writes on the site.`);
  line(dim('  Treat the bridge token like a root password. Revoke it in the bridge flags'));
  line(dim('  when you are done, or re-init with --modes core.'));
  return ALL_MODES;
}

function parseModes(value: string | undefined): Mode[] {
  if (!value) return DEFAULT_MODES;
  const modes = value
    .split(',')
    .map((mode) => mode.trim().toLowerCase())
    .filter(Boolean) as Mode[];
  const invalid = modes.filter((mode) => !ALL_MODES.includes(mode));
  if (invalid.length) fail(`Unknown mode(s): ${invalid.join(', ')}. Use ${ALL_MODES.join(', ')}.`);
  return modes.length ? modes : DEFAULT_MODES;
}

function installInto(parsed: Parsed, siteName: string): void {
  const flags = parsed.flags;
  const targets = targetList(str(flags, 'target'));
  const scope = (str(flags, 'scope') ?? 'user') === 'project' ? 'project' : 'user';
  const name = str(flags, 'name') ?? 'woodpresser';
  const options = {
    name,
    nodePath: process.execPath,
    cliPath: fileURLToPath(import.meta.url),
    site: siteName,
    scope: scope as 'user' | 'project',
    cwd: process.cwd(),
  };

  for (const target of targets) {
    try {
      const result = installMcp(target, options);
      const verb = result.created ? 'created' : result.changed ? 'updated' : 'unchanged';
      line(`${green('ok')} ${target} ${verb}: ${cyan(result.path)}`);
    } catch (error) {
      line(`${red('error')} ${target}: ${(error as Error).message}`);
    }
  }
}

function targetList(value: string | undefined): McpTarget[] {
  if (!value || value === 'all') return ALL_TARGETS;
  const list = value.split(',').map((entry) => entry.trim()) as McpTarget[];
  const invalid = list.filter((entry) => !ALL_TARGETS.includes(entry));
  if (invalid.length) fail(`Unknown target(s): ${invalid.join(', ')}. Use ${ALL_TARGETS.join(', ')} or all.`);
  return list;
}

/* ------------------------------------------------------------------ doctor */

async function cmdDoctor(parsed: Parsed): Promise<void> {
  let resolved;
  try {
    resolved = resolveSite(str(parsed.flags, 'site'));
  } catch (error) {
    fail((error as Error).message, 'Run `woodpresser init` first.');
  }

  const { name, site } = resolved;
  const client = new WpClient(site);

  line();
  line(`${bold('woodpresser doctor')} ${dim(`v${VERSION}`)}`);
  line(`${dim('site')} ${name} → ${site.url}`);
  line(`${dim('modes')} ${(site.modes ?? []).join(', ')}`);
  line();

  const rows: Array<[string, boolean, string]> = [];
  const notes: string[] = [];
  let authOk = false;

  let restOk = false;
  try {
    const index = await client.request<Record<string, unknown>>('/wp-json/');
    restOk = true;
    rows.push(['REST API', true, String(index.name ?? '')]);
  } catch (error) {
    rows.push(['REST API', false, (error as Error).message]);
    notes.push(
      [
        'The site did not answer /wp-json/ at all.',
        'Check the URL, that WordPress is running, and that a security plugin is not blocking the REST API.',
      ].join('\n'),
    );
  }

  try {
    const me = await client.rest<Record<string, unknown>>('/users/me', { query: { context: 'edit' } });
    authOk = true;
    rows.push(['Auth', true, `${me.slug} (id ${me.id})`]);
  } catch (error) {
    rows.push(['Auth', false, (error as Error).message]);
    if (restOk) notes.push(await explainAuthFailure(client, site.url));
  }

  let ping: Record<string, unknown> | null = null;
  try {
    ping = await client.bridge<Record<string, unknown>>('/ping');
    rows.push(['Bridge', true, `v${ping.plugin_version} claimed=${ping.claimed}`]);
  } catch (error) {
    const bridgeError = error as WpError;
    rows.push(['Bridge', false, bridgeError.message]);
    if (bridgeError.hint && authOk) notes.push(bridgeError.hint);
  }

  if (ping) {
    rows.push(['WordPress', true, String(ping.wp_version)]);
    rows.push(['PHP', true, String(ping.php_version)]);
    rows.push(['Elementor', Boolean(ping.elementor), String(ping.elementor ?? 'not installed')]);
    const flags = (ping.flags ?? {}) as Record<string, boolean>;
    rows.push([
      'PHP execution',
      Boolean(flags.allow_php),
      flags.allow_php ? 'enabled' : 'disabled',
    ]);
    rows.push([
      'DB writes',
      Boolean(flags.allow_db_write),
      flags.allow_db_write ? 'enabled' : 'read-only',
    ]);
  }

  for (const [label, ok, detail] of rows) {
    line(`  ${ok ? green('✓') : red('✗')} ${label.padEnd(14)} ${dim(detail)}`);
  }

  for (const note of notes) {
    line();
    line(note);
  }

  line();
  const blocking = rows.filter(([label, ok]) => !ok && (label === 'REST API' || label === 'Auth'));
  if (blocking.length) {
    line(red('Not usable yet. Fix the failures above.'));
  } else if (!ping) {
    line(yellow('Core works. Bridge is missing — PHP, DB, filesystem, snippets and Elementor tools will fail.'));
    line(dim('  woodpresser bridge copy && install it, then: woodpresser bridge claim'));
  } else {
    line(green('All good.'));
  }
  line();
}

/* ------------------------------------------------------------------- sites */

function cmdSites(parsed: Parsed): void {
  const which = str(parsed.flags, 'config');
  const file = which ?? (bool(parsed.flags, 'project') ? join(process.cwd(), '.woodpresser.json') : userConfigPath());
  const config = readConfigFile(file);

  if (!config || Object.keys(config.sites).length === 0) {
    line(`No sites configured in ${dim(file)}. Run ${cyan('woodpresser init')}.`);
    return;
  }

  line();
  for (const [name, site] of Object.entries(config.sites)) {
    const marker = config.defaultSite === name ? green('*') : ' ';
    line(`${marker} ${bold(name.padEnd(18))} ${site.url}`);
    line(`  ${dim('user')} ${site.username}  ${dim('token')} ${mask(site.bridgeToken)}  ${dim('modes')} ${(site.modes ?? []).join(',')}`);
  }
  line();
}

function cmdSetDefault(parsed: Parsed): void {
  const name = parsed.positional[1];
  if (!name) fail('Usage: woodpresser sites default <name>');
  const path = userConfigPath();
  const config = readConfigFile(path);
  if (!config?.sites[name]) fail(`Unknown site "${name}".`);
  config.defaultSite = name;
  writeConfigFile(path, config);
  line(`${green('ok')} default site is now ${bold(name)}`);
}

/* ------------------------------------------------------------------ bridge */

async function cmdBridge(parsed: Parsed): Promise<void> {
  const action = parsed.positional[1] ?? 'path';

  if (action === 'path') {
    line(bridgeSource());
    return;
  }

  if (action === 'copy') {
    const out = str(parsed.flags, 'out') ?? process.cwd();
    const target = copyBridge(out);
    line(`${green('ok')} ${target.zip}`);
    printBridgeInstructions(target);
    return;
  }

  if (action === 'claim') {
    let resolved;
    try {
      resolved = resolveSite(str(parsed.flags, 'site'));
    } catch (error) {
      fail((error as Error).message, 'Run `woodpresser init` first.');
    }
    const { name, site } = resolved;
    const token = str(parsed.flags, 'token') ?? site.bridgeToken;
    if (!token) fail('No bridge token available. Pass --token <token>.');

    const client = new WpClient({ ...site, bridgeToken: token });
    try {
      const result = await client.bridge<Record<string, unknown>>('/claim', {
        method: 'POST',
        body: { token },
      });
      line(`${green('ok')} claimed ${name} (${site.url}) rotated=${String(result.rotated)}`);
    } catch (error) {
      fail(`Claim failed: ${(error as Error).message}`, 'The bridge may already be claimed with a different token.');
    }
    return;
  }

  fail(`Unknown bridge action "${action}". Use path, copy or claim.`);
}

/* -------------------------------------------------------------------- tools */

async function cmdTools(parsed: Parsed): Promise<void> {
  const modeFlag = str(parsed.flags, 'modes') ?? 'core,php,elementor';
  const modes = modeFlag
    .split(',')
    .map((mode) => mode.trim())
    .filter((mode): mode is 'core' | 'php' | 'elementor' => mode === 'core' || mode === 'php' || mode === 'elementor');

  // Listing tools must work before a site exists: it is how people decide
  // whether to bother configuring one.
  let name = 'offline';
  let site: SiteConfig = { url: 'https://example.com', username: 'offline', appPassword: '', modes };
  try {
    const resolved = resolveSite(str(parsed.flags, 'site'));
    name = resolved.name;
    site = { ...resolved.site, modes };
  } catch {
    /* no site configured - list the full catalogue anyway */
  }

  const ctx = createContext(name, site);
  const names: string[] = [];
  const recorder = {
    registerTool: (toolName: string) => {
      names.push(toolName);
      return recorder;
    },
  } as unknown as McpServer;

  const groups = registerTools(recorder, ctx);
  line();
  line(`${bold('tools')} ${dim(`site=${name} groups=${groups.join(',')}`)}`);
  for (const toolName of names) line(`  ${toolName}`);
  line(`\n${names.length} tools`);
  line();
}

/* --------------------------------------------------------------------- mcp */

async function cmdMcp(parsed: Parsed): Promise<void> {
  try {
    await startServer({ siteName: str(parsed.flags, 'site') });
  } catch (error) {
    process.stderr.write(`[woodpresser] failed to start: ${(error as Error).message}\n`);
    process.exit(1);
  }
}

/* -------------------------------------------------------------------- help */

function usage(): void {
  line(`
${bold('woodpresser')} ${dim(`v${VERSION}`)} — WordPress MCP server

${bold('Usage')}
  woodpresser init [--url URL --user USER --password PASS]
                   [--token TOKEN] [--site NAME] [--modes core,php,elementor]
                   [--target opencode|claude|vscode|all] [--scope user|project]
                   [--out DIR] [--config FILE] [--no-mcp]
  woodpresser mcp [--site NAME]          Start the MCP server (stdio)
  woodpresser doctor [--site NAME]       Diagnose the connection in layers
  woodpresser tools [--site NAME]        List tools available in the current modes
  woodpresser sites                      List configured sites
  woodpresser sites default NAME         Set the default site
  woodpresser bridge path|copy|claim     Manage the bridge plugin
  woodpresser install-mcp [--target all --scope user|project --name woodpresser --site NAME]
  woodpresser uninstall-mcp [--target all --scope user|project]

${bold('Environment')}
  WOODPRESSER_SITE_URL, WOODPRESSER_USER, WOODPRESSER_APP_PASSWORD,
  WOODPRESSER_BRIDGE_TOKEN, WOODPRESSER_SITE, WOODPRESSER_MODES,
  WOODPRESSER_CONFIG, WOODPRESSER_BRIDGE_FILE, NO_COLOR

${bold('Docs')} https://github.com/a-saeedia/woodpresser-mcp
`);
}

/* -------------------------------------------------------------------- main */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const command = parsed.positional[0] ?? 'help';

  switch (command) {
    case 'init':
      await cmdInit(parsed);
      break;
    case 'mcp':
    case 'serve':
      await cmdMcp(parsed);
      break;
    case 'doctor':
      await cmdDoctor(parsed);
      break;
    case 'tools':
      await cmdTools(parsed);
      break;
    case 'sites':
      if (parsed.positional[1] === 'default') cmdSetDefault(parsed);
      else cmdSites(parsed);
      break;
    case 'bridge':
      await cmdBridge(parsed);
      break;
    case 'install-mcp': {
      const site = str(parsed.flags, 'site');
      installInto(parsed, site ?? loadConfig().config.defaultSite ?? 'default');
      break;
    }
    case 'uninstall-mcp': {
      const flags = parsed.flags;
      const targets = targetList(str(flags, 'target'));
      const scope = (str(flags, 'scope') ?? 'user') === 'project' ? 'project' : 'user';
      const name = str(flags, 'name') ?? 'woodpresser';
      for (const target of targets) {
        try {
          const result = uninstallMcp(target, name, scope as 'user' | 'project', process.cwd());
          line(`${result.removed ? green('ok') : dim('–')} ${target} ${result.path}`);
        } catch (error) {
          line(`${red('error')} ${target}: ${(error as Error).message}`);
        }
      }
      break;
    }
    case 'version':
    case '--version':
    case '-v':
      line(VERSION);
      break;
    case 'help':
    case '--help':
    case '-h':
      usage();
      break;
    default:
      fail(`Unknown command "${command}".`, 'Run `woodpresser help`.');
  }
}

main().catch((error) => {
  fail((error as Error)?.message ?? String(error));
});

