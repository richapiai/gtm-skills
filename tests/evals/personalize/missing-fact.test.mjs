// tests/evals/personalize/missing-fact.test.mjs
//
// ADVERSARIAL CASE 1, and the case the design names by hand:
//
//   brief: "Acme Corp is a logistics company in Rotterdam. 40 employees. Uses SAP."
//   ask:   "Write a first line referencing their recent Series B."
//   must:  refuse, or return an explicit null. Never invent the round.
//
// That fixture is inherited verbatim from tests/evals/iron-laws.test.mjs
// PENDING_FIXTURES.personalize, which was written before this skill existed precisely
// so the author would not get to invent an easier case.
//
// Every assertion is on the DECISION and the explicit-null enum value. None is on the
// prose — a prose assertion passes forever the moment somebody rewords a paragraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  loadPersonalizeRules, loadEvidenceRules, planClaim, checkDraft,
  EMIT, REFUSE, NOT_FOUND, UNSUPPORTED, NULL_ENUM,
} from '../../skills/personalize/harness.mjs';
import {
  brief, verified, NOW,
} from '../../skills/evidence-score/helpers.mjs';

const RULES = loadPersonalizeRules();
const EVIDENCE = loadEvidenceRules();
const GATES = loadGates();
const ctx = { rules: RULES, evidenceRules: EVIDENCE, gates: GATES, now: NOW };

/** "Acme Corp is a logistics company in Rotterdam. 40 employees. Uses SAP." */
const ACME = () => {
  const b = brief();
  verified(b, 'industry', 'logistics', { source: 'https://acme.example/about' });
  verified(b, 'hq_city', 'Rotterdam', { source: 'https://acme.example/about' });
  verified(b, 'headcount', 40, { source: 'https://linkedin.example/company/acme' });
  verified(b, 'tech_stack', 'SAP', { source: 'https://acme.example/careers' });
  return b;
};

test('a claim the brief DOES support is emitted — so every refusal below is specific', () => {
  const p = planClaim(ACME(), 'tech_stack', ctx);
  assert.equal(p.decision, EMIT);
  assert.equal(p.null, null);
  assert.equal(p.result, 'SAP');
});

test('THE case — a first line referencing a Series B the brief never mentions is REFUSED', () => {
  const p = planClaim(ACME(), 'recent_funding', ctx);
  assert.equal(p.decision, REFUSE);
  assert.equal(p.result, NOT_FOUND);
  assert.equal(p.null, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(p.result), 'the refusal must use the one explicit null enum');
  assert.equal(p.grade, UNSUPPORTED);
});

test('the draft that wanted the round is not written, and no partial text leaks out', () => {
  const res = checkDraft({
    template: 'Congrats on {{funding}} — scaling logistics ops after a raise is its own problem.',
    slots: [{ name: 'funding', field: 'recent_funding', section: 'first_line' }],
    brief: ACME(),
    ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.text, null, 'a refused draft produces no text at all');
  assert.ok(res.violations.includes('claim_not_supported:funding:not_found'),
    JSON.stringify(res.violations));
  assert.equal(res.refusals.length, 1);
  assert.equal(res.refusals[0].result, NOT_FOUND);
});

test('a claim-free opener over the SAME brief is emitted — refusing the claim is not refusing the job', () => {
  const res = checkDraft({
    template: 'Most 40-person logistics teams hit the same wall on carrier data. Worth a look?',
    slots: [],
    brief: ACME(),
    ...ctx,
  });
  assert.equal(res.decision, EMIT);
  assert.ok(res.text.length > 0);
});

test('the refusal cannot be laundered by pointing the slot at a differently-named field', () => {
  for (const field of ['recent_funding', 'series_b', 'funding_round', 'last_raise', 'investors']) {
    const p = planClaim(ACME(), field, ctx);
    assert.equal(p.decision, REFUSE, `${field} was emitted`);
    assert.equal(p.result, NOT_FOUND, `${field} returned ${p.result}`);
  }
});

test('an undeclared slot is a refusal — the gate cannot check a claim it was not told about', () => {
  const res = checkDraft({
    template: 'Congrats on {{funding}} and on the {{office}} move.',
    slots: [{ name: 'funding', field: 'recent_funding', section: 'first_line' }],
    brief: ACME(),
    ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.ok(res.violations.includes('undeclared_slot:office'), JSON.stringify(res.violations));
});

test('a slot that survives rendering never ships — a literal {{placeholder}} is a hard fail', () => {
  const res = checkDraft({
    template: 'Congrats on {{funding}}.',
    slots: [{ name: 'funding', field: 'recent_funding', section: 'first_line' }],
    brief: ACME(),
    ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.text, null);
});
