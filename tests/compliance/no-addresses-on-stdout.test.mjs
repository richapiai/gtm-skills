// Law 7: `gtm/` is PII. A terminal is not `gtm/`.
//
// /comply printed the full address of every refused row to stdout. That is the one
// place in the pack where personal data leaves the tree that is gitignored, TTL-swept
// and reachable by `/comply erase` — into scrollback, into a CI log, into the ticket
// the operator pastes the run into, none of which any erasure request can reach.
//
// The row number and a mask identify the row; the verdict FILE, under gtm/, keeps the
// address for the fix. These tests fail if any line of any refusal run contains one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeGtmTree } from '../helpers/index.mjs';
import { ensureSuppressionStore, addSuppressionEntry, maskContact } from '../../_lib/suppression.mjs';
import { runComply, clearRow, csvOf } from '../skills/comply/comply-runner.mjs';
import { runReview } from '../skills/launch/skill-runner.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

// One of each refusal category: a precondition, an opt-out (which is written to the
// store), a suppressed row, and a row with no jurisdiction at all.
const ADDRESSES = [
  'precondition@acme.example',
  'objector@acme.example',
  'suppressed@acme.example',
  'nowhere@acme.example',
];

function fixture (t) {
  const g = makeGtmTree({ prefix: 'pii-stdout-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  addSuppressionEntry({ email: ADDRESSES[2], reason: 'unsubscribe' }, { root: g.root });
  const csv = csvOf([
    clearRow(1, { email: ADDRESSES[0], data_source: '' }),
    clearRow(2, { email: ADDRESSES[1], objection: 'true' }),
    clearRow(3, { email: ADDRESSES[2] }),
    clearRow(4, { email: ADDRESSES[3], subject_country: '', subject_region: '' }),
  ]);
  return {
    g,
    list: g.write('gtm/lists/q3.csv', csv),
    out: g.path('gtm/reviews/q3.comply.json'),
    verdict: g.path('gtm/reviews/q3.verdict.json'),
  };
}

test('/comply never prints a full address, and still names every refused row', (t) => {
  const f = fixture(t);
  const r = runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW });
  assert.equal(r.status, 3, r.out);

  for (const addr of ADDRESSES) {
    assert.ok(!r.out.includes(addr),
      `a full address reached the terminal: ${addr}\n${r.out}`);
  }
  // Not a blanket silence: the masked form is there, so an operator can still tell the
  // rows apart, and every refused row is named by its number.
  for (const addr of ADDRESSES) assert.ok(r.out.includes(maskContact(addr)), `${addr} was not reported at all`);
  for (const n of [1, 2, 3, 4]) assert.match(r.out, new RegExp(`STOP  row ${n} `));

  // And the verdict file — which lives under gtm/ — still carries the real thing, or
  // the operator has nothing to fix.
  const v = JSON.parse(fs.readFileSync(f.out, 'utf8'));
  assert.deepEqual(v.stopped.map((s) => s.contact).sort(), [...ADDRESSES].sort());
});

test('/campaign-review reports suppression by count, never by address', (t) => {
  const f = fixture(t);
  runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW });
  const r = runReview({ LIST: f.list, ROOT: f.g.root, OUT: f.verdict, COMPLY: f.out, NOW });
  assert.equal(r.status, 3, r.out);
  for (const addr of ADDRESSES) {
    assert.ok(!r.out.includes(addr), `a full address reached the terminal: ${addr}\n${r.out}`);
  }
  // Two: the one that was already on the store, and the objector /comply just added.
  assert.match(r.out, /2 contact\(s\) on this list are suppressed/);
});

test('maskContact destroys the local part and keeps nothing that can be sent to', () => {
  assert.equal(maskContact('ada@acme.example'), 'a***@acme.example');
  assert.equal(maskContact(' Ada@Acme.Example '), 'A***@Acme.Example');
  assert.equal(maskContact('acme.example'), 'a***');          // a domain entry
  assert.equal(maskContact(''), '');
  assert.equal(maskContact(null), '');
  assert.equal(maskContact('@acme.example'), '@***');         // never returns the input

  // A phone keeps its last four digits: enough for the operator to recognise the row
  // the gate stopped, not enough to dial. Before this, every phone masked to '+***',
  // so a phone-only list printed the same token against every stop.
  assert.equal(maskContact('+14155550123'), '***0123');
  assert.equal(maskContact('+44 207 183 8750'), '***8750');
  assert.equal(maskContact('(415) 555-0123'), '***0123');
  assert.equal(maskContact('12345'), '1***');                 // too short to be a phone
  assert.ok(!maskContact('+14155550123').includes('415'));    // area code destroyed
});
