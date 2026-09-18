// tests/skills/call-intel/inference-mode.test.mjs
//
// Local inference, and the reason the rule names /call-intel explicitly: a transcript is text already in
// context, so extracting structure out of it is free. `ai_enrich` at a metered price per
// call is the wrong answer unless the run genuinely needs Perplexity grounding or batch
// scale.
//
// Asserting that the SKILL.md contains the sentence "inference mode: local" proves a
// sentence exists. What is asserted here is that the paid route is CLOSED — that asking
// for it with the wrong reason is refused, and that the batch escape fails closed when
// its gate key does not resolve.
//
// Both `skills.call_intel` keys are MERGED now, so the open half is asserted against the
// shipped file and the closed half against STRIPPED, a copy of the shipped gates with
// the block deleted. A fail-closed test pointed at "the real file happens to lack the
// key" stops testing anything the day the key lands; one pointed at a stripped block
// keeps testing law 5 for every future key. The strip is itself asserted below, so it
// cannot rot into a no-op that turns these green and vacuous.
//
// It also covers the rules-block loader: a deleted block, a second block, a disarmed
// Iron Law or a default flipped to `emit` must be a red run rather than a silent policy
// change.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate, gateValue } from '../../../_lib/gates.mjs';
import {
  loadCallIntelRules, planLlmHop, planAttendeeResolution, extractField,
  CallIntelRulesUnavailable, SKILL_PATH,
  EMIT, REFUSE, NULL_ENUM, NOT_APPLICABLE,
} from './harness.mjs';
import {
  tmpRoot, REQUESTED_GATES, gatesWithRequestedKeys, gatesWithout, skillBody,
} from './helpers.mjs';

const RULES = loadCallIntelRules();
const GATES = loadGates();
const MERGED = gatesWithRequestedKeys(GATES);
/** The shipped gates with this skill's whole block deleted — the law-5 input. */
const STRIPPED = gatesWithout(GATES, 'skills.call_intel');
const SRC = readFileSync(SKILL_PATH, 'utf8');
const BODY = skillBody();

function skillWith (body) {
  const dir = join(tmpRoot('call-intel-rules-'), 'call-intel');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, body, 'utf8');
  return p;
}

// ===========================================================================
// The paid hop is closed by default.
// ===========================================================================

test('the default path spends nothing — extraction never reaches a paid hop', () => {
  const r = extractField({
    transcript: 'Rep: Anything blocking? Buyer: No, all good.',
    field: 'objections', candidates: [], rules: RULES,
  });
  assert.equal(r.result, NOT_APPLICABLE);
  assert.ok(NULL_ENUM.includes(r.result));
  // The record was produced with no gates object, no network, no endpoint: there is
  // nothing in the free path that could have spent.
  assert.equal(r.record.source, 'transcript');
});

test('asking for the paid hop to do the extraction itself is refused', () => {
  for (const reason of ['extraction', 'summarise', 'read the transcript', 'better_quality', 'deeper_analysis']) {
    const p = planLlmHop({ reason, transcripts: 1, gates: MERGED, rules: RULES });
    assert.equal(p.decision, REFUSE, `"${reason}" bought a paid call`);
    assert.equal(p.mode, 'local');
    assert.match(p.reason, /already in context|not one of/i);
  }
});

test('strip the block and neither key resolves — the fail-closed input is real', () => {
  // The guard on the guard, after tests/skills/evidence-score/rules-block.test.mjs. The
  // law-5 tests here feed STRIPPED; if that strip ever became a no-op — the block
  // renamed, moved, nested differently — they would pass while proving nothing at all.
  for (const k of Object.keys(REQUESTED_GATES.call_intel)) {
    assert.equal(hasGate(STRIPPED, `skills.call_intel.${k}`), false,
      `skills.call_intel.${k} survived the strip`);
  }
});

