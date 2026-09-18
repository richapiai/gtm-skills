// tests/skills/personalize/pre-emit.test.mjs
//
// The gate that runs on the RENDERED text, after interpolation and before anything is
// written or shown. The evals cover the four adversarial claim cases; this file covers
// the mechanical failures that let a bad draft out even when every claim was fine:
// a banned phrase, an unresolved placeholder, a claim budget blown, and a draft
// written for a contact nobody screened against suppression.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { loadGates } from '../../../_lib/gates.mjs';
import { makeGtmTree } from '../../helpers/index.mjs';
import {
  ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore,
} from '../../../_lib/suppression.mjs';
import {
  loadPersonalizeRules, loadEvidenceRules, checkDraft, bannedPhraseHits,
  templateSlots, renderDraft, EMIT, REFUSE, SuppressionUnavailableError,
} from './harness.mjs';
import { brief, verified, NOW } from './helpers.mjs';

const RULES = loadPersonalizeRules();
const EVIDENCE = loadEvidenceRules();
const GATES = loadGates();
const ctx = { rules: RULES, evidenceRules: EVIDENCE, gates: GATES, now: NOW };

function supported () {
  const b = brief();
  verified(b, 'tech_stack', 'SAP', { source: 'https://acme.example/careers' });
  verified(b, 'hq_city', 'Rotterdam', { source: 'https://acme.example/about' });
  return b;
}

const OK_DRAFT = {
  template: 'Running {{stack}} across a logistics network is its own kind of pain. Worth ten minutes?',
  slots: [{ name: 'stack', field: 'tech_stack', section: 'first_line' }],
};

test('a clean draft over a supported claim is emitted, and the text is rendered', () => {
  const res = checkDraft({ ...OK_DRAFT, brief: supported(), ...ctx });
  assert.equal(res.decision, EMIT, JSON.stringify(res.violations));
  assert.match(res.text, /Running SAP across/);
  assert.equal(templateSlots(res.text).length, 0);
});

test('a banned phrase hard-fails the draft even when every claim is supported', () => {
  const res = checkDraft({
    template: 'I hope you\'re doing well! Running {{stack}} at scale is hard.',
    slots: OK_DRAFT.slots, brief: supported(), ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.text, null);
  assert.ok(res.violations.some(v => v.startsWith('banned_phrase:')), JSON.stringify(res.violations));
});

test('every phrase in the shipped list is actually detected', () => {
  for (const phrase of RULES.banned_phrases) {
    const hits = bannedPhraseHits(`Hi there. ${phrase}. Anyway, here is the thing.`, RULES);
    assert.ok(hits.includes(phrase), `"${phrase}" is in the list but does not fire`);
  }
});

test('detection survives the ways copy actually gets typed', () => {
  const variants = [
    'I Hope You’re Doing Well',      // curly apostrophe and title case
    'i  hope   you are   doing well',      // collapsed whitespace
    'PICK YOUR BRAIN',
    'Just  following   up on this',
  ];
  for (const v of variants) {
    assert.ok(bannedPhraseHits(`Hi. ${v}. Cheers.`, RULES).length > 0, `missed: ${v}`);
  }
});

test('ordinary copy is not flagged — a banned list that fires on everything gets switched off', () => {
  const clean = 'Rotterdam to Felixstowe on SAP with three carriers is a reconciliation problem. '
    + 'We cut that to one screen for two other 3PLs. Ten minutes on Thursday?';
  assert.deepEqual(bannedPhraseHits(clean, RULES), []);
});

test('an unresolved placeholder never ships', () => {
  const res = checkDraft({
    template: 'Running {{stack}} in {{unknown_thing}}.',
    slots: [
      { name: 'stack', field: 'tech_stack', section: 'first_line' },
      { name: 'unknown_thing', field: 'not_in_the_brief', section: 'body' },
    ],
    brief: supported(), ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.text, null);
  assert.ok(res.violations.some(v => v.startsWith('unresolved_slot:')), JSON.stringify(res.violations));
});

test('renderDraft leaves an unknown slot intact so the gate can see it', () => {
  assert.equal(renderDraft('a {{x}} b {{y}}', { x: '1' }), 'a 1 b {{y}}');
});

test('the claim budget is enforced per section', () => {
  const b = supported();
  const res = checkDraft({
    template: 'Running {{stack}} out of {{city}} — two things at once.',
    slots: [
      { name: 'stack', field: 'tech_stack', section: 'first_line' },
      { name: 'city', field: 'hq_city', section: 'first_line' },
    ],
    brief: b, ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.ok(res.violations.includes('claim_budget_exceeded:first_line'), JSON.stringify(res.violations));

  // The same two claims, one per section, are within budget.
  const ok = checkDraft({
    template: 'Running {{stack}} at that size is hard.\n\nAlso: {{city}} is a brutal lane right now.',
    slots: [
      { name: 'stack', field: 'tech_stack', section: 'first_line' },
      { name: 'city', field: 'hq_city', section: 'body' },
    ],
    brief: b, ...ctx,
  });
  assert.equal(ok.decision, EMIT, JSON.stringify(ok.violations));
});

test('a section with no budget entry is a refusal, not an unlimited one', () => {
  const res = checkDraft({
    template: 'PS: {{stack}}.',
    slots: [{ name: 'stack', field: 'tech_stack', section: 'postscript' }],
    brief: supported(), ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.ok(res.violations.includes('claim_budget_undefined:postscript'));
});

test('a contact with no readable suppression store throws — a draft is not written blind', (t) => {
  assert.throws(
    () => checkDraft({ ...OK_DRAFT, brief: supported(), contact: { email: 'a@x.example' }, ...ctx }),
    (e) => e instanceof SuppressionUnavailableError,
    'a check we could not run is not a passing check (law 5)');
});

test('a suppressed contact gets no draft, and the refusal names why', (t) => {
  const tree = makeGtmTree({ prefix: 'personalize-sup-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  addSuppressionEntry({ email: 'no@x.example', reason: 'unsubscribed' }, { root: tree.root });
  const store = loadSuppressionStore({ root: tree.root });

  for (const contact of [{ email: 'no@x.example' }, { 'Work Email': 'NO@X.EXAMPLE' }]) {
    const res = checkDraft({ ...OK_DRAFT, brief: supported(), contact, store, ...ctx });
    assert.equal(res.decision, REFUSE);
    assert.equal(res.text, null);
    assert.deepEqual(res.violations, ['contact_suppressed']);
  }

  const ok = checkDraft({ ...OK_DRAFT, brief: supported(), contact: { email: 'yes@x.example' }, store, ...ctx });
  assert.equal(ok.decision, EMIT, JSON.stringify(ok.violations));
});

test('every refusal carries its explicit null, so the report can be per contact', () => {
  const res = checkDraft({
    template: 'Congrats on {{funding}} and welcome to {{role}}.',
    slots: [
      { name: 'funding', field: 'recent_funding', section: 'first_line' },
      { name: 'role', field: 'new_role', section: 'body' },
    ],
    brief: supported(), ...ctx,
  });
  assert.equal(res.decision, REFUSE);
  assert.equal(res.refusals.length, 2);
  for (const r of res.refusals) assert.equal(r.result, 'not_found');
});
