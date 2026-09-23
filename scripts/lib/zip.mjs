/*
** Minimal ZIP writer and reader (deflate only, no ZIP64, no encryption).
**
** The writer is deterministic: entries are stored in the order given, with a
** fixed timestamp, so the same files produce the same bytes on the same
** Node.js version. Chrome and the Chrome Web Store accept its output; the
** reader exists so tests and the packager can verify what was written.
*/
import zlib from 'node:zlib';

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const VERSION = 20;
// 1980-01-01 00:00, the earliest DOS date. Real mtimes would make builds unreproducible.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

/*
** files: [{ name, data }] with '/'-separated relative names. Returns a Buffer.
** maxBytes is the ZIP32 limit; tests lower it to exercise the check.
*/
export function createZip(files, { maxBytes = MAX_U32 } = {}) {
  if (files.length > MAX_U16) throw new Error('too many files for a ZIP without ZIP64');
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    if (!name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) {
      throw new Error(`unsafe ZIP entry name: ${name}`);
    }
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const entryEnd = offset + 30 + nameBytes.length + compressed.length;
    if (data.length > maxBytes || entryEnd > maxBytes) throw new Error('archive too large for a ZIP without ZIP64');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(VERSION, 4);
    central.writeUInt16LE(VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/*
** Read an archive written by createZip() or a common zip tool. Returns
** [{ name, data }] in central-directory order. Throws on anything malformed,
** including a CRC mismatch.
*/
export function readZip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0 || endAt + 22 > buffer.length) throw new Error('not a ZIP archive');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const files = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(at + 10);
    const crc = buffer.readUInt32LE(at + 16);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const localAt = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (buffer.readUInt32LE(localAt) !== LOCAL) throw new Error(`corrupt local header for ${name}`);
    const dataAt = localAt + 30 + buffer.readUInt16LE(localAt + 26) + buffer.readUInt16LE(localAt + 28);
    const raw = buffer.subarray(dataAt, dataAt + compressedSize);
    let data;
    if (method === DEFLATE) data = zlib.inflateRawSync(raw);
    else if (method === 0) data = Buffer.from(raw);
    else throw new Error(`unsupported compression method ${method} for ${name}`);
    if (zlib.crc32(data) !== crc) throw new Error(`CRC mismatch for ${name}`);
    files.push({ name, data });
  }
  return files;
}
