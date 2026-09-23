import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createZip, readZip } from '../scripts/lib/zip.mjs';
import { createCrx, verifyCrx, extensionId, publicKeyDer } from '../scripts/lib/crx.mjs';
import { buildRelease, collectFiles, NAME } from '../scripts/lib/release.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const FIXTURE = fs.readFileSync(new URL('fixtures/chrome-packed.crx', import.meta.url));
const rsaKey = (bits = 2048) => crypto.generateKeyPairSync('rsa', { modulusLength: bits })
  .privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY = rsaKey();
/* Encode one length-delimited protobuf field. */
function proto(number, bytes) {
  const varint = value => {
    const out = [];
    while (value > 0x7f) { out.push((value & 0x7f) | 0x80); value >>>= 7; }
    out.push(value);
    return Buffer.from(out);
  };
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}
const files = [
  { name: 'manifest.json', data: Buffer.from('{"version":"1.0.0"}\n') },
  { name: 'lib/中文.mjs', data: Buffer.from('export const x = 1;\n'.repeat(200)) },
  { name: 'empty.txt', data: Buffer.alloc(0) },
];

describe('zip', () => {
  test('round-trips names, including UTF-8, and contents', () => {
    assert.deepEqual(readZip(createZip(files)), files);
  });

  test('is deterministic', () => {
    assert.ok(createZip(files).equals(createZip(files)));
  });

  const noUnzip = spawnSync('unzip', ['-v']).error && 'unzip not installed';
  test('can be read by the system unzip tool', { skip: noUnzip }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
    fs.writeFileSync(path.join(dir, 'a.zip'), createZip(files));
    const result = spawnSync('unzip', ['-t', path.join(dir, 'a.zip')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  test('refuses unsafe entry names', () => {
    for (const name of ['', '/abs', '../up', 'a/../b', 'back\\slash']) {
      assert.throws(() => createZip([{ name, data: Buffer.alloc(0) }]), /unsafe/);
    }
  });

  test('refuses archives that need ZIP64', () => {
    const many = Array.from({ length: 0x10000 }, (_, i) => ({ name: `f${i}`, data: Buffer.alloc(0) }));
    assert.throws(() => createZip(many), /too many files/);
    const kilobyte = { name: 'k', data: crypto.randomBytes(1024) };
    assert.throws(() => createZip([kilobyte], { maxBytes: 1000 }), /too large/);
    assert.throws(() => createZip([kilobyte, { ...kilobyte, name: 'l' }], { maxBytes: 2000 }), /too large/);
    assert.equal(readZip(createZip([kilobyte], { maxBytes: 2000 })).length, 1);
  });

  test('reads stored entries and rejects corruption', () => {
    const stored = createZip([{ name: 'a', data: Buffer.from('hello') }]);
    const raw = Buffer.from(stored);
    // Rewrite as method 0 (stored) with the uncompressed bytes in place.
    const data = Buffer.from('hello');
    const rebuilt = Buffer.concat([raw.subarray(0, 30 + 1), data]);
    rebuilt.writeUInt16LE(0, 8);
    rebuilt.writeUInt32LE(data.length, 18);
    const central = raw.subarray(raw.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
    const fixed = Buffer.from(central);
    fixed.writeUInt16LE(0, 10);
    fixed.writeUInt32LE(data.length, 20);
    fixed.writeUInt32LE(rebuilt.length, fixed.length - 6);
    assert.deepEqual(readZip(Buffer.concat([rebuilt, fixed])), [{ name: 'a', data }]);

    assert.throws(() => readZip(Buffer.from('not a zip')), /not a ZIP/);
    const badCrc = Buffer.from(stored);
    badCrc[badCrc.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 16] ^= 1;
    assert.throws(() => readZip(badCrc), /CRC mismatch/);
    const badMethod = Buffer.from(stored);
    badMethod.writeUInt16LE(12, badMethod.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 10);
    assert.throws(() => readZip(badMethod), /unsupported compression/);
    const badCentral = Buffer.from(stored);
    badCentral.writeUInt32LE(0, badCentral.indexOf(Buffer.from([0x50, 0x4b, 1, 2])));
    assert.throws(() => readZip(badCentral), /corrupt central/);
    const badLocal = Buffer.from(stored);
    badLocal.writeUInt32LE(0, 0);
    assert.throws(() => readZip(badLocal), /corrupt local/);
  });
});

describe('crx', () => {
  test('verifies a CRX packed by Google Chrome and derives the same ID', () => {
    const { id, archive } = verifyCrx(FIXTURE);
    assert.equal(id, 'hgcghileomhcmgigbcokanlpcnejhdcm');
    assert.deepEqual(readZip(archive).map(f => f.name), ['manifest.json']);
  });

  test('signs an archive that verifies, with the ID of the key', () => {
    const archive = createZip(files);
    const { id, archive: inside } = verifyCrx(createCrx(archive, KEY));
    assert.equal(id, extensionId(publicKeyDer(KEY)));
    assert.match(id, /^[a-p]{32}$/);
    assert.ok(inside.equals(archive));
  });

  test('signing is deterministic, as with Chrome', () => {
    const archive = createZip(files);
    assert.ok(createCrx(archive, KEY).equals(createCrx(archive, KEY)));
  });

  test('handles protobuf lengths that need multi-byte varints', () => {
    const big = rsaKey(4096);
    assert.equal(verifyCrx(createCrx(createZip(files), big)).id, extensionId(publicKeyDer(big)));
  });

  test('refuses non-RSA keys', () => {
    const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => createCrx(createZip(files), ec), /RSA key/);
  });

  test('rejects tampering and malformed files', () => {
    const crx = createCrx(createZip(files), KEY);
    const headerEnd = 12 + crx.readUInt32LE(8);
    const flip = at => { const copy = Buffer.from(crx); copy[at] ^= 1; return copy; };

    assert.throws(() => verifyCrx(flip(crx.length - 30)), /does not verify/);
    assert.throws(() => verifyCrx(Buffer.from('PK')), /not a CRX/);
    assert.throws(() => verifyCrx(flip(0)), /not a CRX/);
    const v2 = Buffer.from(crx); v2.writeUInt32LE(2, 4);
    assert.throws(() => verifyCrx(v2), /version 2/);
    const long = Buffer.from(crx); long.writeUInt32LE(crx.length, 8);
    assert.throws(() => verifyCrx(long), /truncated CRX header/);

    const withHeader = header => {
      const prefix = Buffer.from(crx.subarray(0, 12));
      prefix.writeUInt32LE(header.length, 8);
      return Buffer.concat([prefix, header, crx.subarray(headerEnd)]);
    };
    const f = (n, b) => Buffer.concat([Buffer.from([(n << 3) | 2, b.length]), b]);
    const signedData = Buffer.from([0x82, 0xf1, 0x04, 18, 0x0a, 16, ...Buffer.alloc(16)]);
    assert.throws(() => verifyCrx(withHeader(Buffer.alloc(0))), /no signed ID/);
    assert.throws(() => verifyCrx(withHeader(signedData)), /no RSA signature/);
    assert.throws(() => verifyCrx(withHeader(Buffer.concat([f(2, f(1, Buffer.from('k'))), signedData]))), /incomplete/);
    assert.throws(() => verifyCrx(withHeader(Buffer.from([0x08, 0x01]))), /wire type/);
    assert.throws(() => verifyCrx(withHeader(Buffer.from([0x12, 0x80]))), /truncated protobuf/);
    assert.throws(() => verifyCrx(withHeader(Buffer.from([0x12, 0x05, 0x00]))), /truncated protobuf/);

    // Correctly signed, but the declared ID belongs to no signing key.
    const archive = createZip(files);
    const wrongId = Buffer.concat([Buffer.from([0x0a, 16]), Buffer.alloc(16, 7)]);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(wrongId.length);
    const signature = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, wrongId, archive]),
      crypto.createPrivateKey(KEY));
    const der = publicKeyDer(KEY);
    const proof = Buffer.concat([proto(1, der), proto(2, signature)]);
    const header = Buffer.concat([proto(2, proof), proto(10000, wrongId)]);
    const prefix = Buffer.from(crx.subarray(0, 12));
    prefix.writeUInt32LE(header.length, 8);
    assert.throws(() => verifyCrx(Buffer.concat([prefix, header, archive])), /does not match any signing key/);
  });
});

