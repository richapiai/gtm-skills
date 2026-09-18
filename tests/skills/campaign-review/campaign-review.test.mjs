// /campaign-review — the verdict, and what it is bound to.
//
// The verdict is the only thing that can unlock /launch, so a verdict that passes
// something it did not check, or that binds to a list it did not read, is worse than
// no gate at all: it launders an unreviewed list into a reviewed one.
//
// Like the /launch suite, every case runs the script that ships inside
// skills/campaign-review/SKILL.md, extracted verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash } from '../../../_lib/sender-export.mjs';
import { ensureSuppressionStore, addSuppressionEntry } from '../../../_lib/suppression.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { runReview, runLaunch, gatesFileWith, PACK_ROOT } from '../launch/skill-runner.mjs';
// /comply is now a real gate that /campaign-review consumes, so a fixture list has
// to carry the compliance columns and a clearance has to exist before review runs.
// Before this check, a list with no clearance at all passed review — which is the
// behaviour that was removed, so these fixtures had to move with it.
import { clearRow, csvOf as complyCsvOf, runComply, LIST_COLS } from '../comply/comply-runner.mjs';

const GATES = loadGates();
const MAX_AGE_H = gateValue(GATES, 'skills.campaign_review.verdict_max_age_hours');
const FULL_READ_MAX = gateValue(GATES, 'skills.campaign_review.full_read_max_rows');
const COVERAGE_MIN = gateValue(GATES, 'quality_stops.coverage_min_pct');
const FAIL_MAX = gateValue(GATES, 'quality_stops.verification_max_fail_rate_pct');

const HEAD = LIST_COLS.join(',');
const row = (n, { email, status } = {}) => clearRow(n, {
  ...(email === undefined ? {} : { email }),
  // The VERIFIER's column. The finder's `email_status` is not a verification verdict
  // and the review no longer reads it as one.
  ...(status === undefined ? {} : { email_verification_status: status }),
});
const csvOf = complyCsvOf;
const CLEAN = csvOf([row(1), row(2), row(3), row(4)]);

const NOW = '2026-08-28T12:00:00.000Z';

