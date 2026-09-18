// tests/evals/evidence-score/missing-fact.test.mjs
//
// ADVERSARIAL CASE 1, named in the design: *a research brief missing the fact
// the copy wants to claim.*
//
// Same contract as tests/evals/iron-laws.test.mjs: assert the REFUSAL or the explicit-
// null enum value, never the prose around it. A prose assertion passes forever the
// moment somebody rewords the paragraph above the rule; these fail the moment the rule
// stops firing.
//
// The table under test is the ```yaml evidence-rules block inside
// skills/evidence-score/SKILL.md. The harness only runs it.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates } from '../../../_lib/gates.mjs';
import {
  loadEvidenceRules, gradeClaim, scoreRecord,
  SUPPORTED, UNSUPPORTED, NOT_FOUND, NULL_ENUM,
} from '../../skills/evidence-score/harness.mjs';
import {
  brief, verified, NOW,
} from '../../skills/evidence-score/helpers.mjs';

const RULES = loadEvidenceRules();
const GATES = loadGates();

// The fixture the pack already wrote down, inherited verbatim from
// tests/evals/iron-laws.test.mjs PENDING_FIXTURES.personalize. The brief describes a
// logistics company. It says nothing whatsoever about funding.
const ACME_BRIEF = () => {
  const b = brief();
  verified(b, 'industry', 'logistics', { source: 'https://acme.example/about' });
  verified(b, 'hq_city', 'Rotterdam', { source: 'https://acme.example/about' });
  verified(b, 'headcount', 40, { source: 'https://linkedin.example/company/acme' });
  verified(b, 'tech_stack', ['SAP'], { source: 'https://acme.example/careers' });
  return b;
};

test('the fact the brief DOES carry grades supported — so every refusal below is specific', () => {
  const g = gradeClaim(ACME_BRIEF(), 'industry', { rules: RULES, gates: GATES, now: NOW });
  assert.equal(g.grade, SUPPORTED);
  assert.equal(g.null, null);
  assert.equal(g.assertable, true);
});

test('a fact the brief never mentions grades unsupported and returns not_found', () => {
  // The tempting move: the company is 40 people in logistics and everybody has raised
  // something, so infer a round. An inferred round is a fabricated one.
  const g = gradeClaim(ACME_BRIEF(), 'recent_funding', { rules: RULES, gates: GATES, now: NOW });

  assert.equal(g.grade, UNSUPPORTED);
  assert.equal(g.null, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(g.null), 'the refusal must use the one explicit null enum');
  assert.equal(g.assertable, false);
  assert.deepEqual(g.reasons, ['field_absent']);
});

test('an absent field is absent however the question is spelled', () => {
  const b = ACME_BRIEF();
  for (const field of ['recent_funding', 'series_b', 'funding_round', 'last_raise', 'investors']) {
    const g = gradeClaim(b, field, { rules: RULES, gates: GATES, now: NOW });
    assert.equal(g.grade, UNSUPPORTED, `${field} was graded ${g.grade}`);
    assert.equal(g.null, NOT_FOUND, `${field} returned ${g.null}`);
  }
});

test('a dimension with no supported signal scores zero and reports not_found — it is never guessed', () => {
  // ACME_BRIEF carries no timing signal of any kind. The dimension must be zero and
  // MARKED unmeasured, not scored down to a plausible-looking small number.
  const res = scoreRecord(ACME_BRIEF(), { rules: RULES, gates: GATES, now: NOW });
  const timing = res.dimensions.timing;
  assert.equal(timing.score, 0);
  assert.equal(timing.measured, false);
  assert.equal(timing.null, NOT_FOUND);
  assert.equal(timing.why, null, 'an unmeasured dimension has no evidence pointer to show');
});

test('a total built on too few measured dimensions is REFUSED, not reported as a low score', () => {
  // Reporting this as a number would sort the record as "measured and bad" rather than
  // "not measured", which is the same lie in a different column.
  const res = scoreRecord(ACME_BRIEF(), { rules: RULES, gates: GATES, now: NOW });
  assert.equal(res.total, null);
  assert.equal(res.total_status, 'refused');
  assert.equal(res.band, null);
  assert.deepEqual(res.reasons, ['too_few_dimensions_measured']);
});

test('an empty brief refuses every claim — there is no floor of free assertions', () => {
  const empty = brief();
  for (const field of ['industry', 'recent_funding', 'seniority_band', 'email_status']) {
    const g = gradeClaim(empty, field, { rules: RULES, gates: GATES, now: NOW });
    assert.equal(g.null, NOT_FOUND);
    assert.equal(g.assertable, false);
  }
});
