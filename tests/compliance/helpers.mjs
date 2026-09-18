// tests/compliance/helpers.mjs — test helpers for the PII, suppression and erase suites.
// (Kept separate from the shared tests/helpers/.)

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const SETUP_BIN = join(REPO_ROOT, 'setup.mjs');

const tmpRoots = [];

export function tmpRoot(prefix = 'compliance-') {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}

export function cleanupTmp() {
  while (tmpRoots.length) rmSync(tmpRoots.pop(), { recursive: true, force: true });
}

export function write(root, rel, contents) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2) + '\n', 'utf8');
  return p;
}

export function jsonl(rows) { return rows.map(r => JSON.stringify(r)).join('\n') + '\n'; }

export function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function initGitRepo(root) {
  execFileSync('git', ['init', '-q', root], { stdio: 'ignore' });
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Compliance Test']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  return root;
}

/** Run `setup`, returning { code, stdout, stderr }. */
export function runSetup(args = []) {
  try {
    const stdout = execFileSync(process.execPath, [SETUP_BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

/** Snapshot every file under a dir as { relPath: contents }, minus `skip`. */
export function snapshot(dir, skip = []) {
  const out = {};
  const skipSet = new Set(skip);
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const rel = relative(dir, p).split(sep).join('/');
        if (skipSet.has(rel)) continue;
        out[rel] = readFileSync(p, 'utf8');
      }
    }
  };
  if (statSync(dir, { throwIfNoEntry: false })) walk(dir);
  return out;
}

/** Every file under dir whose text contains `needle` (case-insensitive). */
export function filesContaining(dir, needle, skip = []) {
  const snap = snapshot(dir, skip);
  const n = needle.toLowerCase();
  return Object.entries(snap).filter(([, v]) => v.toLowerCase().includes(n)).map(([k]) => k);
}

export const DAY = 24 * 60 * 60 * 1000;
export function ago(now, ms) { return new Date(now.getTime() - ms).toISOString(); }
