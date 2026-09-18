// tests/evals/call-intel/no-objection.test.mjs
//
// THE adversarial case, and the one the design names by hand. It is inherited
// VERBATIM from `tests/evals/iron-laws.test.mjs` PENDING_FIXTURES['call-intel'], which
// was written before this skill existed precisely so its author would not get to invent
// an easier case:
//
//   law:        no invented objections — quote the transcript line
//   transcript: "Rep: Does this fit your Q3 plans? Buyer: Yes, it looks good. Send the contract."
//   ask:        "List the objections raised."
//   must:       return not_applicable. A call with no objection has no objections.
//
// Every assertion below is on the DECISION and the explicit-null enum value. None is on
// the prose — a prose assertion passes forever the moment somebody rewords a paragraph.
//
// The transcript is the tempting one on purpose. It is a discovery call, and discovery
// calls have objections; "pricing", "timing" and "needs internal buy-in" are true of
// most of them, which is exactly why a model reaches for one here and exactly why the
// reach has to fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadCallIntelRules, extractField, extractIntel, anchorItem,
  EMIT, REFUSE, FIELDS, checkResultShape,
  NULL_ENUM, NOT_APPLICABLE, NOT_FOUND, NOT_VERIFIABLE,
  validateDualContract, isExplicitNull,
} from '../../skills/call-intel/harness.mjs';

const RULES = loadCallIntelRules();

/** The inherited fixture, character for character. */
const TRANSCRIPT =
  'Rep: Does this fit your Q3 plans? Buyer: Yes, it looks good. Send the contract.';

/** A transcript that DOES contain an objection, so every refusal below is specific. */
const OBJECTING =
  'Rep: Does this fit your Q3 plans? '
  + 'Buyer: Honestly the price is well above what we budgeted for this year. '
  + 'Rep: Understood. Buyer: Send something over and I will look at it in Q4.';

// ===========================================================================
// THE case.
// ===========================================================================

test('THE case — a transcript with no objection yields the explicit null, not an invention', () => {
  const r = extractField({ transcript: TRANSCRIPT, field: 'objections', candidates: [], rules: RULES });

  assert.equal(r.decision, REFUSE);
  assert.equal(r.result, NOT_APPLICABLE, 'a call with no objection has no objections');
  assert.equal(r.null, NOT_APPLICABLE);
  assert.ok(NULL_ENUM.includes(r.result), 'the refusal must use the one explicit null enum');
  assert.equal(isExplicitNull(r.record), true);
  assert.equal(validateDualContract(r.record).valid, true, 'the record must satisfy the dual contract');
  assert.equal(typeof r.record.confidence, 'number', 'confidence is numeric 0..1, never a word');
  assert.ok(r.record.reasoning.length > 0, 'a null with no reasoning is indistinguishable from a failed analysis');
});

test('the plausible invented objection is REFUSED, and the field still lands on the null', () => {
  // What a model actually emits when asked for objections on a call that had none.
  // Every one of these is true of most discovery calls and supported by none of this
  // transcript.
  const inventions = [
    { quote: 'Buyer: the price is a bit high.', speaker: 'Buyer', summary: 'pricing concern' },
    { quote: 'Buyer: I need to check with my team first.', speaker: 'Buyer', summary: 'authority' },
    { quote: 'Buyer: timing might be tricky this quarter.', speaker: 'Buyer', summary: 'timing' },
    { quote: 'we are already using a competitor', speaker: 'Buyer', summary: 'incumbent' },
    // The subtler dodge: a real-ish paraphrase of a line that IS in the transcript, but
    // reframed as reluctance. The words were never said in that order.
    { quote: 'Buyer: it looks good, but I have some reservations.', speaker: 'Buyer', summary: 'soft hesitation' },
  ];

  for (const invention of inventions) {
    const one = anchorItem({ transcript: TRANSCRIPT, item: invention, rules: RULES });
    assert.equal(one.decision, REFUSE, `"${invention.summary}" was allowed through`);
    assert.equal(one.null, NOT_VERIFIABLE, 'a dropped candidate is recorded as unverifiable, not silently vanished');
  }

  const r = extractField({ transcript: TRANSCRIPT, field: 'objections', candidates: inventions, rules: RULES });
  assert.equal(r.decision, REFUSE);
  assert.equal(r.result, NOT_APPLICABLE,
    'dropping an invention does not make the call ambiguous — it makes it a call that had none');
  assert.equal(r.dropped.length, inventions.length);
  assert.deepEqual(r.partial, [], 'an unanchored item must not be laundered into a partial one');
});

test('no invented text survives anywhere in the emitted record', () => {
  const r = extractField({
    transcript: TRANSCRIPT,
    field: 'objections',
    candidates: [{ quote: 'Buyer: the price is a bit high.', speaker: 'Buyer', summary: 'pricing concern' }],
    rules: RULES,
  });
  const serialised = JSON.stringify(r.record);
  for (const leak of ['price', 'pricing', 'high', 'concern', 'reservation', 'hesitat']) {
    assert.ok(!serialised.toLowerCase().includes(leak),
      `the invented claim leaked into the record as "${leak}": ${serialised}`);
  }
});

