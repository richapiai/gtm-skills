// tests/evals/comply/ccpa.test.mjs — the CCPA/CPRA rule set, eval-tested.
//
// Adversarial, and asserting the refusal or the explicit-null enum, never the prose.
//
// CCPA is the rule set most likely to be got wrong by borrowing, because it is NOT a
// consent regime for business email. The tempting failures are symmetric: invent a
// GDPR-shaped "lawful basis" for a Californian, or read "no consent needed" as "no
// gate". The first case below pins the answer to `not_applicable`, which is one of the
// three explicit nulls, and the rest pin the obligations that do apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import { ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore, writeOutputList }
  from '../../../_lib/suppression.mjs';
import { loadComplyRules, checkRow, screenList, ALLOW, STOP, NULL_ENUM, NOT_FOUND, NOT_APPLICABLE }
  from '../../skills/comply/harness.mjs';

const RULES = loadComplyRules();
const NOW = new Date('2026-08-28T12:00:00Z');

function withStore (t, entries = []) {
  const tree = makeGtmTree({ prefix: 'eval-ccpa-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  for (const e of entries) addSuppressionEntry(e, { root: tree.root });
  return { tree, store: loadSuppressionStore({ root: tree.root }) };
}

/** A row that clears CCPA: a Californian with a notice at collection on file. */
const CLEARS = Object.freeze({
  email: 'jo@bigco.example',
  subject_region: 'US-CA',
  subject_country: 'US',
  notice_at_collection: true,
  unsubscribe_mechanism: true,
  sender_postal_address: '1 Market St, San Francisco CA 94105',
  data_source: 'conference badge scan',
});

const row = (over) => ({ ...CLEARS, ...over });

test('CCPA — the clearing row really clears, so every refusal below is specific', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, ALLOW, JSON.stringify(v.reasons));
  // A Californian is subject to the federal floor AND to CCPA, and `all_apply` means
  // both must clear. CCPA alone here would be the pack deciding that California
  // repealed CAN-SPAM.
  assert.deepEqual(v.jurisdictions, ['can_spam', 'ccpa']);
});

test('CCPA — the basis question is answered with the explicit null, never with a borrowed one', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  // The one assertion this whole file exists for. CCPA asks no consent question for
  // business email, so the honest answer is `not_applicable` — not `not_found`
  // (which would imply a missing record), and above all not a GDPR basis wheeled in
  // to fill the column.
  assert.equal(v.basis, NOT_APPLICABLE);
  assert.ok(NULL_ENUM.includes(v.basis));
  assert.notEqual(v.basis, 'legitimate_interest');
  assert.notEqual(v.basis, 'consent');
  // And a row that volunteers a GDPR basis does not get credit for it.
  const volunteered = checkRow(row({ lawful_basis: 'legitimate_interest' }), { rules: RULES, store, now: NOW });
  assert.equal(volunteered.basis, NOT_APPLICABLE);
});

test('CCPA Sec. 1798.100 — no notice at collection is a refusal', (t) => {
  const { store } = withStore(t);
  for (const val of [undefined, false, '', 'pending']) {
    const v = checkRow(row({ notice_at_collection: val }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `notice_at_collection=${JSON.stringify(val)} passed`);
    assert.ok(v.reasons.includes('ccpa:notice_at_collection_missing'));
  }
});

test('CCPA Sec. 1798.120 — a recorded opt-out of sale or sharing is a refusal', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row({ opt_out_sale: true }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('ccpa:opt_out_of_sale_recorded'));
});

test('CCPA Sec. 1798.121 — sensitive personal information with no notice is a refusal', (t) => {
  const { store } = withStore(t);
  // The pack can reach a personal address and a direct dial. Holding that without a
  // sensitive-PI notice is the row the gate exists for.
  const v = checkRow(row({ sensitive_pi: true }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('ccpa:sensitive_pi_without_notice'));
  const noticed = checkRow(row({ sensitive_pi: true, sensitive_pi_notice: true }), { rules: RULES, store, now: NOW });
  assert.equal(noticed.verdict, ALLOW, JSON.stringify(noticed.reasons));
});

test('CCPA — no working unsubscribe is a refusal', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row({ unsubscribe_mechanism: false }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('ccpa:no_unsubscribe_mechanism'));
});

test('CCPA Sec. 1798.105 — a deletion request keeps them out of the output, via the real engine', (t) => {
  const { tree, store } = withStore(t, [{ email: 'jo@bigco.example', reason: 'ccpa_delete_request' }]);

  // The gate refuses the row…
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('ccpa:suppressed'));

  // …and the enforcement point refuses to write it, which is the property that
  // actually matters. Nothing here re-implements a membership test.
  const file = path.join(tree.root, 'gtm', 'lists', 'out.csv');
  const res = writeOutputList(file, [row(), row({ email: 'other@bigco.example' })], { root: tree.root });
  assert.equal(res.suppressed, 1);
  assert.equal(res.written, 1);
  assert.ok(!fs.readFileSync(file, 'utf8').toLowerCase().includes('jo@bigco.example'));
});

