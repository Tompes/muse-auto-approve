/*
** Build the release artifacts from extension/:
**
**     muse-auto-approve-<version>.zip   for "Load unpacked" and the Chrome Web Store
**     muse-auto-approve-<version>.crx   signed, only when a private key is given
**
** Every file under extension/ is packaged except hidden files (editor and
** OS litter such as .DS_Store). Paths are sorted so the archive does not
** depend on directory listing order. The built archive is read back and
** compared with the sources before anything is written.
*/
import fs from 'node:fs';
import path from 'node:path';
import { createZip, readZip } from './zip.mjs';
import { createCrx, verifyCrx } from './crx.mjs';

export const NAME = 'muse-auto-approve';

export function collectFiles(dir) {
  const files = [];
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(dir, relative), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) files.push({ name, data: fs.readFileSync(path.join(dir, name)) });
    }
  };
  walk('');
  // Code-unit order, not locale order, so the result is the same on every machine.
  return files.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
}

/*
** root: the repository root. privateKeyPem: optional. expectedVersion:
** optional, e.g. from a git tag; the build fails if the manifest disagrees.
** Returns { version, files: [{ name, data }], id? } without writing anything.
*/
export function buildRelease({ root, privateKeyPem, expectedVersion }) {
  const extension = path.join(root, 'extension');
  const { version } = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.version !== version) throw new Error(`manifest version ${version} differs from package.json ${pkg.version}`);
  if (expectedVersion !== undefined && expectedVersion !== version) {
    throw new Error(`tag version ${expectedVersion} differs from manifest version ${version}`);
  }

  const sources = collectFiles(extension);
  const zip = createZip(sources);
  const unpacked = readZip(zip);
  if (unpacked.length !== sources.length ||
      unpacked.some((file, i) => file.name !== sources[i].name || !file.data.equals(sources[i].data))) {
    throw new Error('the archive does not match the extension sources');
  }

  const base = `${NAME}-${version}`;
  const artifacts = [{ name: `${base}.zip`, data: zip }];
  if (!privateKeyPem) return { version, files: artifacts };
  const crx = createCrx(zip, privateKeyPem);
  const { id } = verifyCrx(crx);
  artifacts.push({ name: `${base}.crx`, data: crx });
  return { version, files: artifacts, id };
}
