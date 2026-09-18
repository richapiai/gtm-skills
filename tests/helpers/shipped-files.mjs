// tests/helpers/shipped-files.mjs — the files a stranger can read.
//
// Everything package.json `files` ships, plus the tests, the repository's own config and
// its workflows. Used by the guards that keep outside references and internal planning
// notes out of the public tree.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk (rel, out) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return;
  if (!statSync(abs).isDirectory()) { out.add(rel); return; }
  for (const e of readdirSync(abs)) {
    if (e === 'node_modules') continue;
    walk(`${rel}/${e}`, out);
  }
}

/** Repo-relative paths, sorted. Negated `files` entries only narrow the tarball; scanning them anyway is stricter. */
export function shippedFiles () {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const out = new Set(['package.json', '.gitignore', 'CLAUDE.md']);
  for (const f of pkg.files) if (!f.startsWith('!')) walk(f.replace(/\/$/, ''), out);
  for (const dir of ['tests', '.github', '.claude-plugin', 'docs']) walk(dir, out);
  return [...out].sort();
}
