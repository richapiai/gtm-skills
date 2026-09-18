// tests/skills/personalize/rules-block.test.mjs
//
// The copy rules live in the shipped SKILL.md so the evals test the shipped skill.
// This file tests the LOADER and the table's own invariants: a deleted block, a second
// block, a disarmed Iron Law or a default flipped to `emit` must be a red run rather
// than a silent policy change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate } from '../../../_lib/gates.mjs';
import { NULL_ENUM } from '../../../_lib/dual-contract.mjs';
import {
  loadPersonalizeRules, loadEvidenceRules, planClaim, PersonalizeRulesUnavailable,
  SKILL_PATH, EMIT, REFUSE, NOT_VERIFIABLE, NOT_FOUND, NOT_APPLICABLE,
} from './harness.mjs';
import {
  tmpRoot, PINNED_GATES, brief, verified, NOW, skillBody,
} from './helpers.mjs';

const RULES = loadPersonalizeRules();
const EVIDENCE = loadEvidenceRules();
const GATES = loadGates();
const SRC = readFileSync(SKILL_PATH, 'utf8');

function skillWith (body) {
  const dir = join(tmpRoot('personalize-rules-'), 'personalize');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, body, 'utf8');
  return p;
}

test('there is exactly one personalize-rules block, and it parses', () => {
  const fences = SRC.split('\n').filter(l => /^```yaml[ \t]+personalize-rules[ \t]*$/.test(l));
  assert.equal(fences.length, 1);
  assert.equal(typeof RULES, 'object');
});

test('a SKILL.md with no block throws — there is no default table', () => {
  const p = skillWith('# personalize\n\nno rules here\n');
  assert.throws(() => loadPersonalizeRules({ path: p }), (e) => e instanceof PersonalizeRulesUnavailable);
});

test('two blocks throw — an ambiguous gate is not a gate', () => {
  const p = skillWith(SRC + '\n\n```yaml personalize-rules\ndefault_decision: refuse\n```\n');
  assert.throws(() => loadPersonalizeRules({ path: p }), /exactly one/);
});

test('a permissive default_decision is refused at load time (law 5)', () => {
  const p = skillWith('```yaml personalize-rules\n'
    + 'default_decision: emit\nclaim_gate: {}\npre_emit: {}\nbanned_phrases: []\ninference: {}\n```\n');
  assert.throws(() => loadPersonalizeRules({ path: p }), /law 5/);
});

test('the decision set is binary — there is no "emit, but carefully"', () => {
  assert.deepEqual(RULES.decisions, [EMIT, REFUSE]);
  assert.equal(RULES.default_decision, REFUSE);
});

test('the table uses the pack\'s one explicit null enum and nothing else', () => {
  assert.deepEqual([...RULES.null_enum].sort(), [...NULL_ENUM].sort());
  for (const nul of Object.values(RULES.claim_gate.refusal_null_by_grade)) {
    assert.ok(NULL_ENUM.includes(nul), `${nul} is not one of the three explicit nulls`);
  }
  assert.equal(RULES.claim_gate.refusal_null_by_grade.weak, NOT_VERIFIABLE);
  assert.equal(RULES.claim_gate.refusal_null_by_grade.unsupported, NOT_FOUND);
  assert.equal(RULES.claim_gate.inapplicable_null, NOT_APPLICABLE);
});

test('the Iron Law is in the table, not only in the prose', () => {
  assert.equal(RULES.claim_gate.require_source_line, true);
  assert.deepEqual(RULES.claim_gate.assertable_grades, ['supported']);
  assert.deepEqual(RULES.claim_gate.assertable_provenance, ['verified']);
  assert.equal(RULES.claim_gate.carry_through_brief_nulls, true);
});

test('disarming require_source_line fails CLOSED — the whole skill refuses', () => {
  // The adversarial edit: somebody softens the law in the table instead of arguing
  // about it. The harness must not read that as permission.
  const disarmed = JSON.parse(JSON.stringify(RULES));
  disarmed.claim_gate.require_source_line = false;
  const b = verified(brief(), 'tech_stack', 'SAP', { source: 'https://acme.example/careers' });
  const p = planClaim(b, 'tech_stack',
    { rules: disarmed, evidenceRules: EVIDENCE, gates: GATES, now: NOW });
  assert.equal(p.decision, REFUSE);
  assert.equal(p.failed_closed, true);
  assert.match(p.reasons[0], /Iron Law is disarmed/);
});

test('every pre-emit check is on, and each one is a hard fail', () => {
  assert.equal(RULES.banned_phrase_action, 'fail');
  for (const [name, on] of Object.entries(RULES.pre_emit)) {
    assert.equal(on, true, `pre-emit check ${name} is switched off`);
  }
});

test('the claim budget is a shape rule with a value per section, not an open door', () => {
  assert.ok(Object.keys(RULES.claim_budget).length > 0);
  for (const [section, n] of Object.entries(RULES.claim_budget)) {
    assert.ok(Number.isInteger(n) && n >= 1, `claim_budget.${section} is not a positive integer`);
    assert.ok(n <= 2, `claim_budget.${section} is ${n} — an opener that stacks claims is a dossier`);
  }
});

test('the gate key the table names is merged, and the skill cites it properly', () => {
  // This test used to assert the key did NOT resolve, and was written to go red the
  // moment it was merged — a deliberate handoff, so the prose could not keep saying
  // "requested, not yet merged" after it was. It has been merged; this is the other
  // side of that handoff.
  const key = RULES.inference.batch_scale_gate_key;
  assert.match(key, /^skills\.personalize\./);
  assert.deepEqual([key.split('.').pop()], Object.keys(PINNED_GATES.personalize));

  // The fail-closed instruction stays in the table regardless. A key that exists
  // today can be deleted tomorrow, and the answer must still be "stop".
  assert.equal(RULES.inference.batch_scale_on_missing_key, 'stop');

  assert.equal(hasGate(loadGates(), key), true, `${key} should resolve now that it is merged`);
  assert.match(skillBody('personalize'), new RegExp(`gates\\.yaml:${key.replace(/\./g, '\\.')}`),
    `the skill must cite ${key} as a gates.yaml: reference, not as a bare dotted path`);
});

test('the banned list is real, deduplicated, and free of accidental substrings', () => {
  const list = RULES.banned_phrases;
  assert.ok(list.length >= 15, 'a two-item banned list is decoration');
  assert.deepEqual(list, [...new Set(list)], 'duplicate banned phrases');
  for (const p of list) {
    assert.equal(p, p.toLowerCase(), `"${p}" is not lowercased — matching is case-insensitive by normalising`);
    assert.ok(p.trim().length >= 6, `"${p}" is short enough to fire inside an innocent word`);
  }
});
