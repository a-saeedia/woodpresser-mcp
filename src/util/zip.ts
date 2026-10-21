/**
 * Minimal ZIP writer — store + deflate, no dependencies.
 *
 * Used to ship the bridge plugin as something a human can upload through
 * wp-admin ("Plugins → Add New → Upload"), which only accepts archives. Node
 * has `deflateRawSync` and `crc32`, so a 150-line writer beats adding a
 * dependency to a package that has exactly two.
 */
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  /** Path inside the archive, forward slashes, no leading slash. */
  name: string;
  data: Buffer;
  date?: Date;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function makeZip(entries: ZipEntry[]): Buffer {
  if (!entries.length) throw new Error('makeZip needs at least one entry');

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    // Tiny files are not worth a deflate header.
    const useDeflate = data.length > 256;
    const payload = useDeflate ? deflateRawSync(data, { level: 9 }) : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data) >>> 0;
    const { time, day } = dosDateTime(entry.date ?? new Date());

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); // local file header
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0, 6); // flags
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28); // extra length

    local.push(header, name, payload);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0); // central directory header
    record.writeUInt16LE(20, 4); // version made by
    record.writeUInt16LE(20, 6); // version needed
    record.writeUInt16LE(0, 8); // flags
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(day, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(payload.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30); // extra
    record.writeUInt16LE(0, 32); // comment
    record.writeUInt16LE(0, 34); // disk
    record.writeUInt16LE(0, 36); // internal attrs
    record.writeUInt32LE(0, 38); // external attrs
    record.writeUInt32LE(offset, 42); // local header offset

    central.push(record, name);
    offset += header.length + name.length + payload.length;
  }

  const centralSize = central.reduce((sum, buffer) => sum + buffer.length, 0);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // disk
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16); // central dir offset
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...local, ...central, end]);
}

/** Wrap the bridge plugin in the folder wp-admin expects when unpacking. */
export function bridgeZip(plugin: Buffer, date?: Date): Buffer {
  return makeZip([{ name: 'woodpresser-bridge/woodpresser-bridge.php', data: plugin, date }]);
}
