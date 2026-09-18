// tests/evals/comply/fail-closed.test.mjs — the spine the other three evals hang on.
//
// GDPR, CCPA and CASL each get a file because each is a rule set. This file tests the
// thing that has no jurisdiction: what happens when the gate cannot answer. Law 5 says
// fail closed, and every unanswerable branch below must land on `stop` plus one of the
// three explicit nulls.
//
// This is the file that goes red if someone "fixes" a noisy gate by defaulting it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeGtmTree } from '../../helpers/index.mjs';
import { ensureSuppressionStore, loadSuppressionStore, SuppressionUnavailableError }
  from '../../../_lib/suppression.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import {
  loadComplyRules, checkRow, screenList, resolveJurisdictions,
  ALLOW, STOP, NULL_ENUM, NOT_FOUND, ComplyRulesUnavailable,
} from '../../skills/comply/harness.mjs';

const RULES = loadComplyRules();
const NOW = new Date('2026-08-28T12:00:00Z');

function withStore (t) {
  const tree = makeGtmTree({ prefix: 'eval-failclosed-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  return { tree, store: loadSuppressionStore({ root: tree.root }) };
}

// A row that would clear anywhere it landed. The ONLY thing wrong with each case
// below is that the gate cannot work out where it landed.
const OTHERWISE_PERFECT = Object.freeze({
  email: 'sam@nowhere.example',
  lawful_basis: 'consent',
  consent_kind: 'express',
  consent_record_id: 'C-7',
  consent_timestamp: '2026-07-01T00:00:00Z',
  lia_record_id: 'LIA-7',
  data_source: 'inbound demo request',
  notice_at_collection: true,
  unsubscribe_mechanism: true,
});

test('an unresolvable jurisdiction is a refusal, not a default', (t) => {
  const { store } = withStore(t);
  const cases = [
    {},                                    // nothing to go on
    { subject_country: '' },               // an empty column
    { subject_country: 'XX' },             // a code nobody issued
    { subject_country: 'ZZ', company_hq_country: 'QQ', phone_country: 'YY' },
    { email: 'sam@nowhere.internal' },     // a TLD the table does not map
  ];
  for (const over of cases) {
    const v = checkRow({ ...OTHERWISE_PERFECT, ...over }, { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `${JSON.stringify(over)} was cleared with no jurisdiction`);
    assert.equal(v.jurisdiction, NOT_FOUND);
    assert.ok(NULL_ENUM.includes(v.jurisdiction), 'the unknown answer must be an explicit null');
    assert.equal(v.basis, NOT_FOUND);
    assert.deepEqual(v.jurisdictions, []);
    assert.ok(v.reasons.includes('unknown_jurisdiction'));
  }
});

test('a jurisdiction with no rule set is refused — silence is not permission', (t) => {
  const { store } = withStore(t);
  // The operator knows exactly where these people are. The pack has no rule set for
  // it. "We wrote no rules for this place" is not a finding that the place has none,
  // and this is the branch where failing open would be easiest to justify.
  for (const declared of ['lgpd', 'pipeda', 'pecr', 'appi']) {
    const v = checkRow({ ...OTHERWISE_PERFECT, jurisdiction: declared }, { rules: RULES, store, now: NOW });
    assert.equal(v.verdict, STOP, `declared "${declared}" was cleared with no rule set`);
    assert.equal(v.jurisdiction, NOT_FOUND);
    assert.ok(v.reasons.includes(`no_rule_set:${declared}`));
  }
  // A declared regime the pack DOES cover resolves normally, so the refusal above is
  // about the missing rule set and not about the field being present.
  const known = checkRow({ ...OTHERWISE_PERFECT, jurisdiction: 'gdpr' }, { rules: RULES, store, now: NOW });
  assert.deepEqual(known.jurisdictions, ['gdpr']);
  assert.equal(known.verdict, ALLOW, JSON.stringify(known.reasons));
});

test('the gate cannot run at all without the suppression store', (t) => {
  const tree = makeGtmTree({ prefix: 'eval-nostore-' });
  t.after(() => tree.cleanup());
  // No `setup` has run. The tempting reading is "no store, so nobody is suppressed".
  assert.throws(() => screenList([{ ...OTHERWISE_PERFECT, subject_country: 'DE' }], { root: tree.root, rules: RULES }),
    (e) => e instanceof SuppressionUnavailableError);
  // And the row-level gate refuses to be called without one, so there is no path
  // that quietly skips the check.
  assert.throws(() => checkRow(OTHERWISE_PERFECT, { rules: RULES, store: null }),
    (e) => e instanceof SuppressionUnavailableError);
});

test('the gate cannot run without its rule table', () => {
  assert.throws(() => loadComplyRules({ path: '/nonexistent/SKILL.md' }),
    (e) => e instanceof ComplyRulesUnavailable);
  assert.throws(() => checkRow(OTHERWISE_PERFECT, { rules: null, store: null }),
    (e) => e instanceof ComplyRulesUnavailable);
});

test('the table itself declares the fail-closed defaults', () => {
  assert.equal(RULES.default_verdict, STOP, 'the default verdict must be stop (law 5)');
  assert.equal(RULES.no_rule_set_verdict, STOP);
  assert.equal(RULES.detection.unresolved_verdict, STOP);
  assert.ok(NULL_ENUM.includes(RULES.detection.unresolved_jurisdiction));
  assert.equal(RULES.detection.on_conflict, 'all_apply',
    'a conflict must not be resolved by choosing which law to ignore');
});

test('the rule sets in the skill are exactly the ones gates.yaml names', () => {
  // A rule set added to the skill but not to gates.yaml, or a gate-listed regime with
  // no rule set, is a silent gap in coverage. Bind them.
  const declared = gateValue(loadGates(), 'skills.comply.jurisdictions');
  assert.deepEqual([...declared].sort(), Object.keys(RULES.jurisdictions).sort());
});

test('every regime the detector can name has a rule set behind it', () => {
  const known = new Set(Object.keys(RULES.jurisdictions));
  const det = RULES.detection;
  for (const source of [det.countries, det.tlds]) {
    for (const regime of Object.keys(source || {})) {
      assert.ok(known.has(regime), `detection names "${regime}", which has no rule set`);
    }
  }
  for (const regime of Object.values(det.subdivisions || {})) {
    assert.ok(known.has(regime), `subdivision maps to "${regime}", which has no rule set`);
  }
});

test('detection reads the data subject, and the subject alone cannot be overridden away', () => {
  // A German subject stays a German subject however the account is filed.
  const v = resolveJurisdictions({ subject_country: 'DE', company_hq_country: 'US', email: 'x@y.com' }, RULES);
  assert.ok(v.jurisdictions.includes('gdpr'));
  assert.equal(v.signals.gdpr, 'subject_country');
  // And a subdivision beats the country it sits in.
  const cal = resolveJurisdictions({ subject_region: 'US-CA', subject_country: 'US' }, RULES);
  assert.deepEqual(cal.jurisdictions, ['can_spam', 'ccpa']);
  assert.equal(cal.signals.ccpa, 'subject_region');
});

test('every refusal condition the table names is a fact the harness can compute', (t) => {
  const { store } = withStore(t);
  // A typo'd fact name would otherwise be a refusal condition that never fires — a
  // gate deleted by spelling. checkRow reports those as `fact_uncomputable:` and
  // still refuses, so this asserts none of them exist today.
  const probe = checkRow({ ...OTHERWISE_PERFECT, subject_country: 'DE' }, { rules: RULES, store, now: NOW });
  const all = [
    ...Object.values(RULES.jurisdictions).flatMap(j => j.refuse_when || []),
  ];
  assert.ok(all.length > 0);
  for (const per of Object.values(probe.per_jurisdiction)) {
    for (const r of per.reasons) {
      assert.ok(!r.startsWith('fact_uncomputable:'), `${r} — the table names a fact nothing computes`);
    }
  }
  // And prove the guard is live by asking for a fact that does not exist.
  const broken = structuredClone(RULES);
  broken.jurisdictions.gdpr.refuse_when = ['a_fact_nobody_computes'];
  const v = checkRow({ ...OTHERWISE_PERFECT, subject_country: 'DE' }, { rules: broken, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.ok(v.reasons.includes('gdpr:fact_uncomputable:a_fact_nobody_computes'));
});
