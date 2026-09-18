// tests/skills/icp-review/inference-mode.test.mjs
//
// Local inference by default. `ai_enrich` costs credits while this pack already
// runs inside a model that infers for free, so the endpoint is reserved for exactly two
// reasons — Perplexity web grounding and batch scale — and the verify criterion
// is that each affected skill STATES its mode and why.
//
// /icp-review is on that list. This file asserts the statement, the two reasons, the
// Perplexity-only caveat with its spec citation, and the ordering that makes the mode
// real rather than decorative: the free synthesis happens before the paid call is even
// considered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, skillBody } from './helpers.mjs';

const body = skillBody();
const section = (() => {
  const start = body.search(/^##.*inference mode/im);
  if (start < 0) return '';
  const rest = body.slice(start + 1);
  const end = rest.search(/^##\s/m);
  return end < 0 ? rest : rest.slice(0, end);
})();

test('the skill states its inference mode in a section of its own', () => {
  assert.ok(section.length > 0, 'no `## Inference mode` section — the local-inference rule requires the mode be stated');
  assert.match(section, /Mode:/, 'the mode must be declared where a reader cannot miss it');
  assert.match(section, /local/i);
  assert.match(section, /default/i, 'local must be the DEFAULT, not one option among two');
  assert.match(section, /local-inference rule/i, 'the section should name the rule it implements');
});

test('the section says why, in terms of what the alternative costs', () => {
  assert.match(section, /free|already runs inside|waste/i);
});

test('exactly two reasons to spend are named, and both are the sanctioned ones', () => {
  assert.match(section, /two reasons/i, 'the count must be explicit, or a third reason creeps in');
  assert.match(section, /web grounding/i);
  assert.match(section, /batch scale/i);
});

test('the Perplexity-only caveat is stated with its spec citation', () => {
  assert.match(section, /search_domain_filter/);
  assert.match(section, /search_recency_filter/);
  assert.match(section, /Perplexity-only|Perplexity only/i);
  assert.match(section, /openapi\.yaml:631-636/,
    'the caveat must cite the spec lines, so a reader can check it rather than trust it');
});

test('the cited spec lines really do carry the two Perplexity-only fields', () => {
  // Evidence over vibes (law 6): the citation is checked against the pinned spec.
  const lines = readFileSync(join(REPO_ROOT, 'spec', 'openapi.yaml'), 'utf8').split('\n');
  const cited = lines.slice(631 - 1, 636).join('\n');
  assert.match(cited, /search_domain_filter/, 'openapi.yaml:631-636 does not contain search_domain_filter');
  assert.match(cited, /search_recency_filter/, 'openapi.yaml:631-636 does not contain search_recency_filter');
  assert.match(cited, /Perplexity only/i);
});

test('the uses that must stay local are named, so the exceptions cannot be stretched', () => {
  assert.match(section, /summarise|summarize|name this segment|write the ICP/i,
    'without naming the tempting local-only uses, "batch scale" swallows everything');
});

test('the cache asymmetry that backs the argument is cited, not asserted', () => {
  assert.match(section, /gates\.yaml:cache_ttl\.endpoints\.ai_enrich/);
  assert.match(section, /gates\.yaml:cache_ttl\.endpoints\.enrich_company/);
});

test('the free synthesis comes before the paid LLM hop in the documented flow', () => {
  const local = body.search(/^##.*synthesise locally/im);
  const call  = body.indexOf('richapi call ai_enrich');
  assert.ok(local > -1 && call > -1);
  assert.ok(local < call,
    'if the ai_enrich command appears before the local synthesis, the "local by default" '
    + 'claim is decoration');
});

test('the LLM hop is bound to the dual contract wherever it appears', () => {
  assert.match(body, /output_schema/, 'the guidance-not-enforcement problem must be named');
  assert.match(body, /guide|guidance/i);
  assert.match(body, /dual contract|dual-contract\.schema\.json/);
  assert.match(body, /quarantin|ai_inferred_invalid/i,
    'a failing response must be described as quarantined, not merely as ignored');
});

test('confidence is numeric, matching the shipped schema', () => {
  assert.doesNotMatch(body, /\bconfidence\b\s*[:=]\s*"?(?:high|medium|low)"?/i);
  assert.match(body, /numeric/i);
  const schema = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'dual-contract.schema.json'), 'utf8'));
  assert.equal(schema.properties.confidence.type, 'number',
    'the skill says numeric; if the schema ever disagrees, one of them is lying to the user');
});
