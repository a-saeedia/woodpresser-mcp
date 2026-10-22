/**
 * Behaviour that protects a user from silently losing access.
 *
 * Two things must never regress: re-running `init` keeps the bridge token that
 * other machines already hold, and a site record with no modes never implies
 * php/elementor powers.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const base = new URL('../dist/', import.meta.url);
const { findSiteByUrl, upsertSite, normalizeSite } = await import(new URL('config.js', base).href);
const { createContext, hasMode } = await import(new URL('tools/context.js', base).href);

test('findSiteByUrl matches across scheme changes so init keeps the token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wp-find-'));
  const path = join(dir, 'config.json');
  const saved = process.env.WOODPRESSER_CONFIG;
  process.env.WOODPRESSER_CONFIG = path;
  try {
    upsertSite(
      'example',
      { url: 'https://example.com/', username: 'admin', appPassword: 'x', bridgeToken: 'keep-me' },
      path,
    );

    const hit = findSiteByUrl('http://example.com', dir);
    assert.equal(hit?.name, 'example');
    assert.equal(hit?.site.bridgeToken, 'keep-me');

    assert.equal(findSiteByUrl('https://other.example', dir), null);
  } finally {
    process.env.WOODPRESSER_CONFIG = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a site record with no modes is core-only, never everything', () => {
  const site = normalizeSite({ url: 'https://example.com', username: 'admin', appPassword: 'x' });
  delete site.modes; // simulates a hand-edited or legacy config file
  const ctx = createContext('bare', site);
  assert.equal(hasMode(ctx, 'core'), true);
  assert.equal(hasMode(ctx, 'php'), false, 'a site without modes must not get PHP');
  assert.equal(hasMode(ctx, 'elementor'), false);
});

test('the reported version matches package.json', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { VERSION } = await import(new URL('version.js', base).href);
  assert.equal(VERSION, pkg.version, 'bump both together, or the tag lies about what it ships');
});
