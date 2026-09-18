// tests/skills/icp-review/review-rules.test.mjs
//
// Behaviour, not prose. Every case runs an attribute through the `icp-rules` block that
// skills/icp-review/SKILL.md actually ships, so a rule weakened in the skill fails here.
// The adversarial cases are the point: the attribute that looks evidenced and is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadIcpRules, reviewAttribute, reviewIcp, goodAttribute, goodIcp, NULL_ENUM }
  from './rules-harness.mjs';

const rules = loadIcpRules();
const attr = () => structuredClone(goodAttribute());
const icp = () => structuredClone(goodIcp());

test('the rule table loads out of the shipped SKILL.md and is not a default', () => {
  assert.equal(rules.schema_version, 1);
  assert.equal(rules.default_state, 'hypothesis');
  assert.equal(rules.default_verdict, 'insufficient_evidence');
  assert.equal(rules.requires_contrast, true);
  assert.deepEqual(rules.null_enum, NULL_ENUM,
    'the artifact must use the pack\'s one explicit-null enum, not a second convention');
});

test('every reason the harness emits is declared in `refuse_when`', () => {
  const declared = new Set(rules.refuse_when);
  const broken = {
    state: 'probably', proposed_tier: 'tier_zero', proposed_verdict: 'maybe',
    evidence: { provenance: 'a_hunch', sample_definition: '' },
  };
  const seen = reviewAttribute(broken, rules).reasons;
  assert.ok(seen.length >= 6, `expected a broad refusal set, got ${seen.join(', ')}`);
  for (const r of seen) assert.ok(declared.has(r), `harness emitted undeclared reason \`${r}\``);
  // plus the document-level one
  assert.ok(declared.has('not_approved'));
});

test('a fully evidenced attribute is promoted and tiered', () => {
  const r = reviewAttribute(attr(), rules);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.state, 'evidenced');
  assert.equal(r.verdict, 'keep');
  assert.equal(r.tier, 'tier_1');
});

test('each missing evidence field on its own is enough to keep the attribute a hypothesis', () => {
  const cases = {
    sample_definition: 'sample_definition_missing',
    observed_in: 'observed_in_absent',
    sample_size: 'sample_size_absent',
    contrast_observed_in: 'contrast_absent',
    contrast_sample_size: 'contrast_absent',
    provenance: 'provenance_absent',
  };
  for (const [field, reason] of Object.entries(cases)) {
    const a = attr();
    delete a.evidence[field];
    const r = reviewAttribute(a, rules);
    assert.ok(r.reasons.includes(reason),
      `dropping ${field} did not produce ${reason}; got ${r.reasons.join(', ')}`);
    assert.equal(r.state, 'hypothesis', `${field} missing but the attribute was still promoted`);
    assert.equal(r.tier, null, `${field} missing but a tier was still granted`);
    assert.equal(r.verdict, 'insufficient_evidence');
  }
});

test('the whole evidence block missing does not crash and refuses everything', () => {
  const r = reviewAttribute({ name: 'x', actionable_via: 'company_size' }, rules);
  assert.equal(r.state, 'hypothesis');
  assert.equal(r.tier, null);
  for (const reason of ['sample_definition_missing', 'observed_in_absent', 'sample_size_absent',
                        'contrast_absent', 'provenance_absent']) {
    assert.ok(r.reasons.includes(reason), `missing ${reason}`);
  }
});

test('an attribute the model believes is never evidence on its own', () => {
  const a = attr();
  a.evidence.provenance = 'ai_inferred';
  const r = reviewAttribute(a, rules);
  assert.ok(r.reasons.includes('provenance_ai_inferred_only'));
  assert.equal(r.state, 'hypothesis',
    'an ai_inferred observation promoted an attribute — a model agreeing is not a customer buying');
  assert.equal(r.tier, null);
});

test('an unknown provenance is refused rather than treated as verified', () => {
  const a = attr();
  a.evidence.provenance = 'a_workshop';
  assert.ok(reviewAttribute(a, rules).reasons.includes('provenance_unknown'));
});

test('a won-only measurement cannot be tiered — that attribute describes the market', () => {
  const a = attr();
  delete a.evidence.contrast_observed_in;
  delete a.evidence.contrast_sample_size;
  const r = reviewAttribute(a, rules);
  assert.ok(r.reasons.includes('contrast_absent'), r.reasons.join(', '));
  assert.equal(r.tier, null);
  // The tier was asked for and refused, and the refusal says so rather than going quiet.
  assert.ok(r.reasons.includes('tier_requires_evidenced'), r.reasons.join(', '));
});

test('a contrast of zero is a real measurement, not a missing one', () => {
  const a = attr();
  a.evidence.contrast_observed_in = [];
  a.evidence.contrast_sample_size = 14;
  const r = reviewAttribute(a, rules);
  assert.deepEqual(r.reasons, [],
    'an attribute seen in none of the lost accounts is the strongest possible contrast; '
    + 'reading it as "absent" would refuse exactly the best evidence');
  assert.equal(r.tier, 'tier_1');
});

