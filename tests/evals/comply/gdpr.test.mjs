// tests/evals/comply/gdpr.test.mjs — the GDPR rule set, eval-tested.
//
// Same contract as tests/evals/iron-laws.test.mjs: every case is ADVERSARIAL. Each
// hands /comply a row where the tempting answer is "looks fine, send it", and asserts
// the REFUSAL or the explicit-null enum value — never the prose around it. A prose
// assertion would pass forever the moment someone reworded the paragraph above the
// rule; these fail the moment the rule stops firing.
//
// The rule table under test is the `comply-rules` block inside skills/comply/SKILL.md.
// The harness only runs it. Everything with consequences is the shipped engine.

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
  const tree = makeGtmTree({ prefix: 'eval-gdpr-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  for (const e of entries) addSuppressionEntry(e, { root: tree.root });
  return { tree, store: loadSuppressionStore({ root: tree.root }) };
}

/**
 * A row that clears GDPR: a German data subject, a corporate address, a recorded
 * legitimate-interest assessment, a disclosed source (Art. 14) and a working
 * unsubscribe. Every case below breaks exactly one of those.
 */
const CLEARS = Object.freeze({
  email: 'ada@acme-eu.example',
  subject_country: 'DE',
  lawful_basis: 'legitimate_interest',
  lia_record_id: 'LIA-014',
  data_source: 'company team page, captured at import',
  unsubscribe_mechanism: true,
  objection: false,
});

const row = (over) => ({ ...CLEARS, ...over });

test('GDPR — the clearing row really clears, so every refusal below is specific', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, ALLOW, JSON.stringify(v.reasons));
  assert.deepEqual(v.jurisdictions, ['gdpr']);
  assert.equal(v.basis, 'legitimate_interest');
});

