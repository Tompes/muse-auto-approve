/*
** Build release artifacts into dist/.
**
**     node scripts/package.mjs [--key key.pem] [--expect-version 1.2.3]
**
** The signing key can also come from the CRX_PRIVATE_KEY environment
** variable (the PEM text), which is how CI provides it. Without a key only
** the ZIP is built. The key decides the extension ID: keep it secret and
** keep a backup, because a new key means a new extension.
*/
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildRelease } from './lib/release.mjs';

const root = path.resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { key: { type: 'string' }, 'expect-version': { type: 'string' } } });
const privateKeyPem = values.key ? fs.readFileSync(values.key, 'utf8') : process.env.CRX_PRIVATE_KEY || undefined;

const release = buildRelease({ root, privateKeyPem, expectedVersion: values['expect-version'] });
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });
for (const file of release.files) {
  fs.writeFileSync(path.join(dist, file.name), file.data);
  console.log(`dist/${file.name}  ${file.data.length} bytes`);
}
if (release.id) console.log(`extension ID: ${release.id}`);
else console.log('no signing key given: CRX skipped');
