// Regression: a compliance sweep must never run against a state tree that is not the
// one holding the data.
//
// The bug: `_lib/pii.mjs` derived every compliance path as `root + 'gtm'`, while the
// CLI's `--dir <gtm>` (bin/richapi.mjs) is honoured by a run (`_lib/run.mjs`). So
// `richapi enrich --dir gtm-acme` wrote state to `gtm-acme/`, and a later `erase()`
// swept an empty `gtm/`, matched nothing, and appended a tombstone recording a
// successful erasure. A GDPR Art. 17 request answered with a documented lie.
//
// Same shape for the retention sweep: `sweepEnrichmentCache()` reported a clean sweep
// of a tree it never looked at, and the PII TTL quietly stopped being enforced.
//
// These tests fail against the pre-fix code: erase() returned a report and wrote a
// tombstone instead of throwing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { tmpRoot, cleanupTmp, write, jsonl, DAY, ago, REPO_ROOT } from './helpers.mjs';
import {
  erase, eraseDecision, sweepEnrichmentCache, ensureGtmTree, readTombstones,
  findStateTrees, resolveStateTree, StateTreeMismatchError, STATE_TREE_MARKERS,
  GTM_DIR, STOP,
} from '../../_lib/pii.mjs';
import { suppressionPath } from '../../_lib/suppression.mjs';

test.after(cleanupTmp);

const NOW = new Date('2026-08-28T12:00:00.000Z');
const TARGET = 'bob@acme.com';
const PII_BIN = join(REPO_ROOT, '_lib', 'pii.mjs');

/**
 * Seed a state tree at `<root>/<dir>` holding TARGET and one expired cache row.
 * `now` stamps the fresh row. A test that sweeps through the CLI subprocess must pass
 * the real clock: the subprocess sweeps at wall-clock time, so a row stamped with the
 * fixed NOW expires a few days after NOW and the test starts failing on its own.
 */
function seedTree(root, dir, now = NOW) {
  ensureGtmTree(root, dir);
  write(root, `${dir}/lists/q3.csv`,
    `email,first_name\n${TARGET},Bob\ncarol@zenith.io,Carol\n`);
  write(root, `${dir}/lists/q3.jsonl`, jsonl([
    { email: TARGET, company: 'Acme' },
    { email: 'carol@zenith.io', company: 'Zenith' },
  ]));
  // One row far past any TTL, one stamped now — a working sweep drops exactly one.
  write(root, `${dir}/enrichment-cache/email_verifier.jsonl`, jsonl([
    { source_endpoint: 'email_verifier', fetched_at: ago(now, 900 * DAY), key: TARGET, data: { valid: true } },
    { source_endpoint: 'email_verifier', fetched_at: now.toISOString(), key: 'carol@zenith.io', data: { valid: true } },
  ]));
  return join(root, dir);
}

