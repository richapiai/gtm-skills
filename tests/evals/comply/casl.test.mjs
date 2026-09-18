// tests/evals/comply/casl.test.mjs — the CASL rule set, eval-tested.
//
// Adversarial, and asserting the refusal or the explicit-null enum, never the prose.
//
// CASL is the strictest of the three and the one whose failure mode is a clock. Implied
// consent is real consent right up until it silently is not, and the tempting bug is to
// check that a consent record EXISTS rather than that it is still live. Half this file
// is that clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeGtmTree } from '../../helpers/index.mjs';
import { ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore }
  from '../../../_lib/suppression.mjs';
import { loadComplyRules, checkRow, ALLOW, STOP, NULL_ENUM, NOT_FOUND }
  from '../../skills/comply/harness.mjs';

const RULES = loadComplyRules();
const NOW = new Date('2026-08-28T12:00:00Z');

function withStore (t, entries = []) {
  const tree = makeGtmTree({ prefix: 'eval-casl-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  for (const e of entries) addSuppressionEntry(e, { root: tree.root });
  return { tree, store: loadSuppressionStore({ root: tree.root }) };
}

/** A row that clears CASL: express consent on file, with a working unsubscribe. */
const CLEARS = Object.freeze({
  email: 'pat@maple.example',
  subject_country: 'CA',
  consent_kind: 'express',
  consent_record_id: 'C-2026-31',
  consent_timestamp: '2026-02-01T00:00:00Z',
  unsubscribe_mechanism: true,
  data_source: 'newsletter signup form',
});

const row = (over) => ({ ...CLEARS, ...over });

test('CASL — the clearing row really clears, so every refusal below is specific', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, ALLOW, JSON.stringify(v.reasons));
  assert.deepEqual(v.jurisdictions, ['casl']);
  assert.equal(v.basis, 'express');
});

test('CASL — no consent record at all is refused, and the basis is the explicit null', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row({ consent_kind: undefined, consent_record_id: undefined }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.basis, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(v.basis));
  assert.ok(v.reasons.includes('casl:basis_not_recorded'));
});

