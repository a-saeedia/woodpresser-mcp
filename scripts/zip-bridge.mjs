#!/usr/bin/env node
/**
 * Build dist/woodpresser-bridge.zip without any dependency.
 *
 * The archive contains the plugin in its own folder so that uploading it
 * through wp-admin "Plugins -> Add New -> Upload" produces the expected
 * wp-content/plugins/woodpresser-bridge/woodpresser-bridge.php layout.
 *
 * Store-only (no compression) keeps this dependency-free and deterministic.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = join(root, 'bridge', 'woodpresser-bridge.php');
const outDir = join(root, 'dist');
const target = join(outDir, 'woodpresser-bridge.zip');

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const useDeflate = data.length > 256;
    const payload = useDeflate ? deflateRawSync(data, { level: 9 }) : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data) >>> 0;
    const { time, day } = dosDateTime(entry.date ?? new Date());

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);

    local.push(header, name, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(day, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);

    central.push(record, name);
    offset += header.length + name.length + payload.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end]);
}

const plugin = readFileSync(source);
const zip = makeZip([
  { name: 'woodpresser-bridge/woodpresser-bridge.php', data: plugin, date: statSync(source).mtime },
]);

mkdirSync(outDir, { recursive: true });
writeFileSync(target, zip);
process.stdout.write(`${target} (${(zip.length / 1024).toFixed(1)} KiB)\n`);
