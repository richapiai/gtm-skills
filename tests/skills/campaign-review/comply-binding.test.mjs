// /campaign-review — the compliance clearance it now stands on.
//
// The review used to run exactly three checks — suppression, coverage, verification —
// and read no /comply output at all. So "is this list ready to send" could answer PASS
// for a list whose lawful basis nobody had cleared, and /launch, which reads only this
// verdict, would then write the export.
//
// The review still does not FORM the compliance opinion: the rule table is /comply's
// and there is exactly one implementation of it. What it does now is refuse to pass a
// list it was not handed a live clearance for, and carry that clearance forward so
// /launch can re-check it. These tests exercise the script that ships inside
// skills/campaign-review/SKILL.md, extracted verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash } from '../../../_lib/sender-export.mjs';
import { ensureSuppressionStore } from '../../../_lib/suppression.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { runReview, gatesFileWith } from '../launch/skill-runner.mjs';
import { runComply, clearRow, csvOf } from '../comply/comply-runner.mjs';

const GATES = loadGates();
const MAX_AGE_H = gateValue(GATES, 'skills.campaign_review.verdict_max_age_hours');
const NOW = '2026-08-28T12:00:00.000Z';

function fixture (t, { rows = [clearRow(1), clearRow(2), clearRow(3)] } = {}) {
  const g = makeGtmTree({ prefix: 'f6-review-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  const csv = csvOf(rows);
  const list = g.write('gtm/lists/q3.csv', csv);
  return {
    g, list, csv,
    rows: parseCsv(csv),
    hash: listContentHash(parseCsv(csv)),
    comply: g.path('gtm/reviews/q3.comply.json'),
    out: g.path('gtm/reviews/q3.verdict.json'),
  };
}

const clear = (f, env = {}) => runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.comply, NOW, ...env });
const review = (f, env = {}) => runReview({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW, ...env });
const verdictOf = (f) => JSON.parse(fs.readFileSync(f.out, 'utf8'));
const complyCheck = (v) => v.checks.find((c) => c.gate === 'comply');

// ===========================================================================
// Absent is a stop. This is the whole finding.
// ===========================================================================

test('no compliance verdict at all FAILs the review', (t) => {
  const f = fixture(t);                       // /comply deliberately never run
  const r = review(f);
  assert.equal(r.status, 3, r.out);

  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.ok(v.blocking.includes('comply'), JSON.stringify(v.blocking));
  const c = complyCheck(v);
  assert.equal(c.decision, 'stop');
  assert.equal(c.comply_state, 'absent');
  assert.match(c.reason, /\/comply/, 'a FAIL must name the fix');
  assert.equal(v.comply.state, 'absent');
  assert.equal(v.comply.status, null);
});

test('a list /comply stopped cannot be reviewed into a PASS', (t) => {
  const f = fixture(t, { rows: [clearRow(1), clearRow(2, { data_source: '' })] });
  assert.equal(clear(f).status, 3, 'the fixture must actually be stopped by /comply');

  const r = review(f);
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.ok(v.blocking.includes('comply'));
  const c = complyCheck(v);
  assert.equal(c.comply_state, 'fail');
  assert.ok(c.comply_blocking.includes('gdpr:source_undisclosed'),
    'the review must relay WHICH compliance rule stopped it: ' + JSON.stringify(c.comply_blocking));
  assert.equal(v.comply.status, null, 'a FAIL clearance is never copied forward as one');
});

// ===========================================================================
// The clearance is bound to a list and to a clock, exactly like the verdict is.
// ===========================================================================

test('a clearance for a different list does not travel', (t) => {
  const f = fixture(t);
  assert.equal(clear(f).status, 0);

  // One contact edited after the clearance. The hash moves; the clearance does not.
  fs.writeFileSync(f.list, csvOf([clearRow(1), clearRow(2), clearRow(3, { first_name: 'Renamed' })]));

  const r = review(f);
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(complyCheck(v).comply_state, 'hash_mismatch');
  assert.match(complyCheck(v).reason, /not a\s+cleared list|clearance/i);
  assert.ok(v.blocking.includes('comply'));
});