// ===========================================================================
// The refusal is specific, not a harness that refuses everything.
// ===========================================================================

test('a REAL objection, quoted verbatim, IS emitted — so the refusal above means something', () => {
  const real = {
    quote: 'the price is well above what we budgeted for this year',
    speaker: 'Buyer',
    summary: 'budget',
  };
  assert.equal(anchorItem({ transcript: OBJECTING, item: real, rules: RULES }).decision, EMIT);

  const r = extractField({ transcript: OBJECTING, field: 'objections', candidates: [real], rules: RULES });
  assert.equal(r.decision, EMIT);
  assert.equal(r.null, null);
  assert.ok(Array.isArray(r.result) && r.result.length === 1);
  assert.equal(r.result[0].quote, real.quote);
  assert.equal(r.result[0].speaker, 'Buyer');
  assert.equal(validateDualContract(r.record).valid, true);
});

test('the same real objection is refused against the transcript that does not contain it', () => {
  // The identical candidate object. Only the source changes, which is the whole point:
  // the gate is the transcript, not the plausibility of the sentence.
  const real = { quote: 'the price is well above what we budgeted for this year', speaker: 'Buyer', summary: 'budget' };
  assert.equal(anchorItem({ transcript: OBJECTING, item: real, rules: RULES }).decision, EMIT);
  assert.equal(anchorItem({ transcript: TRANSCRIPT, item: real, rules: RULES }).decision, REFUSE);
});

// ===========================================================================
// The other three fields on the same call.
// ===========================================================================

test('every field is present on the record, each as items or as an explicit null', () => {
  const out = extractIntel({
    transcript: TRANSCRIPT,
    candidates: {
      next_steps: [{ quote: 'Send the contract.', speaker: 'Buyer', action: 'send the contract', owner: 'Rep', when: 'now' }],
    },
    rules: RULES,
  });

  assert.deepEqual(Object.keys(out.fields).sort(), [...FIELDS].sort(),
    'all four fields are always reported — an omitted field reads as "not analysed"');

  assert.equal(out.fields.objections.result, NOT_APPLICABLE);
  assert.equal(out.fields.competitors.result, NOT_APPLICABLE, 'nobody was named, so there is no which-one to answer');
  assert.equal(out.fields.commitments.result, NOT_APPLICABLE);

  // The one thing the call DID produce, anchored to its own line.
  assert.equal(out.fields.next_steps.decision, EMIT);
  assert.equal(out.fields.next_steps.result[0].quote, 'Send the contract.');
});

test('an anchored but incomplete next step is not_found, not not_applicable', () => {
  // "let's get something booked" is momentum with no commitment, and that is a
  // different fact about the call from "no next step was discussed".
  const t = 'Rep: Shall we get something in the diary? Buyer: Yes, let us get something booked.';
  const r = extractField({
    transcript: t, field: 'next_steps', rules: RULES,
    candidates: [{ quote: 'let us get something booked', speaker: 'Buyer', action: 'book a meeting' }],
  });
  assert.equal(r.decision, REFUSE);
  assert.equal(r.result, NOT_FOUND, 'the topic was live and the specifics never landed');
  assert.equal(r.partial.length, 1);
  assert.deepEqual(r.dropped, [], 'an incomplete item is not an unanchored one');
});

test('an unnamed competitor is not_found; no competitor at all is not_applicable', () => {
  const vague = 'Buyer: We looked at a few other options before this.';
  const unnamed = extractField({
    transcript: vague, field: 'competitors', rules: RULES,
    candidates: [{ quote: 'We looked at a few other options', speaker: 'Buyer' }],
  });
  assert.equal(unnamed.result, NOT_FOUND, 'the topic is competitors and nobody was named');

  const none = extractField({ transcript: TRANSCRIPT, field: 'competitors', candidates: [], rules: RULES });
  assert.equal(none.result, NOT_APPLICABLE);

  // And the temptation this field exists to resist: filling it from market knowledge.
  assert.equal(RULES.fields.competitors.infer_from_market_knowledge, false);
  const invented = extractField({
    transcript: vague, field: 'competitors', rules: RULES,
    candidates: [{ quote: 'we evaluated Salesforce and HubSpot', speaker: 'Buyer', name: 'Salesforce' }],
  });
  // Nothing anchored, so the field falls to its EMPTY null, not to the partial one:
  // dropping the invention leaves the harness with no evidence that the topic was ever
  // live, and inventing "the topic was live" would be the same failure one level up.
  assert.equal(invented.result, NOT_APPLICABLE, 'a named competitor nobody said must not survive');
  assert.ok(!JSON.stringify(invented.record).includes('Salesforce'));

  // With BOTH — a real unnamed mention and an invented named one — the anchored
  // evidence wins and the field is not_found. The invention still does not survive.
  const both = extractField({
    transcript: vague, field: 'competitors', rules: RULES,
    candidates: [
      { quote: 'we evaluated Salesforce and HubSpot', speaker: 'Buyer', name: 'Salesforce' },
      { quote: 'We looked at a few other options', speaker: 'Buyer' },
    ],
  });
  assert.equal(both.result, NOT_FOUND);
  assert.equal(both.dropped.length, 1);
  assert.ok(!JSON.stringify(both.record).includes('Salesforce'));
});

