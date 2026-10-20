import test from 'node:test';
import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url);
const { redact, redactString, registerSecrets } = await import(new URL('util/redact.js', base).href);

const APP_PASSWORD = 'abcd EFGH 1234 ijkl MNOP 5678';
const TOKEN = 'Zm9vYmFyLXRva2VuLXZhbHVlLTEyMzQ1Ng';

test('key-based redaction covers credential fields', () => {
  const out = redact({
    url: 'https://example.com',
    username: 'admin',
    appPassword: APP_PASSWORD,
    bridgeToken: TOKEN,
    nested: { authorization: 'Basic abcdefgh', nonce: 'deadbeef', keep: 'yes' },
  });

  assert.equal(out.url, 'https://example.com');
  assert.equal(out.username, 'admin');
  assert.equal(out.appPassword, '[redacted]');
  assert.equal(out.bridgeToken, '[redacted]');
  assert.equal(out.nested.authorization, '[redacted]');
  assert.equal(out.nested.nonce, '[redacted]');
  assert.equal(out.nested.keep, 'yes');
});

test('registered secrets are scrubbed from free text, spaced or not', () => {
  registerSecrets([APP_PASSWORD, TOKEN]);
  const text = `failed with ${APP_PASSWORD} and ${APP_PASSWORD.replace(/ /g, '')} using ${TOKEN}`;
  const out = redactString(text);
  assert.ok(!out.includes('abcd'));
  assert.ok(!out.includes(TOKEN));
  assert.ok(out.includes('[redacted]'));
});

test('authorization headers are scrubbed even when unregistered', () => {
  const out = redactString('Authorization: Basic YWRtaW46c3VwZXJzZWNyZXQ= ; Bearer abcdefghijklmnop');
  assert.ok(!out.includes('YWRtaW46'));
  assert.ok(!out.includes('abcdefghijklmnop'));
  assert.ok(out.includes('Basic [redacted]'));
  assert.ok(out.includes('Bearer [redacted]'));
});

test('unregistered opaque strings are left alone', () => {
  // Redaction is key-based or registration-based on purpose: guessing at
  // entropy would destroy hashes, ids and slugs in diagnostic output.
  assert.equal(redactString('post_id=1234 revision=abcdef'), 'post_id=1234 revision=abcdef');
});

test('arrays and primitives pass through', () => {
  assert.deepEqual(redact([1, 'plain', null]), [1, 'plain', null]);
  assert.equal(redact(42), 42);
  assert.equal(redact(null), null);
});