test('a clearance goes stale on the clock alone, read from gates.yaml', (t) => {
  const f = fixture(t);
  const old = new Date(Date.parse(NOW) - (MAX_AGE_H + 2) * 3600_000).toISOString();
  assert.equal(clear(f, { NOW: old }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(f.comply, 'utf8')).list_hash, f.hash, 'the list has not moved');

  const r = review(f);
  assert.equal(r.status, 3, r.out);
  assert.equal(complyCheck(verdictOf(f)).comply_state, 'stale');
  assert.match(complyCheck(verdictOf(f)).reason, /verdict_max_age_hours/);

  // The window is a gate key, not a number in the script.
  const fresh = fixture(t);
  assert.equal(clear(fresh, { NOW: new Date(Date.parse(NOW) - 2 * 3600_000).toISOString() }).status, 0);
  assert.equal(review(fresh).status, 0, 'two hours old clears under the shipped window');
  const tight = gatesFileWith(fresh.g.root, (d) => { d.skills.campaign_review.verdict_max_age_hours = 1; });
  assert.equal(review(fresh, { GATES_FILE: tight }).status, 3, 'and is refused under a one-hour one');
  assert.equal(complyCheck(verdictOf(fresh)).comply_state, 'stale');
});

test('a clearance that is not readable JSON is not a clearance', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.comply), { recursive: true });
  fs.writeFileSync(f.comply, '{ this is not json');

  assert.equal(review(f).status, 3);
  assert.equal(complyCheck(verdictOf(f)).comply_state, 'unreadable');
});

// ===========================================================================
// The path that must work, and what it hands to /launch.
// ===========================================================================

test('a live clearance passes, and is copied into the verdict for /launch', (t) => {
  const f = fixture(t);
  assert.equal(clear(f).status, 0);
  const cy = JSON.parse(fs.readFileSync(f.comply, 'utf8'));

  const r = review(f);
  assert.equal(r.status, 0, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'PASS');
  assert.deepEqual(v.blocking, []);
  assert.equal(complyCheck(v).decision, 'allow');

  assert.equal(v.comply.state, 'pass');
  assert.equal(v.comply.status, 'PASS');
  assert.equal(v.comply.verdict_id, cy.verdict_id);
  assert.equal(v.comply.list_hash, f.hash, 'the copy is bound to the same list the review read');
  assert.equal(v.comply.issued_at, cy.issued_at);
});

test('the review does not re-decide a lawful basis, it reads the verdict', (t) => {
  // A clearance that says PASS for this exact list is honoured even though the rows
  // themselves would not clear if this skill re-ran the table. That is deliberate:
  // one rule table, one implementation, and /comply owns it. Re-implementing it here
  // is how two gates drift, and drift fails open.
  const f = fixture(t, { rows: [clearRow(1, { subject_country: '' })] });
  assert.equal(clear(f).status, 3, 'the row genuinely does not clear');

  const forged = JSON.parse(fs.readFileSync(f.comply, 'utf8'));
  forged.status = 'PASS';
  forged.blocking = [];
  fs.writeFileSync(f.comply, JSON.stringify(forged));

  assert.equal(review(f).status, 0, 'the review reads the clearance rather than second-guessing it');
  assert.equal(verdictOf(f).comply.status, 'PASS');
  // Which is exactly why the clearance must be produced by /comply and not by hand;
  // the review's job is the binding, not the rule table.
});

test('a clearance cannot buy itself a future by dating itself oddly', (t) => {
  // Date.parse coerces its argument, so a numeric issued_at of 12345 parses as the
  // year 12345 and an ancient clearance reads as one issued in the far future.
  // _lib/sender-export.mjs guards this for the review verdict; the same trap applies
  // here, and an unmeasurable age is expired, never ageless.
  for (const issued_at of [12345, null, '', 'last tuesday', undefined,
                           new Date(Date.parse(NOW) + 1000 * 3600).toISOString()]) {
    const f = fixture(t);
    assert.equal(clear(f).status, 0);
    const cy = JSON.parse(fs.readFileSync(f.comply, 'utf8'));
    cy.issued_at = issued_at;
    fs.writeFileSync(f.comply, JSON.stringify(cy));

    assert.equal(review(f).status, 3, `issued_at ${JSON.stringify(issued_at)} must not clear`);
    assert.equal(complyCheck(verdictOf(f)).comply_state, 'stale');
  }
});

test('a clearance may not set the terms of its own expiry', (t) => {
  const f = fixture(t);
  const old = new Date(Date.parse(NOW) - (MAX_AGE_H + 5) * 3600_000).toISOString();
  assert.equal(clear(f, { NOW: old }).status, 0);

  const cy = JSON.parse(fs.readFileSync(f.comply, 'utf8'));
  cy.expires_at = '2099-01-01T00:00:00.000Z';   // the document's own claim
  cy.max_age_hours = 100000;                     // and its own idea of the window
  fs.writeFileSync(f.comply, JSON.stringify(cy));

  assert.equal(review(f).status, 3, 'age is measured against gates.yaml, not against the document');
  assert.equal(complyCheck(verdictOf(f)).comply_state, 'stale');
});