test('CASL — express consent asserted with no stored record is refused', (t) => {
  const { store } = withStore(t);
  // "They definitely signed up" is not a consent record. CASL puts the burden of
  // proving consent on the sender, so an unevidenced claim is worth nothing.
  const v = checkRow(row({ consent_record_id: '' }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.basis, NOT_FOUND);
  assert.ok(v.reasons.includes('casl:evidence_missing:consent_record_id'));
});

test('CASL — a consent kind the regime does not recognise is not consent', (t) => {
  const { store } = withStore(t);
  for (const invented of ['assumed', 'soft', 'opt_out', 'legitimate_interest']) {
    const v = checkRow(row({ consent_kind: invented }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `"${invented}" was accepted as CASL consent`);
    assert.equal(v.basis, NOT_FOUND);
  }
});

// --- the clock: s.10(9)(a) ---------------------------------------------------

test('CASL s.10(9)(a) — implied consent from an inquiry expires, and an expired record is refused', (t) => {
  const { store } = withStore(t);
  const fresh = row({
    consent_kind: 'implied', consent_event: 'inquiry',
    consent_timestamp: '2026-06-01T00:00:00Z', consent_record_id: undefined,
  });
  assert.equal(checkRow(fresh, { rules: RULES, store, now: NOW }).verdict, ALLOW);

  // Same record, same shape, older. The only thing that changed is the clock — which
  // is exactly the change an existence check cannot see.
  const stale = { ...fresh, consent_timestamp: '2025-11-01T00:00:00Z' };
  const v = checkRow(stale, { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('casl:implied_consent_expired'));
});

test('CASL s.10(9)(a) — implied consent from a transaction runs longer, and still expires', (t) => {
  const { store } = withStore(t);
  const base = { consent_kind: 'implied', consent_event: 'transaction', consent_record_id: undefined };
  // Inside the window.
  assert.equal(checkRow(row({ ...base, consent_timestamp: '2025-06-01T00:00:00Z' }),
    { rules: RULES, store, now: NOW }).verdict, ALLOW);
  // Outside it. A transaction long enough ago is not a relationship.
  const v = checkRow(row({ ...base, consent_timestamp: '2023-01-01T00:00:00Z' }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('casl:implied_consent_expired'));
  // The two windows are genuinely different lengths, or one of them is decorative.
  const inquiryAtSameAge = checkRow(row({
    consent_kind: 'implied', consent_event: 'inquiry', consent_record_id: undefined,
    consent_timestamp: '2025-06-01T00:00:00Z',
  }), { rules: RULES, store, now: NOW });
  assert.equal(inquiryAtSameAge.verdict, STOP,
    'the inquiry window must be shorter than the transaction window');
});

test('CASL — an implied consent whose event or date cannot be read is treated as expired', (t) => {
  const { store } = withStore(t);
  const cases = [
    { consent_event: undefined },                       // no event named
    { consent_event: 'we_met_once' },                   // an event with no window
    { consent_timestamp: 'sometime last spring' },      // an unreadable clock
    { consent_timestamp: undefined },                   // no clock at all
  ];
  for (const over of cases) {
    const v = checkRow(row({
      consent_kind: 'implied', consent_event: 'inquiry',
      consent_timestamp: '2026-06-01T00:00:00Z', consent_record_id: undefined, ...over,
    }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `${JSON.stringify(over)} was allowed to pass as live consent`);
  }
});

// --- s.10(9)(b): the conspicuously published address -------------------------

test('CASL s.10(9)(b) — a published address that refuses such messages is refused', (t) => {
  const { store } = withStore(t);
  const published = {
    consent_kind: 'implied', consent_event: 'published_address',
    consent_timestamp: '2026-05-01T00:00:00Z', consent_record_id: undefined,
    role_relevant: true,
  };
  // A published address with no refusal notice and a role-relevant message has no
  // expiry clock — so this must clear, or the case below proves nothing.
  assert.equal(checkRow(row(published), { rules: RULES, store, now: NOW }).verdict, ALLOW);

  // The page said "no unsolicited commercial email". The exemption is void.
  const v = checkRow(row({ ...published, published_address_refuses_cem: true }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('casl:published_address_refuses_cem'));
});

test('CASL s.10(9)(b) — a message not relevant to the published role is refused', (t) => {
  const { store } = withStore(t);
  // The exemption covers messages relevant to the recipient's business role. It is
  // not a licence to mail every scraped address about anything.
  for (const over of [{ role_relevant: false }, { role_relevant: undefined }]) {
    const v = checkRow(row({
      consent_kind: 'implied', consent_event: 'published_address',
      consent_timestamp: '2026-05-01T00:00:00Z', consent_record_id: undefined, ...over,
    }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP);
    assert.ok(v.reasons.includes('casl:role_irrelevant'));
  }
});

// --- s.6(2) and the suppression engine ---------------------------------------

test('CASL s.6(2) — no working unsubscribe is a refusal even with express consent', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row({ unsubscribe_mechanism: false }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('casl:no_unsubscribe_mechanism'));
});

test('CASL — withdrawal of consent beats a live consent record', (t) => {
  const { store } = withStore(t, [{ email: 'pat@maple.example', reason: 'unsubscribe' }]);
  // Express consent on file, unexpired, evidenced — and they unsubscribed. The
  // suppression engine is the authority, and it is called, not re-implemented.
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.suppressed, true);
  assert.ok(v.reasons.includes('casl:suppressed'));
});

test('CASL — a .ca address reaches the rule set even with no country column', (t) => {
  const { store } = withStore(t);
  const v = checkRow({
    email: 'pat@maple.ca', consent_kind: 'express', consent_record_id: 'C-1',
    consent_timestamp: '2026-02-01T00:00:00Z', unsubscribe_mechanism: true,
    data_source: 'signup',
  }, { rules: RULES, store, now: NOW });
  assert.deepEqual(v.jurisdictions, ['casl']);
});

test('CASL — the rule set is still wired to the gate table and cites its sections', () => {
  const casl = RULES.jurisdictions.casl;
  assert.ok(casl, 'the casl rule set vanished from skills/comply/SKILL.md');
  assert.match(casl.citation, /CASL/);
  assert.match(casl.citation, /s\.\s*(?:6|10)/);
  for (const fact of ['suppressed', 'objection_recorded', 'implied_consent_expired',
                      'published_address_refuses_cem', 'role_irrelevant', 'no_unsubscribe_mechanism']) {
    assert.ok(casl.refuse_when.includes(fact), `casl stopped refusing on ${fact}`);
  }
  // The windows are the statute's, not a policy knob, and they must stay ordered.
  const w = casl.implied_consent_windows;
  assert.ok(w.transaction.months > w.inquiry.months,
    'CASL gives a transaction a longer implied-consent window than an inquiry');
  assert.equal(w.published_address, 'none');
});
