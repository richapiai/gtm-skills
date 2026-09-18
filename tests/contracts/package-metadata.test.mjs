// tests/contracts/package-metadata.test.mjs
//
// The package as a PUBLISHED ARTIFACT, not as a checkout.
//
// Everything below was verifiably wrong at some point in this repo's life, and none
// of it is visible from a green `npm test` on a clone — the failure only appears on
// npmjs.com or in a stranger's `node_modules`, after publish, where it cannot be
// taken back:
//
//   1. `@richapi/gtm-skills` is SCOPED, and npm defaults a scoped package to
//      access:restricted. Without `publishConfig.access` the first publish either
//      402s (no paid org) or silently ships a private package.
//   2. npm resolves every RELATIVE link in a README against `repository`. With no
//      repository field, all ~40 of this README's links to `skills/*/SKILL.md`,
//      `_lib/gates.yaml`, `docs/skill-shape.md` and the rest are dead on the
//      package page.
//   3. Those same links are dead in the TARBALL if `files:` does not ship the file.
//      `docs/` was omitted; `npm pack --dry-run` gave 93 files and no docs/ at all.
//   4. `files:` shipped `setup`/`setup.mjs` but no `bin` entry mapped them, so an
//      npm install had no way to run setup — and `richapi enrich leads.csv
//      --dry-run`, the README's headline free command, exits 5 without one
//      ("suppression store unreadable — failing closed", law 5).
//
// The publish-time half of this contract lives in
// tests/contracts/no-placeholder-metadata.mjs, which runs from `prepublishOnly`
// rather than here: it exists so a placeholder URL can never reach the registry. What IS checkable today is that the
// wiring exists and that the guard is not vacuous; both are asserted below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLACEHOLDER, placeholderPaths } from './no-placeholder-metadata.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// --- files: coverage ----------------------------------------------------------

/**
 * Does the `files:` array ship `rel`?
 *
 * Mirrors npm's own semantics closely enough for the two shapes this package uses:
 * a directory entry (`"bin/"`, which ships everything beneath it) and an exact path
 * (`"README.md"`). Negations (`"!bin/richapi-capture-fixtures.mjs"`) subtract, and are
 * applied in order, the way npm-packlist applies them.
 */
function shipped (rel) {
  let hit = false;
  for (const entry of PKG.files ?? []) {
    const neg = entry.startsWith('!');
    const pat = neg ? entry.slice(1) : entry;
    const dir = pat.endsWith('/') ? pat : `${pat}/`;
    const matches = rel === pat || rel === pat.replace(/\/$/, '') || rel.startsWith(dir);
    if (matches) hit = !neg;
  }
  return hit;
}

// --- publish access -----------------------------------------------------------

test('a scoped package declares publishConfig.access — npm defaults it to restricted', () => {
  assert.ok(PKG.name.startsWith('@'),
    'this test assumes a scoped name; if the package was unscoped, publishConfig is optional');
  assert.equal(PKG.publishConfig?.access, 'public',
    `${PKG.name} is scoped. npm publishes a scoped package as access:restricted unless told ` +
    'otherwise, so without `"publishConfig": { "access": "public" }` the first publish either ' +
    'fails with 402 or ships a package nobody outside the org can install.');
});

// --- repository / bugs / homepage ---------------------------------------------

const REPO_FIELDS = ['repository.url', 'bugs.url', 'homepage'];

