import test from 'node:test';
import assert from 'node:assert/strict';

const base = new URL('../dist/', import.meta.url);

const { upsertRootProperty, upsertNestedProperty, removeNestedProperty, readRootProperty, validateJsonc, stripJsonc } =
  await import(new URL('util/jsonc.js', base).href);

const SAMPLE = `{
  // top comment survives
  "$schema": "https://opencode.ai/config.json",
  "theme": "jarvis-arc",
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["node", "memory.js"],
      "enabled": true
    },
    // the mcp block is commented
  },
  "permission": { "edit": "allow", },
}
`;

test('stripJsonc removes comments and trailing commas', () => {
  const parsed = JSON.parse(stripJsonc(SAMPLE));
  assert.equal(parsed.theme, 'jarvis-arc');
  assert.equal(parsed.mcp.memory.enabled, true);
});

test('upsertRootProperty inserts without touching comments', () => {
  const out = upsertRootProperty(SAMPLE, 'model', 'anthropic/claude');
  assert.ok(out.includes('// top comment survives'));
  assert.ok(out.includes('// the mcp block is commented'));
  const parsed = JSON.parse(stripJsonc(out));
  assert.equal(parsed.model, 'anthropic/claude');
  assert.equal(parsed.mcp.memory.type, 'local');
  assert.ok(validateJsonc(out).ok);
});

test('upsertRootProperty replaces an existing value in place', () => {
  const out = upsertRootProperty(SAMPLE, 'theme', 'arc-dark');
  assert.equal(JSON.parse(stripJsonc(out)).theme, 'arc-dark');
  assert.equal(out.match(/"theme"/g).length, 1);
});

test('upsertNestedProperty adds a server and keeps siblings', () => {
  const entry = { type: 'local', command: ['node', 'cli.js', 'mcp'], enabled: true };
  const out = upsertNestedProperty(SAMPLE, 'mcp', 'woodpresser', entry);
  const parsed = JSON.parse(stripJsonc(out));
  assert.deepEqual(parsed.mcp.woodpresser, entry);
  assert.equal(parsed.mcp.memory.command[1], 'memory.js');
  assert.equal(parsed.$schema, 'https://opencode.ai/config.json');
  assert.ok(out.includes('// the mcp block is commented'));
});

test('upsertNestedProperty is idempotent for identical values', () => {
  const entry = { type: 'local', command: ['node', 'cli.js'], enabled: true };
  const once = upsertNestedProperty(SAMPLE, 'mcp', 'woodpresser', entry);
  const twice = upsertNestedProperty(once, 'mcp', 'woodpresser', entry);
  assert.equal(twice, once);
  assert.equal(JSON.parse(stripJsonc(twice)).mcp.woodpresser.command.length, 2);
});

test('upsertNestedProperty creates the parent object when missing', () => {
  const out = upsertNestedProperty('{\n}\n', 'mcp', 'woodpresser', { type: 'local' });
  assert.deepEqual(JSON.parse(stripJsonc(out)), { mcp: { woodpresser: { type: 'local' } } });
});

test('removeNestedProperty removes a middle entry and leaves valid JSON', () => {
  const added = upsertNestedProperty(SAMPLE, 'mcp', 'other', { type: 'local' });
  const removed = removeNestedProperty(added, 'mcp', 'other');
  const parsed = JSON.parse(stripJsonc(removed));
  assert.equal(parsed.mcp.other, undefined);
  assert.equal(parsed.mcp.memory.type, 'local');
  assert.ok(validateJsonc(removed).ok);
});

test('removeNestedProperty removes the only entry', () => {
  const one = '{\n  "mcp": {\n    "x": { "a": 1 }\n  }\n}\n';
  const out = removeNestedProperty(one, 'mcp', 'x');
  assert.deepEqual(JSON.parse(stripJsonc(out)), { mcp: {} });
});

test('removeNestedProperty is a no-op for unknown keys', () => {
  assert.equal(removeNestedProperty(SAMPLE, 'mcp', 'nope'), SAMPLE);
});

test('readRootProperty parses nested values', () => {
  const value = readRootProperty(SAMPLE, 'mcp');
  assert.equal(value.memory.type, 'local');
  assert.equal(readRootProperty(SAMPLE, 'missing'), undefined);
});

test('validateJsonc rejects broken input', () => {
  assert.equal(validateJsonc('{ "a": 1 ').ok, false);
});
