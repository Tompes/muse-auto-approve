/*
** Static checks that need no dependencies. Run with `npm run check`.
**
**   - every JavaScript file parses
**   - every JSON file parses
**   - text hygiene: LF line endings, no tabs, no trailing whitespace,
**     exactly one final newline, lines at most MAX_LINE characters
**   - no console output or debugger statements in shipped code
**
** Exits non-zero and lists every problem found.
*/
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAX_LINE = 120;
// Hidden directories belong to editors and tools, except the CI configuration.
const skip = name => name === 'node_modules' || (name.startsWith('.') && name !== '.github');
const TEXT = new Set(['.js', '.mjs', '.json', '.html', '.css', '.md', '.yml', '.yaml']);
const problems = [];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && skip(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file);
  const ext = path.extname(file);
  if (!TEXT.has(ext) && !['LICENSE', '.gitignore', '.editorconfig'].includes(path.basename(file))) continue;
  const text = fs.readFileSync(file, 'utf8');

  if (text.includes('\r')) problems.push(`${rel}: CR line endings`);
  if (!text.endsWith('\n') || text.endsWith('\n\n')) problems.push(`${rel}: must end with exactly one newline`);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const where = `${rel}:${i + 1}`;
    if (line.includes('\t')) problems.push(`${where}: tab character`);
    if (/\s$/.test(line)) problems.push(`${where}: trailing whitespace`);
    if (ext !== '.md' && ext !== '.json' && line.length > MAX_LINE) {
      problems.push(`${where}: ${line.length} characters (max ${MAX_LINE})`);
    }
  });

  if (ext === '.json') {
    try {
      JSON.parse(text);
    } catch (error) {
      problems.push(`${rel}: invalid JSON (${error.message})`);
    }
  }
  if (ext === '.js' || ext === '.mjs') {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) problems.push(`${rel}: syntax error\n${result.stderr}`);
    if (rel.startsWith(`extension${path.sep}`) && /\bconsole\.\w+\(|\bdebugger\b/.test(text)) {
      problems.push(`${rel}: console output or debugger statement in shipped code`);
    }
  }
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s).`);
  process.exit(1);
}
console.log('check: ok');
