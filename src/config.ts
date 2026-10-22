/**
 * Configuration resolution.
 *
 * Precedence (highest first):
 *   1. Environment variables (single-site, ephemeral)
 *   2. Project file ./.woodpresser.json
 *   3. User file ~/.woodpresser/config.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ConfigFile, Mode, SiteConfig } from './wp/types.js';
import { registerSecrets } from './util/redact.js';

export const ALL_MODES: Mode[] = ['core', 'php', 'elementor'];

/**
 * Modes a site gets when it names none.
 *
 * `core` only. php mode runs arbitrary PHP/SQL and writes files, and the bridge
 * token is effectively a root credential, so that access is an explicit opt-in.
 */
export const DEFAULT_MODES: Mode[] = ['core'];

export function userConfigPath(): string {
  return process.env.WOODPRESSER_CONFIG || join(homedir(), '.woodpresser', 'config.json');
}

export function projectConfigPath(cwd = process.cwd()): string {
  return join(cwd, '.woodpresser.json');
}

export function emptyConfig(): ConfigFile {
  return { version: 1, sites: {} };
}

export function readConfigFile(path: string): ConfigFile | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConfigFile;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.sites !== 'object') return null;
    parsed.version = 1;
    parsed.sites = parsed.sites ?? {};
    return parsed;
  } catch {
    return null;
  }
}

export function writeConfigFile(path: string, config: ConfigFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

/** Load the merged config, without env-only sites. */
export function loadConfig(cwd = process.cwd()): { config: ConfigFile; source: string } {
  const project = readConfigFile(projectConfigPath(cwd));
  if (project) return { config: project, source: projectConfigPath(cwd) };

  const user = readConfigFile(userConfigPath());
  if (user) return { config: user, source: userConfigPath() };

  return { config: emptyConfig(), source: userConfigPath() };
}

export function normalizeUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/wp-admin\/?$/i, '').replace(/\/wp-json\/?$/i, '');
  return url.replace(/\/+$/, '');
}

export function normalizeSite(site: SiteConfig): SiteConfig {
  const modes = (site.modes ?? DEFAULT_MODES).filter((mode): mode is Mode =>
    ALL_MODES.includes(mode as Mode),
  );
  return {
    ...site,
    url: normalizeUrl(site.url),
    appPassword: site.appPassword.replace(/\s+/g, ''),
    modes: modes.length ? modes : DEFAULT_MODES,
    timeoutMs: site.timeoutMs ?? 30_000,
  };
}

/** Site purely from environment variables, if present. */
export function siteFromEnv(): SiteConfig | null {
  const url = process.env.WOODPRESSER_SITE_URL || process.env.WP_URL;
  const username = process.env.WOODPRESSER_USER || process.env.WP_USER;
  const appPassword = process.env.WOODPRESSER_APP_PASSWORD || process.env.WP_APP_PASSWORD;
  if (!url || !username || !appPassword) return null;

  return normalizeSite({
    url,
    username,
    appPassword,
    bridgeToken: process.env.WOODPRESSER_BRIDGE_TOKEN || process.env.WP_BRIDGE_TOKEN,
    modes: (process.env.WOODPRESSER_MODES?.split(',').map((m) => m.trim()) as Mode[]) || DEFAULT_MODES,
    label: 'env',
    timeoutMs: Number(process.env.WOODPRESSER_TIMEOUT_MS || 30000),
  });
}

export interface ResolvedSite {
  name: string;
  site: SiteConfig;
  source: string;
}

export function resolveSite(name?: string, cwd = process.cwd()): ResolvedSite {
  const envSite = siteFromEnv();
  if (envSite) {
    registerSecrets([envSite.appPassword, envSite.bridgeToken]);
    return { name: 'env', site: envSite, source: 'environment' };
  }

  const { config, source } = loadConfig(cwd);
  const key = name || process.env.WOODPRESSER_SITE || config.defaultSite;

  if (!key) {
    const available = Object.keys(config.sites);
    if (available.length === 1) {
      const only = available[0]!;
      const site = normalizeSite(config.sites[only]!);
      registerSecrets([site.appPassword, site.bridgeToken]);
      return { name: only, site, source };
    }
    throw new Error(
      'No site selected. Run `woodpresser init` to connect a site, or pass site="<name>".',
    );
  }

  const raw = config.sites[key];
  if (!raw) {
    throw new Error(
      `Unknown site "${key}". Known sites: ${Object.keys(config.sites).join(', ') || '(none)'}.`,
    );
  }

  const site = normalizeSite(raw);
  registerSecrets([site.appPassword, site.bridgeToken]);
  return { name: key, site, source };
}

/**
 * Find a configured site by URL, project config first.
 *
 * Used by init so that re-running it does not mint a new bridge token and
 * silently break every other machine holding the old one.
 */
export function findSiteByUrl(
  url: string,
  cwd = process.cwd(),
): { name: string; site: SiteConfig } | null {
  const target = normalizeUrl(url).replace(/^https?:\/\//, '');
  for (const path of [projectConfigPath(cwd), userConfigPath()]) {
    const config = readConfigFile(path);
    if (!config) continue;
    for (const [name, site] of Object.entries(config.sites)) {
      // Scheme-agnostic: someone pasting http:// for a site stored as https://
      // is the same site, and must keep its token.
      if (normalizeUrl(site.url).replace(/^https?:\/\//, '') === target) {
        return { name, site: normalizeSite(site) };
      }
    }
  }
  return null;
}

/** Store or update a site. */
export function upsertSite(name: string, site: SiteConfig, path = userConfigPath()): ConfigFile {
  const config = readConfigFile(path) ?? emptyConfig();
  config.sites[name] = normalizeSite(site);
  config.defaultSite = config.defaultSite ?? name;
  writeConfigFile(path, config);
  return config;
}

/** Mask a secret for display. */
export function mask(secret?: string): string {
  if (!secret) return '(unset)';
  if (secret.length <= 8) return '****';
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