function fixture (t, { csv = CLEAN, suppress = [] } = {}) {
  const g = makeGtmTree({ prefix: 's4-review-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  for (const s of suppress) addSuppressionEntry({ email: s, reason: 'test' }, { root: g.root });
  const list = g.write('gtm/lists/q3.csv', csv);
  // The clearance /campaign-review reads. Written by the shipped /comply script, not
  // hand-rolled, so a change to the rule table moves these fixtures with it.
  runComply({ LIST: list, ROOT: g.root, NOW });
  return {
    g, list, rows: parseCsv(csv), out: g.path('gtm/reviews/q3.verdict.json'),
    // A clearance binds a list hash AND a clock. A test that edits the list or
    // reviews at a different time must re-clear, which is what an operator does too.
    reComply: (now = NOW) => runComply({ LIST: list, ROOT: g.root, NOW: now }),
  };
}

const review = (f, env = {}) => runReview({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW, ...env });
const verdictOf = (f) => JSON.parse(fs.readFileSync(f.out, 'utf8'));

// ===========================================================================
// A verdict, and what binds it.
// ===========================================================================

test('a clean list PASSes, and the verdict binds hash and clock', (t) => {
  const f = fixture(t);
  const r = review(f);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^PASS /m);

  const v = verdictOf(f);
  assert.equal(v.status, 'PASS');
  assert.equal(v.list_hash, listContentHash(f.rows), 'the verdict must bind the list it read');
  assert.equal(v.rows_total, 4);
  assert.equal(v.read_mode, 'full');
  assert.equal(v.issued_at, NOW);
  assert.equal(v.max_age_hours, MAX_AGE_H);
  assert.equal(v.expires_at, new Date(Date.parse(NOW) + MAX_AGE_H * 3600_000).toISOString(),
    'expiry is issued_at plus gates.yaml:skills.campaign_review.verdict_max_age_hours');
  assert.deepEqual(v.blocking, []);
  assert.ok(v.checks.some((c) => c.gate === 'quality_stops.coverage_min_pct' && c.decision === 'allow'));
  assert.ok(v.checks.some((c) => c.gate === 'suppression' && c.decision === 'allow'));
});

test('the hash is over contact values, not column order or row order', (t) => {
  const a = fixture(t);
  review(a);

  // Same people, different column order and reversed rows.
  const cols = HEAD.split(',').reverse();
  const rows = parseCsv(CLEAN).reverse();
  const b = fixture(t, { csv: [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n' });
  review(b);

  assert.equal(verdictOf(a).list_hash, verdictOf(b).list_hash);

  // One character in one contact IS a change.
  const c = fixture(t, { csv: CLEAN.replace('First1', 'Firstie') });
  review(c);
  assert.notEqual(verdictOf(a).list_hash, verdictOf(c).list_hash);
});

// ===========================================================================
// The gates. Each FAIL names the gate key that stopped it.
// ===========================================================================

test('a suppressed contact on the list is a FAIL, checked over every row', (t) => {
  const f = fixture(t, { suppress: ['p3@e3.example'] });
  const r = review(f);
  assert.equal(r.status, 3, r.out);

  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.deepEqual(v.blocking, ['suppression', 'comply']);
  const stop = v.checks.find((c) => c.gate === 'suppression');
  assert.equal(stop.suppressed_rows, 1);
  assert.match(stop.reason, /\/list-hygiene/, 'a FAIL must name the fix');
});

test('coverage below the floor is a FAIL that cites its gate key', (t) => {
  // Three of four rows have no email at all: well under the floor.
  // Built with clearRow so the record is the full LIST_COLS width. It used to be a
  // hand-written 7-field string under a 20-field header, which parseCsv now refuses
  // (a ragged record cannot be read as columns); the seven values it did carry are
  // exactly clearRow's, so the fixture means the same thing.
  const noEmail = (n) => clearRow(n, { email: '' });
  const f = fixture(t, { csv: csvOf([row(1), noEmail(2), noEmail(3), noEmail(4)]) });
  const r = review(f);
  assert.equal(r.status, 3, r.out);

  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.ok(v.blocking.includes('quality_stops.coverage_min_pct'), JSON.stringify(v.blocking));
  assert.match(r.stdout, new RegExp(String(COVERAGE_MIN)));
});

test('an UNMEASURED verification rate is a stop, never a zero', (t) => {
  // A list nobody verified. The tempting reading is "no failures recorded".
  const noStatus = [
    'email,first_name,last_name,company_name',
    'p1@e1.example,A,B,Co1',
    'p2@e2.example,C,D,Co2',
  ].join('\n') + '\n';
  const f = fixture(t, { csv: noStatus });
  const r = review(f);
  assert.equal(r.status, 3, r.out);

  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.ok(v.blocking.includes('quality_stops.verification_max_fail_rate_pct'));
  const stop = v.checks.find((c) => c.gate === 'quality_stops.verification_max_fail_rate_pct');
  assert.match(stop.reason, /no row carries a verifier verdict/);
  assert.match(stop.reason, /enrich-waterfall/, 'a FAIL must name the fix');
});

test('a verification fail rate over the floor is a FAIL', (t) => {
  // Half the list is undeliverable, comfortably over the ceiling.
  const f = fixture(t, {
    csv: csvOf([row(1), row(2), row(3, { status: 'invalid' }), row(4, { status: 'invalid' })]),
  });
  const r = review(f);
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.ok(v.blocking.includes('quality_stops.verification_max_fail_rate_pct'), JSON.stringify(v.blocking));
  assert.ok(50 > FAIL_MAX, 'fixture assumes the floor is under half the list');
});

test('an unreadable suppression store FAILs the review, it does not skip it', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.g.root, 'gtm', 'suppression.jsonl'));

  const r = review(f);
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  const stop = v.checks.find((c) => c.gate === 'suppression');
  assert.equal(stop.failed_closed, true);
  assert.match(stop.reason, /not a passing check/);
  // A verdict that could not establish its own lifetime has already expired.
  assert.equal(v.expires_at, v.issued_at);
});

test('a gates.yaml key that does not resolve FAILs the review (law 5)', (t) => {
  const f = fixture(t);
  const broken = gatesFileWith(f.g.root, (d) => { delete d.quality_stops.coverage_min_pct; });

  const r = review(f, { GATES_FILE: broken });
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.ok(v.checks.some((c) => c.failed_closed === true && /coverage_min_pct/.test(c.gate)), JSON.stringify(v.checks));
});

// ===========================================================================
// full_read_max_rows — sample above it, every row at or below it.
// ===========================================================================

test('at or below full_read_max_rows every row is read', (t) => {
  const f = fixture(t, { csv: csvOf(Array.from({ length: 8 }, (_, i) => row(i + 1))) });
  const tuned = gatesFileWith(f.g.root, (d) => { d.skills.campaign_review.full_read_max_rows = 8; });

  const r = review(f, { GATES_FILE: tuned });
  assert.equal(r.status, 0, r.out);
  const v = verdictOf(f);
  assert.equal(v.read_mode, 'full');
  assert.equal(v.rows_read, 8);
  assert.equal(v.rows_total, 8);
});

test('above full_read_max_rows the tallies sample, but the hash still covers every row', (t) => {
  const f = fixture(t, { csv: csvOf(Array.from({ length: 40 }, (_, i) => row(i + 1))) });
  const tuned = gatesFileWith(f.g.root, (d) => { d.skills.campaign_review.full_read_max_rows = 10; });

  const r = review(f, { GATES_FILE: tuned });
  assert.equal(r.status, 0, r.out);
  const v = verdictOf(f);
  assert.equal(v.read_mode, 'sample');
  assert.equal(v.rows_total, 40);
  assert.ok(v.rows_read < 40 && v.rows_read > 0, `sampled ${v.rows_read} of 40`);
  assert.equal(v.list_hash, listContentHash(f.rows), 'the binding must cover every row, sampled or not');
  assert.match(r.stdout, /read sample/);
});

test('the sample never hides a suppressed contact', (t) => {
  // The suppressed contact is the very last row: a naive "first N" sample misses it.
  const rows = Array.from({ length: 40 }, (_, i) => row(i + 1));
  const f = fixture(t, { csv: csvOf(rows), suppress: ['p40@e40.example'] });
  const tuned = gatesFileWith(f.g.root, (d) => { d.skills.campaign_review.full_read_max_rows = 5; });

  const r = review(f, { GATES_FILE: tuned });
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.read_mode, 'sample');
  assert.deepEqual(v.blocking, ['suppression', 'comply']);
});

