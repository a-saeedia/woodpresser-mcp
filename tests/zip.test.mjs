import test from 'node:test';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

const { makeZip, bridgeZip } = await import(new URL('../dist/util/zip.js', import.meta.url).href);

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const EOCD = 0x06054b50;

function readUInt32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

test('makeZip writes a readable archive structure', () => {
  const big = Buffer.from('x'.repeat(2000)); // above the deflate threshold
  const small = Buffer.from('tiny');
  const zip = makeZip([
    { name: 'a/big.txt', data: big, date: new Date(2026, 0, 2, 3, 4, 6) },
    { name: 'a/small.txt', data: small, date: new Date(2026, 0, 2, 3, 4, 6) },
  ]);

  assert.equal(readUInt32(zip, 0), LOCAL, 'starts with a local file header');

  const eocdOffset = zip.length - 22;
  assert.equal(readUInt32(zip, eocdOffset), EOCD, 'ends with an end-of-central-directory record');
  assert.equal(zip.readUInt16LE(eocdOffset + 8), 2, 'entry count');
  assert.equal(zip.readUInt16LE(eocdOffset + 10), 2, 'central directory entry count');

  const centralStart = readUInt32(zip, eocdOffset + 16);
  assert.equal(readUInt32(zip, centralStart), CENTRAL, 'central directory starts where the EOCD says');

  const text = zip.toString('latin1');
  assert.ok(text.includes('a/big.txt'));
  assert.ok(text.includes('a/small.txt'));

  // Compression actually happened for the big entry, and not for the small one.
  assert.ok(zip.length < big.length, 'archive is smaller than the raw payload');
});

test('makeZip stores the correct CRC and sizes per entry', () => {
  const data = Buffer.from('woodpresser bridge payload');
  const zip = makeZip([{ name: 'one.php', data, date: new Date(2026, 0, 2) }]);

  assert.equal(zip.readUInt32LE(14), crc32(data) >>> 0, 'local header CRC');
  assert.equal(zip.readUInt32LE(18), data.length, 'compressed size (stored)');
  assert.equal(zip.readUInt32LE(22), data.length, 'uncompressed size');
  assert.equal(zip.readUInt16LE(8), 0, 'method 0 for a tiny entry');
});

test('bridgeZip puts the plugin inside its own folder', () => {
  const plugin = Buffer.from('<?php // bridge');
  const zip = bridgeZip(plugin, new Date(2026, 0, 2));

  assert.equal(readUInt32(zip, 0), LOCAL);
  assert.ok(
    zip.toString('latin1').includes('woodpresser-bridge/woodpresser-bridge.php'),
    'wp-admin unpacks the plugin into wp-content/plugins/woodpresser-bridge/',
  );
});

test('makeZip refuses an empty archive', () => {
  assert.throws(() => makeZip([]), /at least one entry/);
});
