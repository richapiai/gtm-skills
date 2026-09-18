// tests/skills/gtm-kickoff/brief-contract.test.mjs
//
// Behaviour, not prose. Every case here runs a candidate brief through the contract
// block that skills/gtm-kickoff/SKILL.md actually ships, so a rule weakened in the
// skill fails here rather than shipping.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadBriefContract, validateBrief, reasonsOf, goodBrief, NULL_ENUM }
  from './brief-harness.mjs';

const contract = loadBriefContract();
const clone = () => structuredClone(goodBrief());

test('the contract loads out of the shipped SKILL.md and is not a default', () => {
  assert.equal(contract.schema_version, 1);
  assert.equal(contract.default_verdict, 'refuse');
  assert.equal(contract.write_requires_explicit_approval, true);
  assert.deepEqual(contract.null_enum, NULL_ENUM,
    'the brief must use the pack\'s one explicit-null enum, not a second convention');
});

test('a complete, approved brief clears', () => {
  const res = validateBrief(clone(), contract);
  assert.ok(res.ok, `expected a clean brief to clear, got ${JSON.stringify(res.refusals)}`);
});

test('every refusal the harness can emit is a reason the contract declares', () => {
  // Guards the other direction: a harness reason absent from `refusal_reasons` means
  // a caller cannot branch on it, and the contract is no longer a full description.
  const declared = new Set(contract.refusal_reasons);
  const broken = {
    approved: false, motion: ['plg', 'sales_led'], icp_hypothesis: 'not_found',
    wedge: 'unknown', demand_reality: 'maybe', channel_hypothesis: 'email',
    constraints: {}, premise_challenges: [{ premise: '' }], open_questions: [],
    evidence: [{ claim: 'x', source: 'a_hunch' }], surprise_field: true,
  };
  const seen = reasonsOf(validateBrief(broken, contract));
  assert.ok(seen.length > 5, `expected a broad refusal set, got ${seen.join(', ')}`);
  for (const r of seen) assert.ok(declared.has(r), `harness emitted undeclared reason \`${r}\``);
});

test('an unapproved brief is refused however complete it is — the artifact is approved, not the idea', () => {
  const b = clone();
  delete b.approved;
  assert.deepEqual(reasonsOf(validateBrief(b, contract)), ['not_approved']);

  const b2 = clone();
  b2.approved = 'yes';                      // a string is not an approval
  assert.deepEqual(reasonsOf(validateBrief(b2, contract)), ['not_approved']);
});

test('a brief whose premise was never challenged is refused — this is the whole point of the skill', () => {
  const b = clone();
  b.premise_challenges = [];
  assert.deepEqual(reasonsOf(validateBrief(b, contract)), ['empty_not_permitted']);

  const b2 = clone();
  delete b2.premise_challenges;
  assert.deepEqual(reasonsOf(validateBrief(b2, contract)), ['missing_field']);
});

test('a challenge the user rejected is still a valid challenge', () => {
  const b = clone();
  b.premise_challenges[0].changed = false;
  b.premise_challenges[0].response = 'Disagreed, kept the original ICP';
  assert.ok(validateBrief(b, contract).ok,
    'a rejected challenge is the row someone reads in three months; it must be recordable');
});

test('a half-written challenge is malformed, not accepted as a gesture', () => {
  const b = clone();
  b.premise_challenges = [{ premise: 'Everyone needs this', challenge: '', response: '', changed: false }];
  const reasons = reasonsOf(validateBrief(b, contract));
  assert.ok(reasons.includes('malformed_premise_challenge'), reasons.join(', '));
  // The blank is also a rejected null alias — an empty string is not an answer.
  assert.ok(reasons.includes('null_alias'), reasons.join(', '));
});

test('required_non_null fields cannot be satisfied by an explicit null', () => {
  for (const field of contract.required_non_null) {
    const b = clone();
    b[field] = NULL_ENUM[0];
    const reasons = reasonsOf(validateBrief(b, contract));
    assert.ok(reasons.includes('null_not_permitted'),
      `${field} accepted an explicit null; got ${reasons.join(', ')}`);
  }
});

test('a field the user could not answer takes an explicit null, and that clears', () => {
  const b = clone();
  b.wedge = NULL_ENUM[0];                   // wedge is required, but not required_non_null
  assert.ok(validateBrief(b, contract).ok,
    'an honest unanswered question must be expressible, or it gets guessed instead');
});

test('the abolished null conventions are refused, using the shipped alias set', () => {
  for (const alias of ['N/A', 'unknown', 'TBD', '-', 'none']) {
    const b = clone();
    b.wedge = alias;
    assert.ok(reasonsOf(validateBrief(b, contract)).includes('null_alias'),
      `${alias} was accepted as an answer`);
  }
});

test('a null alias buried inside a nested value is caught too', () => {
  const b = clone();
  b.constraints = { team: 'two founders', geography: 'TBD' };
  assert.ok(reasonsOf(validateBrief(b, contract)).includes('null_alias'));
});

test('one decision per question — a list of maybes is refused', () => {
  const b = clone();
  b.motion = ['plg', 'sales_led'];
  assert.deepEqual(reasonsOf(validateBrief(b, contract)), ['more_than_one_decision']);
});

test('undecided is still one decision, and the enum provides for it', () => {
  const b = clone();
  b.motion = 'hybrid_unresolved';
  b.demand_reality = 'unresolved';
  assert.ok(validateBrief(b, contract).ok,
    'the enums must let a user say "not decided" without inventing a value');
});

test('a value outside the enum is refused rather than coerced to the nearest one', () => {
  const b = clone();
  b.motion = 'product_led';                 // plausible, and not the shipped label
  assert.deepEqual(reasonsOf(validateBrief(b, contract)), ['not_in_enum']);
});

test('every evidence entry names a source the contract knows', () => {
  const b = clone();
  b.evidence.push({ claim: 'The market is huge', source: 'gut' });
  assert.deepEqual(reasonsOf(validateBrief(b, contract)), ['unknown_evidence_source']);
});

test('`assertion` is a permitted source, and the contract marks it weak rather than banning it', () => {
  const b = clone();
  b.evidence = [{ claim: 'The buyer is the Head of Compliance', source: 'assertion' }];
  assert.ok(validateBrief(b, contract).ok,
    'a labelled belief is the honest state at kickoff; banning it makes authors mislabel');
  assert.ok(contract.weak_evidence_sources.includes('assertion'),
    'assertion must be marked weak so a downstream reader can tell it from a finding');
});

test('an unenumerated field is refused — the contract is the whole surface (default_verdict: refuse)', () => {
  const b = clone();
  b.pipeline_target = 'four million';
  assert.deepEqual(reasonsOf(validateBrief(b, contract)), ['unknown_field']);
});

test('the interview order covers every slot the interview claims to ask', () => {
  for (const slot of contract.interview_order) {
    assert.ok(contract.required.includes(slot), `${slot} is asked but never required`);
  }
});

test('every field a declared reader consumes is a field the brief is required to carry', () => {
  // The readers map is the anti-drift device: renaming a field here breaks the reader.
  for (const [reader, fields] of Object.entries(contract.readers)) {
    for (const f of fields) {
      assert.ok(contract.required.includes(f),
        `${reader} reads \`${f}\`, which the brief is not required to carry`);
    }
  }
});
