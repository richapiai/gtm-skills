// tests/skills/gtm-kickoff/inference-mode.test.mjs
//
// The local-inference verify criterion is "each skill states its mode and why". A skill that states
// no mode is the one that quietly starts paying an LLM endpoint to read text it was
// already handed, so the statement is asserted rather than trusted.
//
// /gtm-kickoff's mode is local-only: it owns no LLM endpoint, and the two reasons the
// pack permits an ai_enrich call — Perplexity web grounding and batch scale — cannot
// arise in a live interview.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody } from './helpers.mjs';

const body = skillBody();
const modeSection = (() => {
  const start = body.search(/^##.*inference mode/im);
  if (start < 0) return '';
  const rest = body.slice(start + 1);
  const end = rest.search(/^##\s/m);
  return end < 0 ? rest : rest.slice(0, end);
})();

test('the skill has a section that states its inference mode', () => {
  assert.ok(modeSection.length > 0,
    'no `## Inference mode` section — the local-inference rule requires every skill to state its mode and why');
});

test('the stated mode is local, and it is stated as a mode rather than implied', () => {
  assert.match(modeSection, /\blocal\b/i);
  assert.match(modeSection, /Mode:/,
    'the mode must be declared in a form a reader cannot miss');
});

test('the section says WHY, not just what', () => {
  assert.match(modeSection, /free|already runs inside|waste/i,
    'the local-inference rule wants the reason recorded: the pack already runs inside a model that infers for free');
});

test('it names the two permitted reasons and rules both out for this skill', () => {
  assert.match(modeSection, /web grounding|Perplexity/i, 'the grounding exception is not named');
  assert.match(modeSection, /batch/i, 'the batch-scale exception is not named');
  assert.match(modeSection, /cannot arise|never will be|does not apply/i,
    'naming the exceptions without ruling them out invites a future author to use one');
});

test('the skill never invokes an LLM hop anywhere in its body', () => {
  assert.doesNotMatch(body, /`ai_enrich\(/,
    'gtm-kickoff invokes ai_enrich(); its endpoint set does not include it');
  assert.doesNotMatch(body, /\boutput_schema\b/,
    'gtm-kickoff describes a structured LLM output; it has no LLM hop to structure');
});

test('the free-by-design claim is made explicitly, not left to inference', () => {
  assert.match(body, /^##.*what this skill spends/im,
    'a skill that spends almost nothing should say so plainly rather than look substantial');
  assert.match(body, /prices (it|at zero)|priced at zero|prices at zero/i);
});