function runPii(args) {
  try {
    const stdout = execFileSync(process.execPath, [PII_BIN, ...args],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ---------------------------------------------------------------------------
// detection
// ---------------------------------------------------------------------------

test('findStateTrees sees a tree at a non-default --dir', () => {
  const root = tmpRoot('compliance-stm-find-');
  seedTree(root, 'gtm-acme');
  mkdirSync(join(root, 'docs'), { recursive: true });         // not a state tree
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  assert.deepEqual(findStateTrees(root), [join(root, 'gtm-acme')]);
});

test('a directory is a state tree only if it carries a marker file', () => {
  const root = tmpRoot('compliance-stm-marker-');
  // Same subdirectory names, none of the marker files: not a state tree.
  mkdirSync(join(root, 'lookalike', 'lists'), { recursive: true });
  mkdirSync(join(root, 'lookalike', 'enrichment-cache'), { recursive: true });
  assert.deepEqual(findStateTrees(root), []);
  writeFileSync(join(root, 'lookalike', STATE_TREE_MARKERS[0]), '', 'utf8');
  assert.deepEqual(findStateTrees(root), [join(root, 'lookalike')]);
});

test('resolveStateTree returns the default tree when it is the only one', () => {
  const root = tmpRoot('compliance-stm-solo-');
  ensureGtmTree(root);
  assert.equal(resolveStateTree({ root }), join(root, GTM_DIR));
});

// ---------------------------------------------------------------------------
// erase — non-negotiable 1: no phantom success tombstone
// ---------------------------------------------------------------------------

test('erase REFUSES when the state tree lives at a non-default --dir', () => {
  const root = tmpRoot('compliance-stm-erase-');
  const acme = seedTree(root, 'gtm-acme');
  const before = readFileSync(join(acme, 'lists', 'q3.csv'), 'utf8');

  assert.throws(
    () => erase(TARGET, { root, now: NOW }),
    (e) => {
      assert.ok(e instanceof StateTreeMismatchError, `expected StateTreeMismatchError, got ${e.name}`);
      assert.equal(e.verdict, 'STOP');
      assert.match(e.message, /gtm-acme/);          // names the tree holding the data
      assert.ok(e.message.includes(join(root, GTM_DIR)));  // and the one it was pointed at
      return true;
    },
  );

  // No tombstone anywhere: an erase that saw nothing must not record a success.
  assert.equal(existsSync(join(root, GTM_DIR)), false, 'must not create the default tree');
  assert.deepEqual(readTombstones({ root, dir: 'gtm-acme' }), []);
  assert.equal(readFileSync(join(acme, 'lists', 'q3.csv'), 'utf8'), before, 'data must be untouched');
});

test('erase REFUSES when an empty default tree sits beside the one holding the data', () => {
  const root = tmpRoot('compliance-stm-both-');
  ensureGtmTree(root);                 // what `setup` leaves behind
  seedTree(root, 'gtm-acme');          // what `enrich --dir gtm-acme` actually wrote

  assert.throws(() => erase(TARGET, { root, now: NOW }), StateTreeMismatchError);
  assert.deepEqual(readTombstones({ root }), [],
    'the default tree must not gain a tombstone claiming a successful erasure');
});

test('erase REFUSES an explicitly named tree that does not exist', () => {
  const root = tmpRoot('compliance-stm-typo-');
  seedTree(root, 'gtm-acme');
  assert.throws(
    () => erase(TARGET, { root, dir: 'gtm-acm', now: NOW }),   // typo'd --dir
    (e) => e instanceof StateTreeMismatchError && /gtm-acm\b/.test(e.message),
  );
  assert.deepEqual(readTombstones({ root, dir: 'gtm-acme' }), []);
});

test('erase with the right --dir purges the data and tombstones into that tree', () => {
  const root = tmpRoot('compliance-stm-ok-');
  const acme = seedTree(root, 'gtm-acme');

  const r = erase(TARGET, { root, dir: 'gtm-acme', now: NOW });
  assert.equal(r.gtm_dir, acme);
  assert.ok(r.files_touched.length > 0, 'the target was in the tree and must be found');
  assert.equal(readFileSync(join(acme, 'lists', 'q3.csv'), 'utf8').includes(TARGET), false);
  assert.equal(readFileSync(join(acme, 'lists', 'q3.jsonl'), 'utf8').includes(TARGET), false);

  const tombs = readTombstones({ root, dir: 'gtm-acme' });
  assert.equal(tombs.length, 1);
  assert.equal(tombs[0].matched, true);
  assert.equal(existsSync(join(root, GTM_DIR)), false, 'nothing is written to the default tree');
});

test('erase still behaves exactly as before when only the default tree exists', () => {
  const root = tmpRoot('compliance-stm-legacy-');
  seedTree(root, GTM_DIR);
  const r = erase(TARGET, { root, now: NOW });
  assert.equal(r.gtm_dir, join(root, GTM_DIR));
  assert.ok(r.files_touched.length > 0);
  assert.equal(readTombstones({ root }).length, 1);
});

// ---------------------------------------------------------------------------
// retention sweep — non-negotiable 2: no clean sweep of a tree it cannot see
// ---------------------------------------------------------------------------

test('sweepEnrichmentCache REFUSES rather than reporting a clean sweep of the wrong tree', () => {
  const root = tmpRoot('compliance-stm-sweep-');
  const acme = seedTree(root, 'gtm-acme');
  const cache = join(acme, 'enrichment-cache', 'email_verifier.jsonl');
  const before = readFileSync(cache, 'utf8');

  assert.throws(
    () => sweepEnrichmentCache({ root, now: NOW }),
    (e) => e instanceof StateTreeMismatchError && /gtm-acme/.test(e.message),
  );
  assert.equal(readFileSync(cache, 'utf8'), before, 'the expired row is still there');
});

test('sweepEnrichmentCache with the right --dir actually expires the stale row', () => {
  const root = tmpRoot('compliance-stm-sweep-ok-');
  const acme = seedTree(root, 'gtm-acme');
  const r = sweepEnrichmentCache({ root, dir: 'gtm-acme', now: NOW });
  assert.equal(r.dir, join(acme, 'enrichment-cache'));
  assert.equal(r.files_scanned, 1);
  assert.equal(r.rows_expired, 1);
  assert.equal(r.rows_kept, 1);
});

test('sweepEnrichmentCache is unchanged when only the default tree exists', () => {
  const root = tmpRoot('compliance-stm-sweep-legacy-');
  seedTree(root, GTM_DIR);
  const r = sweepEnrichmentCache({ root, now: NOW });
  assert.equal(r.rows_expired, 1);
  assert.equal(r.rows_kept, 1);
});

// ---------------------------------------------------------------------------
// the gate and the CLI
// ---------------------------------------------------------------------------

test('eraseDecision returns STOP (not CONFIRM) on a state-tree mismatch', () => {
  const root = tmpRoot('compliance-stm-gate-');
  seedTree(root, 'gtm-acme');
  const d = eraseDecision({ root, target: TARGET, confirmed: true, sweepConfirmed: true });
  assert.equal(d.verdict, STOP);
  assert.equal(d.gate, 'erase.state_tree');
  assert.equal(d.failed_closed, true);
  assert.deepEqual(d.candidates, [join(root, 'gtm-acme')]);
});

test('`pii.mjs erase` exits 3 and writes no tombstone when the tree is elsewhere', () => {
  const root = tmpRoot('compliance-stm-cli-');
  seedTree(root, 'gtm-acme');
  const r = runPii(['erase', TARGET, '--root', root]);
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stderr, /REFUSED \(STOP\)/);
  assert.match(r.stderr, /gtm-acme/);
  assert.deepEqual(readTombstones({ root, dir: 'gtm-acme' }), []);
  assert.equal(existsSync(join(root, GTM_DIR)), false);
});

test('`pii.mjs erase --dry-run` also refuses — "nothing matched" would read as "already erased"', () => {
  const root = tmpRoot('compliance-stm-cli-dry-');
  seedTree(root, 'gtm-acme');
  const r = runPii(['erase', TARGET, '--root', root, '--dry-run']);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.equal(r.stdout.includes('nothing matched'), false);
});

test('`pii.mjs erase --dir` reaches the real tree', () => {
  const root = tmpRoot('compliance-stm-cli-ok-');
  const acme = seedTree(root, 'gtm-acme');
  const r = runPii(['erase', TARGET, '--root', root, '--dir', 'gtm-acme', '--confirm-sweep']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(join(acme, 'lists', 'q3.csv'), 'utf8').includes(TARGET), false);
  assert.equal(readTombstones({ root, dir: 'gtm-acme' }).length, 1);
});

test('`pii.mjs sweep` exits 3 rather than reporting a clean sweep of the wrong tree', () => {
  const root = tmpRoot('compliance-stm-cli-sweep-');
  seedTree(root, 'gtm-acme', new Date());
  const r = runPii(['sweep', '--root', root]);
  assert.equal(r.code, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /REFUSED \(STOP\)/);
  const ok = runPii(['sweep', '--root', root, '--dir', 'gtm-acme', '--json']);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).rows_expired, 1);
});

// ---------------------------------------------------------------------------
// the suppression store follows the same tree
// ---------------------------------------------------------------------------

test('suppressionPath honours the state-tree name', () => {
  const root = tmpRoot('compliance-stm-supp-');
  assert.equal(suppressionPath(root), join(root, GTM_DIR, 'suppression.jsonl'));
  assert.equal(suppressionPath(root, 'gtm-acme'), join(root, 'gtm-acme', 'suppression.jsonl'));
});
