// tests/skills/gtm-kickoff/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint. CI already fails on an endpoint owned by nobody; it cannot see the other
// direction — a SKILL.md quietly calling something it does not own, or silently
// dropping one it is responsible for. The pack hit that class once (two components computing
// "the 11 unbounded endpoints" and getting different sets), so the set is asserted.
//
// It also pins the local inference mode: this skill's endpoint set must not contain
// ai_enrich, and the body must not invoke it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { REPO_ROOT, SKILL_NAME, skillBody, invokedEndpoints } from './helpers.mjs';

const owners = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
const catalog = JSON.parse(readFileSync(join(REPO_ROOT, '_lib', 'api-catalog.json'), 'utf8'));

const owned = new Set(
  Object.entries(owners.endpoints)
    .filter(([, skills]) => skills.includes(SKILL_NAME))
    .map(([name]) => name)
);

test('the owners file assigns this skill exactly the entry-point endpoint set', () => {
  // Pinned, so a merge that quietly widens the entry point's surface is a red run.
  // A kickoff that can spend is a kickoff nobody runs first.
  assert.deepEqual([...owned].sort(), ['search_reference_data']);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(skillBody());
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra   = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [], `owned but never invoked: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `invoked but not owned by ${SKILL_NAME}: ${extra.join(', ')}`);
});

test('every endpoint it invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(catalog.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is unclaimed or disabled by default', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(!(name in (owners.unclaimed || {})),
      `${name} is unclaimed (${owners.unclaimed?.[name]}) and must not be invoked`);
    assert.notEqual(catalog.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default (${catalog.endpoints[name].pricing?.disabled_reason})`);
  }
});

test('the skill claims to spend almost nothing, and the catalog agrees', () => {
  // The honesty check the brief asked for: do not dress a free interview up as a data
  // product. Every endpoint in the set must be priced at zero per call.
  for (const name of owned) {
    const p = catalog.endpoints[name].pricing;
    assert.equal(p.model, 'flat', `${name} is not flat-priced; the "spends nothing" claim needs re-checking`);
    assert.equal(p.credits_per_call, 0,
      `${name} costs credits, so the SKILL.md must stop claiming this step is free`);
  }
});

test('the endpoint it owns is still covered by a plan, precisely because it is free', () => {
  const body = skillBody();
  assert.match(body, /dry[- ]?run/i);
  // Law 3 is about naming every call, not only the dear ones.
  const para = body.split(/\n\s*\n/).find(p => p.includes('search_reference_data()'));
  assert.ok(para, 'search_reference_data() must be invoked in a paragraph of its own');
});

test('the entry point owns no LLM endpoint and invokes none', () => {
  assert.ok(!owned.has('ai_enrich'),
    'endpoint-owners.yaml gave gtm-kickoff an LLM hop; the kickoff reasons locally by design');
  assert.ok(!invokedEndpoints(skillBody()).has('ai_enrich'),
    'the SKILL.md invokes ai_enrich(); a kickoff interview has neither web-grounding nor batch scale');
});
