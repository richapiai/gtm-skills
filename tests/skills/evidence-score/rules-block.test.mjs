// tests/skills/evidence-score/rules-block.test.mjs
//
// The grading table is inside the shipped SKILL.md, so the evals test the shipped
// skill rather than a copy of it. This file tests the LOADER and the table's own
// invariants: a deleted block, a second block, a renamed grade or a default flipped to
// something permissive must all be a red run rather than a silent policy change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate, gateValue } from '../../../_lib/gates.mjs';
import { NULL_ENUM } from '../../../_lib/dual-contract.mjs';
import {
  loadEvidenceRules, EvidenceRulesUnavailable, SKILL_PATH,
  SUPPORTED, WEAK, UNSUPPORTED, NOT_FOUND, NOT_VERIFIABLE,
} from './harness.mjs';
import { tmpRoot, PINNED_GATES, gatesWithout } from './helpers.mjs';

const RULES = loadEvidenceRules();
const SRC = readFileSync(SKILL_PATH, 'utf8');

function skillWith (body) {
  const dir = join(tmpRoot('evidence-rules-'), 'evidence-score');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, body, 'utf8');
  return p;
}

test('there is exactly one evidence-rules block, and it parses', () => {
  const fences = SRC.split('\n').filter(l => /^```yaml[ \t]+evidence-rules[ \t]*$/.test(l));
  assert.equal(fences.length, 1, 'the table is the grader; there must be exactly one');
  assert.equal(typeof RULES, 'object');
});

test('a SKILL.md with no block throws — there is no default table to fall back on', () => {
  const p = skillWith('# evidence-score\n\nno rules here\n');
  assert.throws(() => loadEvidenceRules({ path: p }), (e) => e instanceof EvidenceRulesUnavailable);
});

test('two blocks throw — an ambiguous grader is not a grader', () => {
  const p = skillWith(SRC + '\n\n```yaml evidence-rules\ndefault_grade: unsupported\n```\n');
  assert.throws(() => loadEvidenceRules({ path: p }), /exactly one/);
});

test('an unparseable block throws rather than parsing to nothing', () => {
  const p = skillWith('```yaml evidence-rules\n: : :\n  - [\n```\n');
  assert.throws(() => loadEvidenceRules({ path: p }), (e) => e instanceof EvidenceRulesUnavailable);
});

test('a permissive default_grade is refused at load time (law 5)', () => {
  const p = skillWith('```yaml evidence-rules\n'
    + 'default_grade: supported\nprovenance: {}\nthresholds: {}\ndimensions: {}\nbands: {}\n```\n');
  assert.throws(() => loadEvidenceRules({ path: p }), /law 5/);
});

test('every structural key the harness relies on is present', () => {
  for (const key of ['default_grade', 'grades', 'null_enum', 'grade_null', 'provenance',
                     'unattributable_sources', 'thresholds', 'dimensions', 'bands',
                     'carry_through_brief_nulls', 'undated_evidence_is']) {
    assert.ok(RULES[key] !== undefined, `evidence-rules is missing \`${key}\``);
  }
});

test('the table uses the pack\'s one explicit null enum and nothing else', () => {
  assert.deepEqual([...RULES.null_enum].sort(), [...NULL_ENUM].sort());
  assert.deepEqual([...RULES.grades].sort(), [SUPPORTED, UNSUPPORTED, WEAK].sort());
  for (const nul of Object.values(RULES.grade_null)) {
    assert.ok(NULL_ENUM.includes(nul), `${nul} is not one of the three explicit nulls`);
  }
  assert.equal(RULES.grade_null.weak, NOT_VERIFIABLE);
  assert.equal(RULES.grade_null.unsupported, NOT_FOUND);
});

test('only verified provenance is assertable — the other three are not', () => {
  assert.equal(RULES.provenance.verified.assertable, true);
  for (const p of ['ai_inferred', 'ai_inferred_invalid', 'absent']) {
    assert.notEqual(RULES.provenance[p].assertable, true, `${p} must not be assertable`);
  }
  assert.equal(RULES.provenance.ai_inferred_invalid.reads_as, 'absent');
});

test('undated evidence is stale, not fresh', () => {
  assert.equal(RULES.undated_evidence_is, 'stale');
});

test('every threshold names a gate key and nothing names a literal value', () => {
  for (const [name, spec] of Object.entries(RULES.thresholds)) {
    assert.ok(typeof spec.gate_key === 'string' && spec.gate_key.length > 0,
      `threshold ${name} does not name a gate key`);
    assert.match(spec.gate_key, /^skills\.evidence_score\./,
      `threshold ${name} reaches outside this skill's gate namespace`);
    assert.equal(spec.value, undefined, `threshold ${name} hard-codes a value (law 1)`);
    assert.equal(spec.on_missing_key, 'stop', `threshold ${name} does not fail closed`);
  }
});

/** Every gate key the shipped table names, leaf-first, deduplicated. */
function keysNamedByTable () {
  const named = new Set(Object.values(RULES.thresholds).map(s => s.gate_key.split('.').pop()));
  for (const b of ['hot', 'warm', 'watch']) {
    const k = RULES.bands[b]?.min_gate_key;
    if (k) named.add(k.split('.').pop());
  }
  named.add(RULES.bands.hot_requires_reachability_gate_key.split('.').pop());
  return [...named];
}

test('the gate keys the table names are exactly the ones this suite scores against', () => {
  assert.deepEqual(keysNamedByTable().sort(), Object.keys(PINNED_GATES.evidence_score).sort());
});

test('every key the table names resolves, at the value this suite is calibrated to', () => {
  // Was: "none of the requested keys resolves yet — so the pending note is true".
  // The orchestrator merged the block, so the assertion inverts. Pinning the VALUES
  // rather than only their presence is what keeps the rest of this suite's arithmetic
  // honest: a band cutoff edited in gates.yaml would otherwise re-grade every record
  // silently while these tests stayed green.
  const gates = loadGates();
  for (const [key, expected] of Object.entries(PINNED_GATES.evidence_score)) {
    const dotted = `skills.evidence_score.${key}`;
    assert.ok(hasGate(gates, dotted), `${dotted} does not resolve`);
    assert.equal(gateValue(gates, dotted), expected,
      `${dotted} shipped as ${gateValue(gates, dotted)}, not ${expected} — this suite's `
      + 'scoring tests are calibrated to the second number; reconcile them deliberately');
  }
});

test('strip the block and not one of them resolves — the fail-closed input is real', () => {
  // The guard on the guard. Every fail-closed test in this suite now feeds the grader a
  // gates object with `skills.evidence_score` deleted; if that strip ever became a
  // no-op — the block renamed, moved, nested differently — those tests would keep
  // passing while proving nothing at all. So the strip is asserted directly, here.
  const stripped = gatesWithout(loadGates(), 'skills.evidence_score');
  for (const key of keysNamedByTable()) {
    assert.equal(hasGate(stripped, `skills.evidence_score.${key}`), false,
      `skills.evidence_score.${key} survived the strip`);
  }
});

test('the rubric is complete: five dimensions, each capped, each summing to its cap', () => {
  assert.deepEqual(Object.keys(RULES.dimensions).sort(),
    ['engagement', 'fit', 'influence', 'reachability', 'timing']);
  for (const [name, def] of Object.entries(RULES.dimensions)) {
    assert.ok(Number(def.max) > 0, `${name} has no maximum`);
    if (def.kind === 'banded') {
      assert.ok(def.band_field, `${name} is banded but names no band field`);
      assert.equal(def.unmapped_value_points, 0,
        `${name} must score an unrecognised band 0, never a guess`);
      const best = Math.max(...Object.values(def.value_points).map(Number));
      const adj = (def.adjustments || []).reduce((a, x) => a + Number(x.points), 0);
      assert.ok(best + adj >= Number(def.max), `${name} cannot reach its own maximum`);
      assert.ok(best <= Number(def.max), `${name}'s band table alone overshoots its maximum`);
    } else {
      const total = (def.signals || []).reduce((a, s) => a + Number(s.points), 0);
      assert.ok(total >= Number(def.max), `${name} cannot reach its own maximum`);
    }
  }
});

test('no signal field is shared between two dimensions — double counting is a scoring bug', () => {
  const seen = new Map();
  for (const [name, def] of Object.entries(RULES.dimensions)) {
    const fields = [
      ...(def.signals || []).map(s => s.field),
      ...(def.adjustments || []).map(a => a.field),
      ...(def.band_field ? [def.band_field] : []),
    ];
    for (const f of fields) {
      assert.ok(!seen.has(f), `${f} is scored by both ${seen.get(f)} and ${name}`);
      seen.set(f, name);
    }
  }
});
