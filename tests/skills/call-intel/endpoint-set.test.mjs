// tests/skills/call-intel/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint. CI already fails on an endpoint owned by nobody; it cannot see the other
// direction — a SKILL.md that quietly calls something it does not own, or that silently
// drops one it is responsible for.
//
// This skill is the interesting case for local inference: it OWNS `ai_enrich` and its inference mode
// is still local. So the endpoint set alone cannot tell you whether the law is honoured,
// and the assertions below are about the CONDITIONS under which the hop may fire.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';
import { loadCallIntelRules } from './harness.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const RULES = loadCallIntelRules();
const BODY = skillBody();
const owned = ownedEndpoints();
const invoked = invokedEndpoints(BODY);

test('the owners file assigns this skill exactly two endpoints', () => {
  assert.deepEqual([...owned].sort(), ['ai_enrich', 'enrich_profile']);
  assert.equal(owned.size, 2);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [], `owned but never invoked: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invoked) assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invoked) {
    assert.ok(!(name in (OWNERS.unclaimed || {})), `${name} is unclaimed and must not be invoked`);
    assert.notEqual(CATALOG.endpoints[name].pricing?.disabled_by_default, true, `${name} is disabled by default`);
  }
});

test('the rules table names the same two endpoints the owners file does', () => {
  assert.equal(RULES.inference.paid_hop, 'ai_enrich');
  assert.equal(RULES.attendee_resolution.endpoint, 'enrich_profile');
  assert.ok(owned.has(RULES.inference.paid_hop));
  assert.ok(owned.has(RULES.attendee_resolution.endpoint));
});

test('there is no transcription, telephony or recording endpoint to reach for', () => {
  // The pack's permanent ceiling for this skill. If one of these ever appears in the
  // catalog the boundary paragraph needs rewriting, and this is where that is noticed.
  for (const invented of ['transcribe', 'transcription', 'call_recording', 'dial', 'dialer', 'speech_to_text']) {
    assert.equal(CATALOG.endpoints[invented], undefined,
      `${invented} now exists in the catalog — re-check the boundary section`);
    assert.ok(!new RegExp(`\`${invented}\\(`).test(BODY), `the SKILL.md invokes \`${invented}(\`, which is not real`);
  }
});

test('enrich_profile is invoked singly and never described as a sweep', () => {
  // enrich_profile has a bulk variant, so a skill that loops it pays ~max_batch times
  // the latency for the same credits — the validator warns on that shape. More
  // importantly here, sweeping a committee off names heard on a call is exactly the
  // attribution failure the skill refuses.
  assert.equal(CATALOG.endpoints.enrich_profile.bulk_variant, 'enrich_profiles_bulk');
  const LOOPY = /\b(for each|loop over|loop through|iterate|one at a time|row by row|per row|per contact)\b/i;
  for (const para of BODY.split(/\n\s*\n/)) {
    if (/\benrich_profile\b/.test(para)) {
      assert.ok(!LOOPY.test(para), `a paragraph describes looping enrich_profile:\n${para}`);
    }
  }
  assert.equal(RULES.attendee_resolution.search_by_name_allowed, false);
  assert.equal(RULES.attendee_resolution.requires_profile_url, true);
});

test('the skill owns the LLM hop, and still declares local inference with the reason', () => {
  assert.ok(owned.has('ai_enrich'), 'endpoint-owners.yaml DOES give ai_enrich to this skill');
  assert.match(BODY, /Inference mode: local/i, 'a local-inference skill states its inference mode and why');
  assert.equal(RULES.inference.mode, 'local');
  assert.equal(RULES.inference.paid_hop_default, 'off');
  assert.deepEqual([...RULES.inference.paid_hop_allowed_reasons].sort(),
    ['batch_scale', 'perplexity_web_grounding'],
    'the only two reasons the local-inference rule allows; "read the transcript harder" is not one of them');
});

test('the LLM hop is bound to the dual contract, as the validator requires of any skill using it', () => {
  assert.match(BODY, /dual-contract\.schema\.json|dual contract/i,
    'a skill with an LLM hop must reference the contract that validates its output');
  assert.equal(RULES.inference.dual_contract, '_lib/dual-contract.schema.json');
  assert.equal(RULES.inference.llm_output_provenance, 'ai_inferred');
  assert.equal(RULES.inference.llm_output_merged_into_verified, false);
  assert.equal(RULES.inference.confidence, 'numeric_0_1');
  assert.ok(!/\bconfidence\b\s*[:=]\s*"?(?:high|medium|low)"?/i.test(BODY),
    'a worded confidence is one of the conventions the dual contract abolished');
});