// ===========================================================================
// The whole mechanism, end to end. This is the case the feature exists for.
// ===========================================================================

test('review PASS then launch writes; edit one row and launch refuses', (t) => {
  const f = fixture(t);
  const out = f.g.path('gtm/exports/q3.instantly.csv');

  assert.equal(review(f).status, 0);
  const ok = runLaunch({ LIST: f.list, VERDICT: f.out, OUT: out, PLATFORM: 'instantly', ROOT: f.g.root, NOW });
  assert.equal(ok.status, 0, ok.out);
  assert.ok(fs.existsSync(out));
  fs.rmSync(out);

  // One row changes after the PASS. Nothing else moves.
  fs.writeFileSync(f.list, CLEAN.replace('p2@e2.example', 'p2.new@e2.example'));
  const refused = runLaunch({ LIST: f.list, VERDICT: f.out, OUT: out, PLATFORM: 'instantly', ROOT: f.g.root, NOW });
  assert.equal(refused.status, 3);
  assert.match(refused.stderr, /HASH_MISMATCH/);
  assert.equal(fs.existsSync(out), false);

  // Re-reviewing the list as it now stands is the only way through, and it works.
  // The clearance is bound to the old hash too, so it is re-taken first — the same
  // two steps the operator runs.
  f.reComply();
  assert.equal(review(f).status, 0);
  const again = runLaunch({ LIST: f.list, VERDICT: f.out, OUT: out, PLATFORM: 'instantly', ROOT: f.g.root, NOW });
  assert.equal(again.status, 0, again.out);
  assert.ok(fs.existsSync(out));
});

test('a FAIL verdict written by this skill is the one /launch refuses', (t) => {
  const f = fixture(t, { suppress: ['p1@e1.example'] });
  assert.equal(review(f).status, 3);

  const out = f.g.path('gtm/exports/q3.csv');
  const r = runLaunch({ LIST: f.list, VERDICT: f.out, OUT: out, PLATFORM: 'csv', ROOT: f.g.root, NOW });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /FAIL_VERDICT/);
  assert.match(r.stderr, /suppression/, "launch must relay the verdict's blocking gates");
  assert.equal(fs.existsSync(out), false);
});

test('a PASS goes stale on the clock alone, with the list untouched', (t) => {
  const f = fixture(t);
  const issued = new Date(Date.parse(NOW) - (MAX_AGE_H + 2) * 3600_000).toISOString();
  // Clear at the same instant the review runs. The default clearance is stamped NOW,
  // which is in this review's future, and a future-dated clearance is unmeasurable
  // rather than fresh — correct, but not what this test is about.
  f.reComply(issued);
  assert.equal(review(f, { NOW: issued }).status, 0);

  const v = verdictOf(f);
  assert.equal(v.status, 'PASS');
  assert.equal(v.list_hash, listContentHash(f.rows), 'the list has not moved');

  const out = f.g.path('gtm/exports/q3.csv');
  const r = runLaunch({ LIST: f.list, VERDICT: f.out, OUT: out, PLATFORM: 'csv', ROOT: f.g.root, NOW });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /STALE_VERDICT/);
  assert.equal(fs.existsSync(out), false);

  // And re-running the review is genuinely the whole fix: no calls, no credits.
  // The clearance was taken at `issued` and is stale on the same clock, so it is
  // re-taken alongside — both are free.
  f.reComply();
  assert.equal(review(f).status, 0);
  assert.equal(runLaunch({ LIST: f.list, VERDICT: f.out, OUT: out, PLATFORM: 'csv', ROOT: f.g.root, NOW }).status, 0);
});

// ===========================================================================
// The review spends nothing. It is the cheapest thing in the pack on purpose,
// because a gate people avoid re-running is a gate people route around.
// ===========================================================================

test('the review names no endpoint and makes no paid call', () => {
  const md = fs.readFileSync(path.join(PACK_ROOT, 'skills', 'campaign-review', 'SKILL.md'), 'utf8');
  assert.match(md, /zero API calls/i);
  // The default full_read_max_rows is large enough that the sample path is the
  // exception, not the rule: a reviewer who samples every list is not a reviewer.
  assert.ok(FULL_READ_MAX >= 1000, `full_read_max_rows is ${FULL_READ_MAX}`);
});
