import test from 'node:test';
import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url);
const { normalizeUrl, normalizeSite, mask, siteFromEnv, ALL_MODES, DEFAULT_MODES } = await import(
  new URL('config.js', base).href
);

test('normalizeUrl adds a scheme and strips paths', () => {
  assert.equal(normalizeUrl('example.com'), 'https://example.com');
  assert.equal(normalizeUrl('http://example.com/'), 'http://example.com');
  assert.equal(normalizeUrl('https://example.com/wp-admin'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/wp-json/'), 'https://example.com');
  assert.equal(normalizeUrl('  https://sub.example.com/site/  '), 'https://sub.example.com/site');
});

test('normalizeSite removes password spaces and defaults modes', () => {
  const site = normalizeSite({
    url: 'example.com/',
    username: 'admin',
    appPassword: 'abcd EFGH 1234 ijkl MNOP 5678',
    bridgeToken: 'tok',
    modes: ['core', 'bogus'],
  });

  assert.equal(site.url, 'https://example.com');
  assert.equal(site.appPassword, 'abcdEFGH1234ijklMNOP5678');
  assert.deepEqual(site.modes, ['core']);
  assert.equal(site.timeoutMs, 30000);
});

test('normalizeSite falls back to the safe default when no mode is valid', () => {
  const site = normalizeSite({
    url: 'https://example.com',
    username: 'a',
    appPassword: 'b',
    modes: ['nope'],
  });
  assert.deepEqual(site.modes, DEFAULT_MODES);
  assert.deepEqual(DEFAULT_MODES, ['core']);
  assert.ok(ALL_MODES.includes('php'));
});

test('normalizeSite adds no php access unless it was asked for', () => {
  const site = normalizeSite({ url: 'https://example.com', username: 'a', appPassword: 'b' });
  assert.deepEqual(site.modes, ['core']);
});

test('mask never reveals the middle of a secret', () => {
  const secret = 'abcdefghijklmnopqrstuvwxyz';
  const masked = mask(secret);
  assert.ok(masked.includes('abcd'));
  assert.ok(masked.includes('wxyz'));
  assert.ok(!masked.includes('ghijklmn'));
  assert.equal(mask(''), '(unset)');
  assert.equal(mask('short'), '****');
});

test('siteFromEnv reads all variables', () => {
  const saved = { ...process.env };
  process.env.WOODPRESSER_SITE_URL = 'https://env.example.com';
  process.env.WOODPRESSER_USER = 'envuser';
  process.env.WOODPRESSER_APP_PASSWORD = 'abcd efgh 1234 ijkl mnop 5678';
  process.env.WOODPRESSER_BRIDGE_TOKEN = 'env-token-value';
  process.env.WOODPRESSER_MODES = 'core,php';

  try {
    const site = siteFromEnv();
    assert.equal(site.url, 'https://env.example.com');
    assert.equal(site.username, 'envuser');
    assert.deepEqual(site.modes, ['core', 'php']);
  } finally {
    for (const key of [
      'WOODPRESSER_SITE_URL',
      'WOODPRESSER_USER',
      'WOODPRESSER_APP_PASSWORD',
      'WOODPRESSER_BRIDGE_TOKEN',
      'WOODPRESSER_MODES',
    ]) {
      delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
});

test('siteFromEnv returns null without a url', () => {
  const saved = { ...process.env };
  delete process.env.WOODPRESSER_SITE_URL;
  try {
    assert.equal(siteFromEnv(), null);
  } finally {
    Object.assign(process.env, saved);
  }
});
