// What the review is allowed to count as an address, and as a verification.
//
// A live run produced this verdict over a list of 25 rows: "100% coverage, 0% fail
// rate", PASS. Every one of those 25 rows held the literal string `not_found` in its
// email column, written by `email_finder` when it failed to find anything, and the
// finder's `email_status` beside it. Nobody had run a verifier; there was nothing to
// send to. The review counted the markers as addresses and the finder's column as a
// verdict, and cleared the list for launch.
//
// Two rules, one test file:
//   1. verification comes only from the VERIFIER's own column;
//   2. an explicit null is a recorded absence, never a value.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeGtmTree } from '../../helpers/index.mjs';
import { ensureSuppressionStore } from '../../../_lib/suppression.mjs';
import { runReview } from '../launch/skill-runner.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

function review (t, csv) {
  const g = makeGtmTree({ prefix: 's4-evidence-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  const list = g.write('gtm/lists/q3.csv', csv);
  const out = g.path('gtm/reviews/q3.verdict.json');
  const r = runReview({ LIST: list, ROOT: g.root, OUT: out, NOW });
  return { ...r, verdict: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

const csv = (header, ...rows) => [header, ...rows].join('\n') + '\n';
const gateOf = (v, name) => v.checks.find((c) => c.gate === name);

test("the finder's email_status is not a verification verdict", (t) => {
  // Every row "valid" according to email_finder, and nothing verified.
  const r = review(t, csv('email,first_name,email_status',
    'a@one.example,A,valid', 'b@two.example,B,valid', 'c@three.example,C,valid'));
  const ver = gateOf(r.verdict, 'quality_stops.verification_max_fail_rate_pct');
  assert.equal(ver.decision, 'stop', 'an unverified list reported a fail rate: ' + ver.reason);
  assert.match(ver.reason, /not measured|no row carries a verifier verdict/);
  assert.equal(r.verdict.status, 'FAIL');
  assert.equal(r.status, 3);
});

test("the verifier's own column is measured, and its verdict is the one that counts", (t) => {
  const r = review(t, csv('email,email_status,email_verification_status',
    'a@one.example,valid,valid', 'b@two.example,valid,valid', 'c@three.example,valid,invalid'));
  const ver = gateOf(r.verdict, 'quality_stops.verification_max_fail_rate_pct');
  assert.match(ver.reason, /33/, 'one invalid in three is a measured 33%: ' + ver.reason);
});

test('an explicit null in the status column is not a passing verdict', (t) => {
  // `not_found` is neither valid nor invalid — it is the absence of an answer. Read as
  // a value it is "not in the FAILED set", i.e. a pass, which is how a list nobody
  // verified reported a 0% fail rate.
  const r = review(t, csv('email,email_verification_status',
    'a@one.example,not_found', 'b@two.example,not_verifiable', 'c@three.example,not_applicable'));
  const ver = gateOf(r.verdict, 'quality_stops.verification_max_fail_rate_pct');
  assert.equal(ver.decision, 'stop', ver.reason);
  assert.match(ver.reason, /not measured|no row carries a verifier verdict/);
});

test('an explicit null in the email column is not an address', (t) => {
  const r = review(t, csv('email,first_name',
    'not_found,A', 'not_found,B', 'not_found,C', 'd@four.example,D'));
  const cov = gateOf(r.verdict, 'quality_stops.coverage_min_pct');
  assert.equal(cov.decision, 'stop', 'three `not_found` markers were counted as addresses: ' + cov.reason);
  assert.match(cov.reason, /\b25(\.0)?%/, cov.reason);
});

test('a value that is not a mailbox is not an address either', (t) => {
  // The other half of the same hole: a name, a URL or a dash in the email column.
  const r = review(t, csv('email,first_name',
    'unknown,A', '-,B', 'https://li/c,C', 'd@four.example,D'));
  const cov = gateOf(r.verdict, 'quality_stops.coverage_min_pct');
  assert.equal(cov.decision, 'stop', cov.reason);
  assert.match(cov.reason, /\b25(\.0)?%/, cov.reason);
});