test('the batch escape fails closed when its gate key does not resolve', () => {
  // Was: "while its gate key is unmerged", read off the real file. Merged now, so the
  // closed input is MADE by deleting the block. Ten thousand transcripts is deliberately
  // far over any plausible floor: without the floor the escape is shut regardless of
  // how obviously it "should" have opened, which is the whole of law 5.
  const key = RULES.inference.paid_hop_batch_gate;
  assert.equal(hasGate(STRIPPED, key), false, 'the strip must actually remove the key');

  const p = planLlmHop({ reason: 'batch_scale', transcripts: 10000, gates: STRIPPED, rules: RULES });
  assert.equal(p.decision, REFUSE);
  assert.equal(p.failed_closed, true, 'a missing gate key reads as STOP, never as "no gate" (law 5)');
  assert.equal(p.mode, 'local');
});

test('with the key merged, batch scale opens only above the threshold — and still dry-runs', () => {
  const key = RULES.inference.paid_hop_batch_gate;
  const min = REQUESTED_GATES.call_intel.ai_enrich_batch_min_transcripts;
  assert.equal(hasGate(GATES, key), true, `${key} must resolve now that it is merged`);
  assert.equal(gateValue(GATES, key), min,
    'this suite is calibrated to that floor; reconcile a change deliberately');

  // On the SHIPPED file, so the open half is the live behaviour rather than a fixture's.
  const below = planLlmHop({ reason: 'batch_scale', transcripts: min - 1, gates: GATES, rules: RULES });
  assert.equal(below.decision, REFUSE);
  assert.equal(below.mode, 'local');
  assert.notEqual(below.failed_closed, true, 'this is a threshold decision, not a missing key');

  const above = planLlmHop({ reason: 'batch_scale', transcripts: min, gates: GATES, rules: RULES });
  assert.equal(above.decision, EMIT);
  assert.equal(above.mode, 'paid');
  assert.equal(above.requires_dry_run, true, 'law 3 — every paid call is named and costed before it runs');
  assert.equal(planLlmHop({ reason: 'batch_scale', transcripts: min, gates: MERGED, rules: RULES }).decision, EMIT);
});

test('grounding is the other permitted reason, and it does not need the batch threshold', () => {
  const p = planLlmHop({ reason: 'perplexity_web_grounding', transcripts: 1, gates: GATES, rules: RULES });
  assert.equal(p.decision, EMIT);
  assert.equal(p.requires_dry_run, true);
  // And the SKILL.md must say WHY that provider specifically, or a reader picks another
  // one and silently loses the filters that were the whole point.
  assert.match(BODY.replace(/\s+/g, ' '), /Perplexity-only/i);
  assert.match(BODY, /search_domain_filter/);
  assert.match(BODY, /search_recency_filter/);
});

// ===========================================================================
// The attendee-resolution hop.
// ===========================================================================

test('a name heard on a call never buys a profile lookup', () => {
  const p = planAttendeeResolution({ attendee: { name: 'Sarah' }, gates: MERGED, rules: RULES });
  assert.equal(p.decision, REFUSE);
  assert.equal(p.spend, null);
  assert.match(p.reason, /does not search for a person by a name/i);
});

test('a profile URL buys exactly one call, dry-run first', () => {
  const p = planAttendeeResolution({
    attendee: { name: 'Sarah', linkedin_url: 'https://linkedin.example/in/sarah' },
    gates: MERGED, rules: RULES,
  });
  assert.equal(p.decision, EMIT);
  assert.equal(p.spend.endpoint, 'enrich_profile');
  assert.equal(p.spend.planned_calls, 1);
  assert.equal(p.spend.dry_run_required, true);
});