test('zero support in the won sample can only mean refuted — it never means evidenced', () => {
  const a = attr();
  a.evidence.observed_in = [];
  const kept = reviewAttribute(a, rules);
  assert.ok(kept.reasons.includes('observed_in_empty'),
    'an attribute seen in none of the won accounts was promoted; that is the absence of '
    + 'the observation, not weak evidence for it');
  assert.equal(kept.state, 'hypothesis');
  assert.equal(kept.tier, null);

  const b = attr();
  b.evidence.observed_in = [];
  b.state = 'refuted';
  b.proposed_verdict = 'drop';
  delete b.proposed_tier;
  const refuted = reviewAttribute(b, rules);
  assert.deepEqual(refuted.reasons, [],
    'the same zero must be able to REFUTE the attribute, or the review cannot report '
    + 'its most useful finding');
  assert.equal(refuted.state, 'refuted');
  assert.deepEqual(rules.empty_support_states, ['refuted']);
});

test('an evidence field carrying an abolished null convention is refused', () => {
  for (const alias of ['N/A', 'unknown', 'TBD', 'none']) {
    const a = attr();
    a.evidence.sample_definition = alias;
    assert.ok(reviewAttribute(a, rules).reasons.includes('evidence_field_is_null_alias'),
      `${alias} was accepted as a sample definition`);
  }
});

test('the negative tiers need evidence too', () => {
  // Refusing to target a segment on no evidence is as expensive as targeting one on none.
  for (const tier of rules.tiering.tiers) {
    const a = attr();
    a.proposed_tier = tier;
    a.evidence.provenance = 'ai_inferred';
    const r = reviewAttribute(a, rules);
    assert.equal(r.tier, null, `${tier} was granted on an ai_inferred observation`);
    assert.ok(r.reasons.includes('tier_requires_evidenced') || r.reasons.includes('provenance_ai_inferred_only'));
  }
});

test('a hypothesis is still recordable — it is labelled, not deleted', () => {
  assert.equal(rules.tiering.hypothesis_may_be_recorded, true,
    'dropping unevidenced attributes hides the work; they must be recordable as hypotheses');
  const a = attr();
  a.evidence.provenance = 'ai_inferred';
  delete a.proposed_tier;
  const r = reviewAttribute(a, rules);
  assert.equal(r.state, 'hypothesis');
  assert.equal(r.tier, null);
});

test('`refuted` is reachable, and needs the same complete evidence as `evidenced`', () => {
  const a = attr();
  a.state = 'refuted';
  a.proposed_verdict = 'drop';
  delete a.proposed_tier;
  const r = reviewAttribute(a, rules);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.state, 'refuted');
  assert.equal(r.verdict, 'drop', 'a refutation is a finding and must survive the review');

  const b = attr();
  b.state = 'refuted';
  delete b.evidence.sample_size;
  assert.equal(reviewAttribute(b, rules).state, 'hypothesis',
    'refuting an attribute on no evidence is the same error as keeping one on no evidence');
});

test('an attribute must say whether the pack can act on it', () => {
  const a = attr();
  delete a.actionable_via;
  assert.ok(reviewAttribute(a, rules).reasons.includes('actionable_via_absent'));
});

test('`not_applicable` for actionability is a real answer, and keeps the attribute', () => {
  const a = attr();
  a.actionable_via = rules.operability.allowed_null;
  const r = reviewAttribute(a, rules);
  assert.deepEqual(r.reasons, [],
    'a true ICP attribute no endpoint can filter on must be keepable and labelled, '
    + 'or it gets dropped and the gap becomes invisible to whoever builds the list');
  assert.equal(r.tier, 'tier_1');
  assert.equal(rules.operability.allowed_null, 'not_applicable');
  assert.ok(NULL_ENUM.includes(rules.operability.allowed_null));
});

test('an unrecognised state, tier or verdict is refused, not coerced to the nearest one', () => {
  const a = attr();  a.state = 'mostly_evidenced';
  assert.ok(reviewAttribute(a, rules).reasons.includes('unknown_state'));
  const b = attr();  b.proposed_tier = 'tier_3';
  assert.ok(reviewAttribute(b, rules).reasons.includes('unknown_tier'));
  const c = attr();  c.proposed_verdict = 'revisit';
  assert.ok(reviewAttribute(c, rules).reasons.includes('unknown_verdict'));
});

test('the artifact is not writable without explicit approval', () => {
  const d = icp();
  delete d.approved;
  const r = reviewIcp(d, rules);
  assert.equal(r.writable, false);
  assert.deepEqual(r.reasons, ['not_approved']);

  const d2 = icp();
  d2.approved = 'yes';
  assert.equal(reviewIcp(d2, rules).writable, false, 'a string is not an approval');
});

test('an approved artifact is writable and reports each attribute separately', () => {
  const d = icp();
  d.attributes.push((() => { const a = goodAttribute(); a.name = 'runs_inhouse_compliance';
                             a.evidence.provenance = 'ai_inferred'; return a; })());
  const r = reviewIcp(d, rules);
  assert.equal(r.writable, true);
  assert.equal(r.attributes.length, 2);
  assert.equal(r.attributes[0].state, 'evidenced');
  assert.equal(r.attributes[1].state, 'hypothesis',
    'one attribute clearing must not carry the next one over the line');
});

test('the artifact is versioned and names what it supersedes', () => {
  assert.equal(rules.artifact.path, 'gtm/icp.yaml');
  assert.equal(rules.artifact.versioned, true);
  assert.equal(rules.artifact.selector, 'highest_version');
  assert.ok(rules.artifact.supersedes_field,
    'an ICP that changed under downstream readers without naming the version it replaces is a silent change');
});
