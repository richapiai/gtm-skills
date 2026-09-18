// Temp `gtm/` tree builder with automatic cleanup.
//
// `gtm/` is PII (law 7): gitignored, TTL-swept, erasable. Tests that touch it
// must never touch the developer's real one, and must never leave a stray
// directory behind that a later `/comply erase` test could mistake for real
// data. Every tree created here is registered for removal on process exit even
// if a test throws or the runner is killed.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const LIVE = new Set();
let exitHookInstalled = false;

function installExitHook () {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const sweep = () => { for (const root of LIVE) { try { rmSync(root, { recursive: true, force: true }); } catch {} } LIVE.clear(); };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { sweep(); process.exit(sig === 'SIGINT' ? 130 : 143); });
  }
}

/** Default subdirectories of `gtm/` that the runtime expects to exist. */
export const DEFAULT_GTM_DIRS = ['runs', 'enrichment-cache', 'lists', 'exports'];

/**
 * @typedef {object} GtmTree
 * @property {string} root       absolute path to the throwaway repo root
 * @property {string} gtm        absolute path to `<root>/gtm`
 * @property {(...seg:string[])=>string} path     resolve a path under root
 * @property {(...seg:string[])=>string} gtmPath  resolve a path under gtm/
 * @property {(rel:string, contents:string)=>string} write
 * @property {(rel:string, value:unknown)=>string} writeJson
 * @property {(rel:string, lines:unknown[])=>string} writeJsonl
 * @property {(rel:string)=>string} read
 * @property {(rel:string)=>unknown} readJson
 * @property {(rel:string)=>unknown[]} readJsonl
 * @property {(rel:string)=>boolean} exists
 * @property {(rel?:string)=>string[]} list  recursive relative file listing
 * @property {(rel:string)=>string} mkdir
 * @property {(...args:string[])=>string} git  run git in the tree (throws if not a repo)
 * @property {()=>void} cleanup
 */

/**
 * Create a throwaway repo root containing a `gtm/` tree.
 *
 * @param {object} [opts]
 * @param {Record<string, string|object|unknown[]>} [opts.files]
 *   Files to seed, keyed by path relative to root. A string is written as-is;
 *   an array is written as JSONL; any other object is written as pretty JSON.
 * @param {string[]} [opts.dirs]      extra directories under gtm/ (default DEFAULT_GTM_DIRS)
 * @param {boolean}  [opts.git]       `git init` the root (for setup's gtm-is-tracked test)
 * @param {boolean}  [opts.gitignore] write `gtm/` into .gitignore (default true when git)
 * @param {string}   [opts.prefix]    mkdtemp prefix
 * @returns {GtmTree}
 */
export function makeGtmTree (opts = {}) {
  installExitHook();
  const {
    files = {},
    dirs = DEFAULT_GTM_DIRS,
    git = false,
    gitignore = git,
    prefix = 'richapi-gtm-'
  } = opts;

  const root = mkdtempSync(join(tmpdir(), prefix));
  LIVE.add(root);
  const gtm = join(root, 'gtm');
  mkdirSync(gtm, { recursive: true });
  for (const d of dirs) mkdirSync(join(gtm, d), { recursive: true });

  const resolveIn = (base) => (...seg) => {
    const p = join(base, ...seg);
    if (p !== base && !p.startsWith(base + sep)) throw new Error(`path escapes the temp tree: ${seg.join('/')}`);
    return p;
  };
  const path = resolveIn(root);
  const gtmPath = resolveIn(gtm);

  const write = (rel, contents) => {
    const abs = path(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, contents);
    return abs;
  };
  const writeJson = (rel, value) => write(rel, JSON.stringify(value, null, 2) + '\n');
  const writeJsonl = (rel, lines) => write(rel, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const read = (rel) => readFileSync(path(rel), 'utf8');
  const readJson = (rel) => JSON.parse(read(rel));
  const readJsonl = (rel) => read(rel).split('\n').filter(Boolean).map(l => JSON.parse(l));
  const exists = (rel) => existsSync(path(rel));
  const mkdir = (rel) => { const abs = path(rel); mkdirSync(abs, { recursive: true }); return abs; };

  const list = (rel = '.') => {
    const base = path(rel);
    const out = [];
    const walk = (dir, pre) => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir).sort()) {
        const abs = join(dir, name);
        const relPath = pre ? `${pre}/${name}` : name;
        if (statSync(abs).isDirectory()) walk(abs, relPath);
        else out.push(relPath);
      }
    };
    walk(base, '');
    return out;
  };

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    LIVE.delete(root);
    rmSync(root, { recursive: true, force: true });
  };

  const runGit = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  for (const [rel, value] of Object.entries(files)) {
    if (typeof value === 'string') write(rel, value);
    else if (Array.isArray(value)) writeJsonl(rel, value);
    else writeJson(rel, value);
  }

  if (git) {
    runGit('init', '-q');
    runGit('config', 'user.email', 'test@example.invalid');
    runGit('config', 'user.name', 'tmp-tree test');
    runGit('config', 'commit.gpgsign', 'false');
    if (gitignore) write('.gitignore', 'gtm/\nnode_modules/\n');
  }

  return { root, gtm, path, gtmPath, write, writeJson, writeJsonl, read, readJson, readJsonl, exists, list, mkdir, git: runGit, cleanup };
}

/**
 * Same as makeGtmTree, but binds cleanup to a node:test context so the tree is
 * removed when the test (or subtest) finishes, pass or fail.
 *
 *   import { test } from 'node:test';
 *   test('resume', (t) => {
 *     const tree = withGtmTree(t, { files: { 'gtm/runs/r1.jsonl': [line] } });
 *     ...
 *   });
 *
 * @param {{ after: (fn: () => void) => void }} t  a node:test TestContext
 * @param {Parameters<typeof makeGtmTree>[0]} [opts]
 * @returns {GtmTree}
 */
export function withGtmTree (t, opts = {}) {
  const tree = makeGtmTree(opts);
  if (t && typeof t.after === 'function') t.after(() => tree.cleanup());
  else throw new TypeError('withGtmTree(t, opts): t must be a node:test TestContext with .after()');
  return tree;
}

/** Number of trees created and not yet cleaned up. Used by the helper self-test. */
export function liveTreeCount () { return LIVE.size; }

export default { makeGtmTree, withGtmTree, DEFAULT_GTM_DIRS, liveTreeCount };

// ---------------------------------------------------------------------------
// Bare tracked temp dirs (not a gtm/ tree).
//
// One suite hand-rolled `mkdtempSync` in 15 places and never removed any of them:
// 4,659 directories had accumulated in TMPDIR, each holding fabricated suppression
// stores and ledgers — exactly the PII-shaped artifacts this module exists to keep
// off disk. Anything needing a bare temp dir should use this.
// ---------------------------------------------------------------------------

import { mkdtempSync as _mkdtempSync, rmSync as _rmSync } from 'node:fs';
import { tmpdir as _tmpdir } from 'node:os';
import { join as _join } from 'node:path';

const _tracked = new Set();
let _sweepArmed = false;

function _sweep () {
  for (const d of _tracked) { try { _rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } }
  _tracked.clear();
}

/** A temp directory that is removed when the process exits. */
export function trackedTmp (prefix = 'gtm-test-') {
  if (!_sweepArmed) {
    process.on('exit', _sweep);
    for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { _sweep(); process.exit(130); });
    _sweepArmed = true;
  }
  const dir = _mkdtempSync(_join(_tmpdir(), prefix));
  _tracked.add(dir);
  return dir;
}