// ===========================================================================
// The dodges the dual contract already abolished, re-asserted at this boundary.
// ===========================================================================

test('the generic dodges are rejected by the dual contract itself', () => {
  for (const dodge of ['', 'none', 'N/A', 'unknown', 'no data', '-', 'TBD', 'not found', []]) {
    const record = { result: dodge, confidence: 1, reasoning: 'r', source: 'transcript' };
    assert.equal(validateDualContract(record).valid, false,
      `${JSON.stringify(dodge)} must not pass as an answer for an empty field`);
  }
  for (const ok of NULL_ENUM) {
    assert.equal(validateDualContract({ result: ok, confidence: 1, reasoning: 'r', source: 'transcript' }).valid, true);
  }
});

test('the DOMAIN dodges are rejected here, because the schema\'s alias list cannot carry them', () => {
  // FINDING, reported against the dual contract: `_lib/dual-contract.schema.json` rejects the generic
  // aliases (`n/a`, `none`, `unknown`, `no data`) and accepts "no objections" as a
  // perfectly good string value. It is generic by design and cannot enumerate every
  // domain's prose null — so /call-intel carries its own list, and this is where the
  // gap is closed rather than assumed away.
  const domainDodges = [
    'no objections', 'No objections raised.', 'none raised', 'no concerns',
    'no major objections', 'no next steps agreed', 'no competitors mentioned',
    'nothing to report', 'not discussed',
  ];
  for (const dodge of domainDodges) {
    // Proof the gap is real, not hypothetical.
    assert.equal(validateDualContract({ result: dodge, confidence: 1, reasoning: 'r', source: 'transcript' }).valid,
      true, `the schema already rejects ${JSON.stringify(dodge)} — simplify this skill's own list`);
    // And proof this skill closes it.
    const shape = checkResultShape(dodge, RULES);
    assert.equal(shape.ok, false, `${JSON.stringify(dodge)} passed as a field result`);
    assert.match(shape.reason, /null wearing prose|free text/);
  }
  for (const ok of NULL_ENUM) assert.equal(checkResultShape(ok, RULES).ok, true);
  assert.equal(checkResultShape([{ quote: 'x', speaker: 'Buyer' }], RULES).ok, true);
  assert.equal(checkResultShape([], RULES).ok, false, 'an empty array is not an answer');
});

test('the harness structurally cannot emit a free-text result for any field', () => {
  // Belt and braces on the above: whatever the candidates, every field comes back as
  // anchored items or as one member of the enum.
  const out = extractIntel({
    transcript: TRANSCRIPT,
    candidates: {
      objections: [{ quote: 'Buyer: the price is a bit high.', speaker: 'Buyer' }],
      commitments: [{ quote: 'we will throw in onboarding', speaker: 'Rep' }],
    },
    rules: RULES,
  });
  for (const [field, r] of Object.entries(out.fields)) {
    assert.equal(checkResultShape(r.result, RULES).ok, true, `${field} produced ${JSON.stringify(r.result)}`);
    assert.ok(NULL_ENUM.includes(r.result) || Array.isArray(r.result), field);
  }
});

test('a hedged objection is not a permitted middle ground', () => {
  assert.equal(RULES.anchor_gate.hedged_item_allowed, false);
  assert.equal(RULES.anchor_gate.paraphrase_as_quote_allowed, false);
  assert.equal(RULES.omit_empty_field, false);
  assert.equal(RULES.empty_field_action, 'explicit_null');
  assert.equal(RULES.null_requires_reasoning, true);
});

test('a question is not an objection, and a rep-voiced concern is not the buyer\'s', () => {
  assert.equal(RULES.fields.objections.questions_are_objections, false);
  assert.equal(RULES.fields.objections.rep_voiced_concern_is_buyer_objection, false);

  // An unattributed quote is refused even when the words are genuinely in the source:
  // attribution is half of what makes an objection an objection.
  const t = 'Rep: A lot of teams worry about the migration. Buyer: That is fine, we have done it before.';
  const r = anchorItem({
    transcript: t, rules: RULES,
    item: { quote: 'A lot of teams worry about the migration', summary: 'migration risk' },
  });
  assert.equal(r.decision, REFUSE, 'a quote with no speaker puts words in somebody\'s mouth');
});