/** The `owner/repo` path of a GitHub-shaped URL, or null. */
function ownerRepo (url) {
  const m = /github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(String(url ?? ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

test('repository, bugs and homepage are all present', () => {
  assert.ok(PKG.repository?.url,
    'no `repository` field. npm resolves relative README links against it, so without one ' +
    'every relative link in README.md 404s on the package page.');
  assert.equal(PKG.repository.type, 'git');
  assert.ok(PKG.bugs?.url, 'no `bugs` field — the npm page then offers no way to report anything');
  assert.ok(PKG.homepage, 'no `homepage` field');
});

test('repository, bugs and homepage all name the SAME repository', () => {
  const seen = REPO_FIELDS.map((f) => {
    const value = f.split('.').reduce((o, k) => o?.[k], PKG);
    return [f, ownerRepo(value)];
  });
  for (const [field, or] of seen) {
    assert.ok(or, `${field} is not a recognisable GitHub repository URL`);
  }
  const distinct = [...new Set(seen.map(([, or]) => or))];
  assert.equal(distinct.length, 1,
    'the three repository fields disagree:\n' +
    seen.map(([f, or]) => `  ${f} -> ${or}`).join('\n') +
    '\nA half-filled-in set is the worst state: relative README links resolve against one ' +
    'repository while bug reports go to another.');
});

test('the placeholder, if present, is present in all three fields at once', () => {
  const hits = placeholderPaths(PKG);
  if (hits.length === 0) return; // fully filled in — nothing to keep consistent
  assert.deepEqual(hits.sort(), [...REPO_FIELDS].sort(),
    `${PLACEHOLDER} appears in some repository fields but not others. Fill in all three or ` +
    'none — a mix silently sends half the package metadata to a repository that exists and ' +
    'half to one that does not.');
});

// --- the publish stop ---------------------------------------------------------

test('prepublishOnly runs the placeholder guard and the full check', () => {
  const pre = PKG.scripts?.prepublishOnly;
  assert.ok(pre, 'no `prepublishOnly` script — nothing stands between a typo and the registry');
  assert.match(pre, /\bnpm run check\b/,
    'prepublishOnly must run `npm run check` (catalog diff + validate + tests) before publish');
  assert.match(pre, /\bnpm run guard:placeholders\b/,
    'prepublishOnly must run the placeholder guard, or the placeholder repository URL can ' +
    'reach the registry by accident');

  const guard = PKG.scripts?.['guard:placeholders'];
  assert.ok(guard, 'no `guard:placeholders` script');
  const rel = /node\s+(\S+)/.exec(guard)?.[1];
  assert.ok(rel && existsSync(join(ROOT, rel)), `guard:placeholders points at ${rel}, which does not exist`);
});

test('the guard is not vacuous — it detects a placeholder and clears a real URL', () => {
  const withMarker = {
    repository: { type: 'git', url: `git+https://github.com/${PLACEHOLDER}/${PLACEHOLDER}.git` },
    homepage: 'https://example.invalid',
  };
  assert.deepEqual(placeholderPaths(withMarker), ['repository.url']);

  const filledIn = {
    repository: { type: 'git', url: 'git+https://github.com/richapi/some-real-name.git' },
    bugs: { url: 'https://github.com/richapi/some-real-name/issues' },
    homepage: 'https://github.com/richapi/some-real-name#readme',
  };
  assert.deepEqual(placeholderPaths(filledIn), [],
    'the guard must go green once the fields are filled in, or it is a permanent publish block');
});

// --- files: ships what the README points at -----------------------------------

/**
 * Prefixes a README link may point at WITHOUT `files:` shipping them.
 *
 * These are source-of-record paths a reader follows on the repository page, and the
 * tarball is contractually forbidden to contain them — tests/activation/ci-local.test.mjs
 * asserts that nothing under `tests/` or `.github/` is ever packed. They still resolve
 * for a reader on npmjs.com, because npm rewrites relative README links against
 * `repository`; that is one more reason the repository field has to be right.
 *
 * Everything else is a document the README tells a user to open, and a user who
 * installed the package should find it in node_modules. `docs/` was in this position
 * and was not shipped at all.
 */
const REPO_ONLY_PREFIXES = ['tests/', '.github/'];

test('every relative path the README links to is shipped in the tarball', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const missing = [];
  for (const m of readme.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('<')) continue;
    const rel = target.split('#')[0].replace(/^\.\//, '');
    if (!rel) continue;
    if (REPO_ONLY_PREFIXES.some((p) => rel.startsWith(p))) continue;
    if (!existsSync(join(ROOT, rel))) continue; // a broken repo link is a different bug
    if (!shipped(rel)) missing.push(rel);
  }
  assert.deepEqual([...new Set(missing)].sort(), [],
    'README.md links to these paths but `files:` does not ship them, so the link is dead for ' +
    'every npm consumer (npm renders the README on the package page and resolves relative ' +
    'links into the repository, and the file is also absent from node_modules). Add each one ' +
    'to `files:` in package.json, or drop the link from the README.');
});

// --- an npm install can run setup ---------------------------------------------

test('setup is reachable as an installed command', () => {
  const bins = Object.entries(PKG.bin ?? {});
  const setupBin = bins.find(([, p]) => p === 'setup.mjs' || p === 'setup');
  assert.ok(setupBin,
    'no `bin` entry maps to setup. `files:` ships setup and setup.mjs, but an npm install puts ' +
    'only `bin` entries on PATH, so there is no way to run setup — and without it ' +
    '`richapi enrich <list> --dry-run` exits 5 ("suppression store unreadable — failing ' +
    'closed"), which is the README\'s headline free command failing on a fresh install.');
  assert.equal(setupBin[1], 'setup.mjs',
    'the bin entry must point at setup.mjs, not the extensionless `setup` wrapper: this is a ' +
    '"type":"module" package and Node cannot load an extensionless file as ESM before 20.10 ' +
    '(see tests/contracts/executables-load.test.mjs). The wrapper stays for `./setup`.');
});

// --- the credit-spending maintainer tool does not ship -------------------------

test('bin/richapi-capture-fixtures.mjs is excluded from the tarball', () => {
  assert.equal(shipped('bin/richapi-capture-fixtures.mjs'), false,
    'richapi-capture-fixtures spends real credits against the live API (`--run`), is not in the ' +
    '`bin` map, and is documented nowhere a user would look. Shipping it to every installer is ' +
    'an undocumented spend surface with no upside — keep the `"!bin/richapi-capture-fixtures.mjs"` ' +
    'negation in `files:`.');
  assert.ok(!Object.values(PKG.bin ?? {}).includes('bin/richapi-capture-fixtures.mjs'),
    'a tool excluded from the tarball must not be a bin entry');
  assert.ok(existsSync(join(ROOT, 'bin', 'richapi-capture-fixtures.mjs')),
    'the tool still lives in the repo for maintainers; only the tarball drops it');
});

// --- the community files exist and ship ---------------------------------------

for (const f of ['CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'LICENSE']) {
  test(`${f} exists and is shipped`, () => {
    assert.ok(existsSync(join(ROOT, f)), `${f} is missing`);
    assert.ok(shipped(f), `${f} exists but is not in package.json "files", so it is not in the tarball`);
  });
}
