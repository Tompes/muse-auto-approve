import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOCALES } from '../extension/lib/i18n.mjs';

const ROOT = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, ROOT), 'utf8');
const exists = path => fs.existsSync(new URL(path, ROOT));
const manifest = JSON.parse(read('extension/manifest.json'));
const pkg = JSON.parse(read('package.json'));

test('manifest and package versions agree', () => {
  assert.equal(manifest.version, pkg.version);
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test('every file the manifest names exists', () => {
  const files = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap(c => c.js),
    `_locales/${manifest.default_locale}/messages.json`,
  ];
  for (const file of files) assert.ok(exists(`extension/${file}`), file);
});

test('the extension asks for the minimum permissions', () => {
  assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'alarms']);
  assert.deepEqual(manifest.host_permissions, ['https://muse.ai/*']);
  assert.deepEqual(manifest.content_scripts.map(c => c.matches), [['https://muse.ai/*']]);
  assert.equal(manifest.externally_connectable, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
});

test('the default locale is the i18n fallback', () => {
  assert.equal(manifest.default_locale, LOCALES[0]);
});

test('the worker injects the content script the manifest declares', () => {
  const [declared] = manifest.content_scripts[0].js;
  assert.match(read('extension/lib/worker.mjs'), new RegExp(`files: \\['${declared}'\\]`));
});

test('the popup loads its module entry point', () => {
  assert.match(read('extension/popup.html'), /<script type="module" src="popup\.mjs"><\/script>/);
});

test('the release workflow ships what the packager builds', () => {
  const workflow = read('.github/workflows/release.yml');
  assert.match(workflow, /node scripts\/package\.mjs --expect-version "\$\{GITHUB_REF_NAME#v\}"/);
  assert.match(workflow, /secrets\.CRX_PRIVATE_KEY/);
  assert.match(workflow, /dist\/\*\.zip dist\/\*\.crx/);
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[${pkg.version.replaceAll('.', '\\.')}\\]`, 'm'));
});

test('signing keys and build output are never committed', () => {
  const ignored = read('.gitignore').split('\n');
  for (const pattern of ['dist/', '*.pem', '*.crx']) assert.ok(ignored.includes(pattern), pattern);
});

test('every icon exists, is a PNG and has its declared size', () => {
  const declared = [...Object.entries(manifest.icons), ...Object.entries(manifest.action.default_icon)];
  assert.deepEqual(Object.keys(manifest.icons), ['16', '32', '48', '128']);
  for (const [size, file] of declared) {
    const png = fs.readFileSync(new URL(`extension/${file}`, ROOT));
    assert.ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), file);
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [Number(size), Number(size)], file);
  }
});

test('the popup shows the extension icon', () => {
  assert.match(read('extension/popup.html'), /<img class="logo" src="icons\/icon-128\.png" alt="">/);
});