test('the resolution hop also fails closed when its gate key does not resolve', () => {
  // Same inversion as the batch escape above: the key is merged, so the closed case is
  // made by deleting that one key rather than by the file happening not to have it.
  // Deleting only this key, not the whole block, keeps the REFUSE attributable to it.
  const key = RULES.attendee_resolution.max_per_run_gate;
  const stripped = gatesWithout(GATES, key);
  assert.equal(hasGate(stripped, key), false, 'the strip must actually remove the key');

  const p = planAttendeeResolution({
    attendee: { linkedin_url: 'https://linkedin.example/in/sarah' }, gates: stripped, rules: RULES,
  });
  assert.equal(p.decision, REFUSE);
  assert.equal(p.failed_closed, true);
  assert.equal(p.spend, null);

  // The counterpart: with the merged key the same attendee buys exactly one call, so
  // the REFUSE above is the missing ceiling and nothing else about the attendee.
  assert.equal(hasGate(GATES, key), true, `${key} must resolve now that it is merged`);
  const open = planAttendeeResolution({
    attendee: { linkedin_url: 'https://linkedin.example/in/sarah' }, gates: GATES, rules: RULES,
  });
  assert.equal(open.decision, EMIT);
  assert.equal(open.spend.planned_calls, REQUESTED_GATES.call_intel.max_enrich_profile_calls_per_run);
});

// ===========================================================================
// The rules block itself.
// ===========================================================================

test('there is exactly one call-intel-rules block, and it parses', () => {
  const fences = SRC.split('\n').filter(l => /^```yaml[ \t]+call-intel-rules[ \t]*$/.test(l));
  assert.equal(fences.length, 1);
  assert.equal(typeof RULES, 'object');
});

test('a SKILL.md with no block throws — there is no default table', () => {
  const p = skillWith('# call-intel\n\nno rules here\n');
  assert.throws(() => loadCallIntelRules({ path: p }), (e) => e instanceof CallIntelRulesUnavailable);
});

test('two blocks throw — an ambiguous gate is not a gate', () => {
  const p = skillWith(SRC + '\n\n```yaml call-intel-rules\ndefault_decision: emit\n```\n');
  assert.throws(() => loadCallIntelRules({ path: p }), /exactly one/);
});

test('every single-word disarm of the Iron Law is refused at load time (law 5)', () => {
  // Each of these is one edit away from a skill that still reads correctly to a human
  // and no longer enforces anything.
  const disarms = [
    ['default_decision: refuse', 'default_decision: emit'],
    ['require_verbatim_span: true\n  match: exact_substring', 'require_verbatim_span: false\n  match: exact_substring'],
    ['unanchored_action: drop', 'unanchored_action: keep'],
    ['hedged_item_allowed: false', 'hedged_item_allowed: true'],
    ['paraphrase_as_quote_allowed: false', 'paraphrase_as_quote_allowed: true'],
    ['empty_field_action: explicit_null', 'empty_field_action: omit'],
    ['omit_empty_field: false', 'omit_empty_field: true'],
    ['free_text_result_allowed: false', 'free_text_result_allowed: true'],
    ['    empty_null: not_applicable\n    empty_reason:', '    empty_null: unknown\n    empty_reason:'],
    ['  mode: local', '  mode: paid'],
    ['  llm_output_merged_into_verified: false', '  llm_output_merged_into_verified: true'],
  ];
  for (const [from, to] of disarms) {
    assert.ok(SRC.includes(from), `the rules block no longer contains ${JSON.stringify(from)}`);
    const p = skillWith(SRC.replace(from, to));
    assert.throws(() => loadCallIntelRules({ path: p }),
      (e) => e instanceof CallIntelRulesUnavailable,
      `flipping ${JSON.stringify(from)} -> ${JSON.stringify(to)} was accepted`);
  }
});

test('the null enum in the table is the one in the dual contract, not a second copy', () => {
  assert.deepEqual([...RULES.null_enum].sort(), [...NULL_ENUM].sort());
});

test('the output path and its single writer are declared', () => {
  assert.equal(RULES.output.path, 'gtm/calls');
  assert.equal(RULES.output.contact_rows_writer, '_lib/suppression.mjs');
  assert.equal(RULES.output.alternate_writers_allowed, false);
  assert.equal(RULES.output.transcript_leaves_gtm, false,
    'a transcript is the most sensitive artifact in gtm/ (law 7)');
});
