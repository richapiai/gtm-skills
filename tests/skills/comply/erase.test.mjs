// tests/skills/comply/erase.test.mjs — `/comply erase`, the irreversible act.
//
// Two properties, and the whole file is about them:
//   1. It cannot happen by accident (two confirmations, both fail closed).
//   2. It is not re-implemented here. Deletion is `_lib/pii.mjs` and only that.
//
// The second is why the CSV case at the bottom is in this file even though the engine
// lives in _lib: the skill makes a promise about record-aware deletion, and a promise
// nobody tests from the caller's side is how the original half-deleted-record bug
// shipped in the first place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree, trackedTmp } from '../../helpers/index.mjs';
import { ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore, isSuppressed }
  from '../../../_lib/suppression.mjs';
import { erase, readTombstones, sha256, TOMBSTONE_FILE } from '../../../_lib/pii.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { eraseDecision, countErasableRows, ALLOW, CONFIRM, STOP } from './harness.mjs';

const NOW = new Date('2026-08-28T12:00:00Z');
const GATES = loadGates();

/** 14 rows nobody is erasing, 5 at wide.example, 1 at narrow.example. 20 in total. */
function treeWith20Rows (t) {
  const tree = makeGtmTree({ prefix: 'comply-erase-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const stamp = { source_endpoint: 'enrich_company', fetched_at: '2026-08-20T00:00:00Z' };
  const rows = [];
  for (let i = 0; i < 14; i++) rows.push({ ...stamp, email: `keep${i}@safe.example` });
  for (let i = 0; i < 5; i++) rows.push({ ...stamp, email: `w${i}@wide.example` });
  rows.push({ ...stamp, email: 'only@narrow.example' });
  tree.writeJsonl('gtm/lists/main.jsonl', rows);
  return tree;
}

test('countErasableRows counts what an erase could destroy, and nothing else', (t) => {
  const tree = treeWith20Rows(t);
  assert.equal(countErasableRows(tree.root), 20);
  // The tombstone log and the suppression store are excluded on purpose: neither can
  // be destroyed by an erase, and counting them would inflate the denominator, shrink
  // the measured fraction and make the confirm gate fire LESS often.
  fs.appendFileSync(path.join(tree.root, 'gtm', TOMBSTONE_FILE), JSON.stringify({ a: 1 }) + '\n');
  addSuppressionEntry({ email: 'x@y.example' }, { root: tree.root });
  assert.equal(countErasableRows(tree.root), 20);
});

// --- gate 1: erasure is never implicit --------------------------------------

test('erase requires an explicit confirmation before anything is touched', (t) => {
  const tree = treeWith20Rows(t);
  assert.equal(gateValue(GATES, 'skills.comply.erase_requires_explicit_confirm'), true);

  const d = eraseDecision({ root: tree.root, target: 'wide.example', gates: GATES, now: NOW });
  assert.equal(d.verdict, CONFIRM);
  assert.equal(d.gate, 'skills.comply.erase_requires_explicit_confirm');

  // Not confirmed means nothing happened — not even a measurement side effect.
  assert.equal(tree.readJsonl('gtm/lists/main.jsonl').length, 20);
  assert.equal(tree.exists(`gtm/${TOMBSTONE_FILE}`), false, 'an unconfirmed erase left a tombstone');
});

test('a missing erase gate key is STOP, never "no gate"', (t) => {
  const tree = treeWith20Rows(t);
  const dir = trackedTmp('comply-gates-');
  const p = path.join(dir, 'gates.yaml');

  // The whole skills.comply block lost in a merge.
  fs.writeFileSync(p, 'schema_version: 1\n', 'utf8');
  const d = eraseDecision({ root: tree.root, target: 'wide.example', confirmed: true, gates: loadGates(p), now: NOW });
  assert.equal(d.verdict, STOP);
  assert.equal(d.failed_closed, true);
  assert.match(d.reason, /failing closed/);

  // One key present, the other dropped: still STOP, and it names the missing key.
  fs.writeFileSync(p, 'schema_version: 1\nskills:\n  comply:\n    erase_requires_explicit_confirm: true\n', 'utf8');
  const d2 = eraseDecision({ root: tree.root, target: 'wide.example', confirmed: true, gates: loadGates(p), now: NOW });
  assert.equal(d2.verdict, STOP);
  assert.equal(d2.gate, 'skills.comply.erase_confirm_fraction');

  // A threshold present but not a number is also STOP — an unusable gate is no gate.
  fs.writeFileSync(p, 'schema_version: 1\nskills:\n  comply:\n    erase_requires_explicit_confirm: true\n    erase_confirm_fraction: "most of it"\n', 'utf8');
  const d3 = eraseDecision({ root: tree.root, target: 'wide.example', confirmed: true, gates: loadGates(p), now: NOW });
  assert.equal(d3.verdict, STOP);

  assert.equal(tree.readJsonl('gtm/lists/main.jsonl').length, 20, 'a stopped erase touched data');
});

// --- gate 2: a wide sweep asks again ----------------------------------------

test('an over-threshold sweep asks first — the typo gate', (t) => {
  const tree = treeWith20Rows(t);
  const threshold = gateValue(GATES, 'skills.comply.erase_confirm_fraction');

  // `wide.example` takes 5 of 20 rows. That is the shape of a typo'd domain: the
  // user meant one person and named something that matches a fifth of the cache.
  const d = eraseDecision({ root: tree.root, target: 'wide.example', confirmed: true, gates: GATES, now: NOW });
  assert.equal(d.verdict, CONFIRM);
  assert.equal(d.gate, 'skills.comply.erase_confirm_fraction');
  assert.equal(d.impacted, 5);
  assert.equal(d.total, 20);
  assert.ok(d.fraction > threshold, `${d.fraction} should exceed the gate`);

  // Measuring is a dry run: nothing removed, no tombstone.
  assert.equal(tree.readJsonl('gtm/lists/main.jsonl').length, 20);
  assert.equal(tree.exists(`gtm/${TOMBSTONE_FILE}`), false);

  // The second confirmation is what unlocks it. Nothing else does.
  const ok = eraseDecision({ root: tree.root, target: 'wide.example', confirmed: true, sweepConfirmed: true, gates: GATES, now: NOW });
  assert.equal(ok.verdict, ALLOW);
});

test('a narrow, confirmed erase proceeds without a second prompt', (t) => {
  const tree = treeWith20Rows(t);
  const d = eraseDecision({ root: tree.root, target: 'only@narrow.example', confirmed: true, gates: GATES, now: NOW });
  assert.equal(d.verdict, ALLOW, JSON.stringify(d));
  assert.equal(d.impacted, 1);
  assert.ok(d.fraction <= d.threshold);
  // Still measured with a dry run, so the decision itself changed nothing.
  assert.equal(tree.readJsonl('gtm/lists/main.jsonl').length, 20);
});

test('a sweep that cannot be measured asks rather than proceeding', (t) => {
  const tree = treeWith20Rows(t);
  // An empty target is unmeasurable: the engine refuses to build a matcher for it.
  const d = eraseDecision({ root: tree.root, target: '   ', confirmed: true, gates: GATES, now: NOW });
  assert.equal(d.verdict, CONFIRM);
  assert.equal(d.failed_closed, true);
});

// --- delegation: the deletion itself is pii.mjs ------------------------------

test('the erase itself is the shipped engine, and it leaves a tombstone', (t) => {
  const tree = treeWith20Rows(t);
  const r = erase('wide.example', { root: tree.root, now: NOW, actor: 'comply' });

  assert.equal(r.rows_removed, 5);
  assert.equal(tree.readJsonl('gtm/lists/main.jsonl').length, 15);

  const stones = readTombstones({ root: tree.root });
  assert.equal(stones.length, 1);
  assert.equal(stones[0].action, 'erase');
  assert.equal(stones[0].matched, true);
  assert.equal(stones[0].target_sha256, sha256('wide.example'));
  // The audit trail of an erasure must not be a place the erased value survives.
  assert.ok(!JSON.stringify(stones[0]).includes('wide.example'));
});

test('erase is idempotent, and says so instead of implying the first run failed', (t) => {
  const tree = treeWith20Rows(t);
  erase('wide.example', { root: tree.root, now: NOW });
  const before = tree.read('gtm/lists/main.jsonl');

  const second = erase('wide.example', { root: tree.root, now: NOW });
  assert.equal(second.rows_removed, 0);
  assert.equal(second.tombstone.matched, false);
  assert.equal(tree.read('gtm/lists/main.jsonl'), before, 'a no-op erase rewrote data');
  assert.equal(readTombstones({ root: tree.root }).length, 2, 'the request itself is auditable');
});

test('erasure does not un-suppress: the plaintext goes, the suppression stays', (t) => {
  const tree = makeGtmTree({ prefix: 'comply-erase-sup-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  addSuppressionEntry({ email: 'gone@wide.example', reason: 'unsubscribe' }, { root: tree.root });

  erase('gone@wide.example', { root: tree.root, now: NOW });

  const raw = fs.readFileSync(path.join(tree.root, 'gtm', 'suppression.jsonl'), 'utf8');
  assert.ok(!raw.includes('gone@wide.example'), 'the plaintext address survived an erasure');
  // …and they are still suppressed, by hash. Re-adding them on the next import
  // would be the worse violation of the two.
  const store = loadSuppressionStore({ root: tree.root });
  assert.equal(isSuppressed(store, 'gone@wide.example'), true);
});

test('a CSV record spanning two physical lines is erased whole, not halved', (t) => {
  const tree = makeGtmTree({ prefix: 'comply-erase-csv-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  // The original bug: split on newlines, delete the line holding the email, keep the
  // line holding the name and phone, leave an unterminated quote, report success.
  tree.write('gtm/lists/multi.csv',
    'name,note,email\n'
    + 'Ada,"first line\nsecond line",ada@wide.example\n'
    + 'Bo,"kept\nnote",bo@safe.example\n');

  erase('wide.example', { root: tree.root, now: NOW });

  const out = tree.read('gtm/lists/multi.csv');
  assert.ok(!out.includes('ada@wide.example'));
  assert.ok(!out.includes('second line'), 'half of the record survived');
  const parsed = parseCsv(out);
  assert.equal(parsed.length, 1, 'the file must still parse as one surviving record');
  assert.equal(parsed[0].email, 'bo@safe.example');
  assert.equal(parsed[0].note, 'kept\nnote', 'the surviving multi-line record was corrupted');
});