test('GDPR Art. 6 — a row with no recorded lawful basis is refused, and the basis is the explicit null', (t) => {
  const { store } = withStore(t);
  // The tempting move: everyone does B2B outreach under legitimate interest, so
  // assume it. An assumed basis is a fabricated one.
  const v = checkRow(row({ lawful_basis: undefined, lia_record_id: undefined }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.basis, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(v.basis), 'a missing basis must be one of the three explicit nulls');
  assert.ok(v.reasons.includes('gdpr:basis_not_recorded'));
});

test('GDPR Art. 6 — a basis the regime does not accept is not a basis', (t) => {
  const { store } = withStore(t);
  for (const invented of ['bought_list', 'business_card', 'public_data', 'soft_opt_in']) {
    const v = checkRow(row({ lawful_basis: invented }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `"${invented}" was accepted as a lawful basis`);
    assert.equal(v.basis, NOT_FOUND);
  }
});

test('GDPR Art. 6 — a claimed legitimate interest with no recorded assessment is refused', (t) => {
  const { store } = withStore(t);
  // The balancing test is the thing that makes Art. 6(1)(f) available. Claiming the
  // basis without the record is claiming the conclusion without the work.
  const v = checkRow(row({ lia_record_id: '' }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.basis, NOT_FOUND);
  assert.ok(v.reasons.includes('gdpr:evidence_missing:lia_record_id'));
});

test('GDPR Art. 14 — an undisclosed source is refused', (t) => {
  const { store } = withStore(t);
  // Data not obtained from the subject requires telling them where it came from.
  // A row whose provenance nobody can state cannot carry that notice.
  const v = checkRow(row({ data_source: '   ' }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('gdpr:source_undisclosed'));
});

test('GDPR / PECR — a personal inbox without consent is refused, whatever the row calls it', (t) => {
  const { store } = withStore(t);
  // Legitimate interest does not reach an individual subscriber's personal mailbox.
  // The row is even labelled `address_type: work`; the domain decides, not the label.
  for (const email of ['ada@gmail.com', 'ada@web.de', 'ada@proton.me']) {
    const v = checkRow(row({ email, address_type: 'work' }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `${email} passed as a corporate address`);
    assert.ok(v.reasons.includes('gdpr:personal_inbox_without_consent'));
  }
  // …and consent DOES reach it, so the rule is about the basis, not about the domain.
  const consented = checkRow(row({
    email: 'ada@gmail.com', lawful_basis: 'consent',
    consent_record_id: 'C-1', consent_timestamp: '2026-06-01T00:00:00Z',
  }), { rules: RULES, store, now: NOW });
  assert.equal(consented.verdict, ALLOW, JSON.stringify(consented.reasons));
});

test('GDPR Art. 21 — a recorded objection ends it, regardless of basis', (t) => {
  const { store } = withStore(t);
  const v = checkRow(row({ objection: true }), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('gdpr:objection_recorded'));
});

test('GDPR — no working unsubscribe is a refusal, not a warning', (t) => {
  const { store } = withStore(t);
  for (const val of [undefined, false, 'maybe']) {
    const v = checkRow(row({ unsubscribe_mechanism: val }), { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP);
    assert.ok(v.reasons.includes('gdpr:no_unsubscribe_mechanism'));
  }
});

test('GDPR — a suppressed subject is refused by the real suppression engine', (t) => {
  const { store } = withStore(t, [{ email: 'ada@acme-eu.example', reason: 'unsubscribed' }]);
  const v = checkRow(row(), { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.suppressed, true);
  assert.ok(v.reasons.includes('gdpr:suppressed'));
  // And after erasure downgraded the entry to a hash, they stay suppressed — case
  // and domain-level reach are the engine's, not this skill's.
  const upper = checkRow(row({ email: 'ADA@ACME-EU.EXAMPLE' }), { rules: RULES, store, now: NOW });
  assert.equal(upper.verdict, STOP, 'case must not be an escape hatch');
});

test('GDPR reaches the UK, and reaches a subject the company location would hide', (t) => {
  const { store } = withStore(t);
  // Employer in the US, subject in Ireland. Reading the company HQ instead of the
  // data subject is the single most common way a GDPR row gets missed.
  const v = checkRow(row({ subject_country: 'IE', company_hq_country: 'US' }), { rules: RULES, store, now: NOW });
  // The US employer adds the US federal floor — it does not replace GDPR, and
  // `all_apply` means the Irish subject's regime still has to clear on its own.
  assert.deepEqual(v.jurisdictions, ['can_spam', 'gdpr']);
  assert.equal(v.per_jurisdiction.gdpr.verdict, ALLOW, JSON.stringify(v.reasons));
  const gb = checkRow(row({ subject_country: 'GB' }), { rules: RULES, store, now: NOW });
  assert.deepEqual(gb.jurisdictions, ['gdpr']);
});

test('GDPR — a second regime does not get averaged away; both must clear', (t) => {
  const { store } = withStore(t);
  // German subject, Canadian employer. The row satisfies GDPR completely and has no
  // CASL consent at all. Picking the "primary" jurisdiction here would send it.
  const v = checkRow(row({ company_hq_country: 'CA' }), { rules: RULES, store, now: NOW });
  assert.deepEqual(v.jurisdictions, ['casl', 'gdpr']);
  assert.equal(v.verdict, STOP);
  assert.equal(v.per_jurisdiction.gdpr.verdict, ALLOW);
  assert.equal(v.per_jurisdiction.casl.verdict, STOP);
  assert.equal(v.per_jurisdiction.casl.basis, NOT_FOUND);
});

test('GDPR — the rule set is still wired to the gate table and cites its articles', () => {
  const gdpr = RULES.jurisdictions.gdpr;
  assert.ok(gdpr, 'the gdpr rule set vanished from skills/comply/SKILL.md');
  assert.match(gdpr.citation, /GDPR/);
  assert.match(gdpr.citation, /Art\.?\s*6/);
  for (const fact of ['suppressed', 'objection_recorded', 'source_undisclosed',
                      'personal_inbox_without_consent', 'no_unsubscribe_mechanism']) {
    assert.ok(gdpr.refuse_when.includes(fact), `gdpr stopped refusing on ${fact}`);
  }
});
