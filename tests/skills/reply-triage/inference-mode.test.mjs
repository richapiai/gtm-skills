// tests/skills/reply-triage/inference-mode.test.mjs
//
// The local-inference rule names /reply-triage explicitly. `ai_enrich` is 2 credits a call, and reading a
// two-line email is precisely what the agent running this skill already does for free —
// so on an always-on inbox, routing every reply through the paid hop is the same charge
// every week, forever, for a judgement that cost nothing.
//
// Two claims are asserted here, and the second is the one that matters:
//
//   1. the skill states its mode, and reaches for `ai_enrich` for batch scale ONLY; and
//   2. the opt-out gate is decided LOCALLY at every scale, because `ai_enrich`'s
//      output_schema only *guides* structured output and a guided schema is not a
//      compliance control.
//
// The dual-contract rules wired into the validator are also run directly, so a
// failure names the rule instead of arriving as one line of validator output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSkillDualContract, NULL_ENUM } from '../../../_lib/dual-contract.mjs';
import { loadGates, gateValue, hasGate } from '../../../_lib/gates.mjs';
import { SKILL, skillBody, sections, section, ownedEndpoints, invokedEndpoints, catalog }
  from './helpers.mjs';

const GATES = loadGates();
const CATALOG = catalog();
const body = skillBody();
const flat = (t) => t.replace(/\s+/g, ' ');
const owned = ownedEndpoints();

test('the owners file gives this skill exactly one endpoint, and it is the LLM hop', () => {
  assert.deepEqual([...owned].sort(), ['ai_enrich']);
});

test('the SKILL.md invokes exactly what it owns, and the endpoint exists', () => {
  const invoked = invokedEndpoints(body);
  assert.deepEqual([...invoked].sort(), [...owned].sort());
  assert.ok(CATALOG.endpoints.ai_enrich, 'ai_enrich is not in _lib/api-catalog.json');
  assert.equal(CATALOG.endpoints.ai_enrich.pricing.model, 'flat');
  assert.equal(CATALOG.endpoints.ai_enrich.pricing.disabled_by_default, false);
});

test('the skill states its inference mode and why', () => {
  const s = section(/Inference mode/i, body);
  const f = flat(s.text);
  assert.match(f, /Mode: local inference, by default/i);
  assert.match(f, /local-inference rule/i);
  assert.match(f, /at no marginal cost|for free/i);
});

test('batch scale is the ONLY reason the paid hop is reached for', () => {
  const f = flat(section(/Inference mode/i, body).text);
  assert.match(f, /exactly one reason to reach for `ai_enrich\(\)` here/i);
  assert.match(f, /skills\.reply_triage\.ai_enrich_batch_min_rows/,
    'the batch-scale line is a threshold, and a threshold is a gate key');
  assert.match(f, /Below that line it is never justified/i);
});

test('the Perplexity escape is examined and explicitly ruled out', () => {
  const f = flat(section(/Inference mode/i, body).text);
  assert.match(f, /search_domain_filter/);
  assert.match(f, /search_recency_filter/);
  assert.match(f, /Perplexity-only/);
  assert.match(f, /spec\/openapi\.yaml/,
    'the Perplexity-only claim carries its source (law 6)');
  assert.match(f, /There is nothing to ground/i,
    'a reply is a document the user already has');
});

test('the opt-out gate never goes through the paid hop, at any scale', () => {
  const f = flat(body);
  assert.match(f, /the opt-out gate never goes through the paid hop, at any scale/i);
  assert.match(f, /guided schema is not a compliance control/i);
  assert.match(f, /A hole in Stage A is an opt-out that was never recorded/i,
    'the failure mode has to be named, or someone will batch Stage A for the latency');

  // Structural: the paid hop must not appear inside the Stage A section at all.
  const stageA = section(/Stage A/i, body).text;
  assert.ok(!/ai_enrich/.test(stageA),
    'Stage A must not mention the paid hop as an option — an escape hatch in the compliance '
    + 'gate is the whole risk');
});

test('classification-by-default costs nothing, and the skill says so', () => {
  const f = flat(body);
  assert.match(f, /makes \*\*zero paid calls\*\*|makes zero paid calls/i);
  assert.match(f, /no key at all/i,
    'the default path needs no API key, which is the most surprising fact in this skill');
});

test('the dual contract is referenced and its rules are satisfied', () => {
  const msgs = checkSkillDualContract({ label: `skills/${SKILL}`, body });
  assert.deepEqual(msgs, [], msgs.join('\n'));
  const f = flat(body);
  assert.match(f, /_lib\/dual-contract\.schema\.json/);
  assert.match(f, /ai_inferred/);
  assert.match(f, /never merged into `verified`/i,
    'LLM-derived values are never mixed into verified fields');
  assert.match(f, /confidence is a number in the unit interval, not a word/i,
    'the dual contract requires numeric 0..1, and a string confidence is the drift it prevents');
  for (const tok of NULL_ENUM) {
    assert.ok(f.includes(tok), `the explicit null enum must include ${tok}`);
  }
});

test('the paid hop is planned before it runs, and priced from the catalog', () => {
  const f = flat(body);
  assert.match(f, /--dry-run/);
  assert.match(f, /makes zero calls and prices the batch from the catalog/i);
  assert.match(f, /richapi call ai_enrich/,
    'the paid hop goes through the gated surface, not through an invented verb');
});

test('the LLM hop is never served from cache, and the skill cites the key that says so', () => {
  assert.ok(body.includes('gates.yaml:cache_ttl.endpoints.ai_enrich'));
  assert.ok(hasGate(GATES, 'cache_ttl.endpoints.ai_enrich'));
  assert.equal(gateValue(GATES, 'cache_ttl.endpoints.ai_enrich'), '0d',
    'non-deterministic output is never served from cache — so every batch is paid in full, '
    + 'which is another reason routine classification must not go through it');
  assert.match(flat(body), /never served from cache/i);
  assert.ok(body.includes('gates.yaml:session_budget.fractions.single_call_confirm'),
    'a batch big enough to be a material spend asks on its own');
});

test('the boundary section forbids the two ways this skill could get local inference wrong', () => {
  const f = flat(section(/will not do/i, body).text);
  assert.match(f, /will not decide an opt-out with the paid LLM hop/i);
  assert.match(f, /Not at scale, not as a second opinion, not as a tie-breaker/i);
});