describe('release', () => {
  const repo = ({ manifestVersion = '1.2.3', packageVersion = '1.2.3' } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-'));
    fs.mkdirSync(path.join(dir, 'extension/lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extension/manifest.json'), JSON.stringify({ version: manifestVersion }));
    fs.writeFileSync(path.join(dir, 'extension/lib/b.mjs'), 'b');
    fs.writeFileSync(path.join(dir, 'extension/a.js'), 'a');
    fs.writeFileSync(path.join(dir, 'extension/.DS_Store'), 'junk');
    fs.mkdirSync(path.join(dir, 'extension/.hidden'));
    fs.writeFileSync(path.join(dir, 'extension/.hidden/x'), 'x');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: packageVersion }));
    return dir;
  };

  test('packages every source file, sorted, without hidden files', () => {
    const { version, files: out, id } = buildRelease({ root: repo() });
    assert.equal(version, '1.2.3');
    assert.equal(id, undefined);
    assert.deepEqual(out.map(f => f.name), [`${NAME}-1.2.3.zip`]);
    assert.deepEqual(readZip(out[0].data).map(f => f.name), ['a.js', 'lib/b.mjs', 'manifest.json']);
  });

  test('adds a verified CRX when a key is given', () => {
    const { files: out, id } = buildRelease({ root: repo(), privateKeyPem: KEY });
    assert.deepEqual(out.map(f => f.name), [`${NAME}-1.2.3.zip`, `${NAME}-1.2.3.crx`]);
    assert.equal(verifyCrx(out[1].data).id, id);
    assert.ok(verifyCrx(out[1].data).archive.equals(out[0].data));
  });

  test('refuses mismatched versions', () => {
    assert.throws(() => buildRelease({ root: repo({ packageVersion: '1.2.4' }) }), /differs from package.json/);
    assert.throws(() => buildRelease({ root: repo(), expectedVersion: '1.2.4' }), /tag version 1.2.4/);
    assert.equal(buildRelease({ root: repo(), expectedVersion: '1.2.3' }).version, '1.2.3');
  });

  test('refuses an archive that does not match its sources', t => {
    const dir = repo();
    t.mock.method(Buffer.prototype, 'equals', function () { return false; });
    assert.throws(() => buildRelease({ root: dir }), /does not match/);
  });

  test('collects the real extension, including every locale', () => {
    const names = collectFiles(path.join(ROOT, 'extension')).map(f => f.name);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('_locales/zh_CN/messages.json'));
    assert.ok(names.every(n => !n.split('/').some(part => part.startsWith('.'))));
  });

  test('the command line writes dist/ and prints the ID', () => {
    const dir = repo();
    fs.mkdirSync(path.join(dir, 'scripts/lib'), { recursive: true });
    for (const f of ['package.mjs', 'lib/release.mjs', 'lib/zip.mjs', 'lib/crx.mjs']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', f), path.join(dir, 'scripts', f));
    }
    const run = (args, env = {}) => spawnSync(process.execPath, [path.join(dir, 'scripts/package.mjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, CRX_PRIVATE_KEY: '', ...env },
    });
    const plain = run([]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /CRX skipped/);

    fs.writeFileSync(path.join(dir, 'key.pem'), KEY);
    const signed = run(['--key', path.join(dir, 'key.pem'), '--expect-version', '1.2.3']);
    assert.match(signed.stdout, new RegExp(`extension ID: ${extensionId(publicKeyDer(KEY))}`));
    assert.ok(fs.existsSync(path.join(dir, `dist/${NAME}-1.2.3.crx`)));

    assert.equal(run([], { CRX_PRIVATE_KEY: KEY }).status, 0);
    assert.notEqual(run(['--expect-version', '9.9.9']).status, 0);
  });
});