test('CCPA is not inferred from "US" — a non-Californian American gets the federal floor only', (t) => {
  const { store } = withStore(t);
  // The soft failure this catches: treating CCPA as "the US rule set", clearing every
  // American under it, and shipping to the 49 states it does not cover.
  const v = checkRow(row({ subject_region: undefined }), { rules: RULES, store, now: NOW });
  assert.deepEqual(v.jurisdictions, ['can_spam'], 'CCPA must not follow from the country');
  assert.equal(v.verdict, ALLOW, JSON.stringify(v.reasons));
  // And the other half of the old failure — a US row is no longer UNRESOLVED either.
  // It was, and the fix message told a Seattle operator to add the country column the
  // row already carried.
  assert.ok(!v.reasons.includes('unknown_jurisdiction'));
});

test('a US state outside California resolves, and is held to CAN-SPAM', (t) => {
  const { store } = withStore(t);
  const wa = row({ subject_region: 'US-WA', email: 'sam@seattleco.example' });
  assert.deepEqual(checkRow(wa, { rules: RULES, store, now: NOW }).jurisdictions, ['can_spam']);
  // The subdivision alone locates the row: US-WA names its country in its prefix.
  const regionOnly = checkRow(row({ subject_region: 'US-WA', subject_country: undefined }),
    { rules: RULES, store, now: NOW });
  assert.deepEqual(regionOnly.jurisdictions, ['can_spam']);
  // 15 U.S.C. 7704(a)(5): no physical postal address, no send.
  const noAddr = checkRow(row({ subject_region: 'US-WA', sender_postal_address: '' }),
    { rules: RULES, store, now: NOW });
  assert.equal(noAddr.verdict, STOP);
  assert.ok(noAddr.reasons.includes('can_spam:no_physical_postal_address'));
  // And the opt-out obligation, which is the whole of CAN-SPAM that has teeth.
  const noUnsub = checkRow(row({ subject_region: 'US-WA', unsubscribe_mechanism: false }),
    { rules: RULES, store, now: NOW });
  assert.equal(noUnsub.verdict, STOP);
  assert.ok(noUnsub.reasons.includes('can_spam:no_unsubscribe_mechanism'));
});

test('a country with no rule set is refused as no_rule_set, not as "add a country"', (t) => {
  const { store } = withStore(t);
  // JP is a real country and this pack ships no rule set for it. Refusing is right;
  // telling the operator to add the `subject_country` they just filled in is not.
  const jp = checkRow(row({ subject_region: undefined, subject_country: 'JP' }),
    { rules: RULES, store, now: NOW });
  assert.equal(jp.verdict, STOP);
  assert.equal(jp.jurisdiction, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(jp.jurisdiction));
  assert.ok(jp.reasons.includes('no_rule_set:jp'), JSON.stringify(jp.reasons));
  assert.ok(!jp.reasons.includes('unknown_jurisdiction'));
  // A row that genuinely says nothing still reads as unknown, because there the fix
  // IS to add a column.
  const nowhere = checkRow(row({ subject_region: undefined, subject_country: undefined, email: 'x@y.example' }),
    { rules: RULES, store, now: NOW });
  assert.equal(nowhere.verdict, STOP);
  assert.ok(nowhere.reasons.includes('unknown_jurisdiction'), JSON.stringify(nowhere.reasons));
  // XX is not an assigned ISO 3166-1 code, so it is a typo, not a jurisdiction.
  const typo = checkRow(row({ subject_region: undefined, subject_country: 'XX' }),
    { rules: RULES, store, now: NOW });
  assert.ok(typo.reasons.includes('unknown_jurisdiction'), JSON.stringify(typo.reasons));
});

test('CCPA — screening a list refuses the bad rows and clears the good one', (t) => {
  const { tree } = withStore(t, [{ domain: 'blocked.example', reason: 'do_not_contact' }]);
  const { cleared, refused } = screenList([
    row(),
    row({ email: 'a@blocked.example' }),
    row({ notice_at_collection: false, email: 'b@bigco.example' }),
    row({ subject_region: undefined, subject_country: 'XX', email: 'c@bigco.example' }),
  ], { root: tree.root, rules: RULES, now: NOW });
  assert.equal(cleared.length, 1);
  assert.equal(refused.length, 3);
  for (const r of refused) assert.equal(r.verdict.verdict, STOP);
});

test('CCPA — the rule set is still wired to the gate table and cites its sections', () => {
  const ccpa = RULES.jurisdictions.ccpa;
  assert.ok(ccpa, 'the ccpa rule set vanished from skills/comply/SKILL.md');
  assert.match(ccpa.citation, /CCPA|CPRA/);
  assert.match(ccpa.citation, /1798\.\d+/);
  assert.equal(ccpa.absent_basis_is, NOT_APPLICABLE);
  for (const fact of ['suppressed', 'notice_at_collection_missing', 'opt_out_of_sale_recorded',
                      'sensitive_pi_without_notice', 'no_unsubscribe_mechanism']) {
    assert.ok(ccpa.refuse_when.includes(fact), `ccpa stopped refusing on ${fact}`);
  }
});
