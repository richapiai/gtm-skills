// tests/skills/ads-audience/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by nobody. It cannot see the
// other direction: a SKILL.md that quietly calls something it does not own, or that
// silently drops one it is responsible for. Both are invisible in review.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';
import { loadAudienceRules } from './harness.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const RULES = loadAudienceRules();
const owned = ownedEndpoints();
const invoked = invokedEndpoints(skillBody());

test('the owners file assigns this skill exactly two endpoints', () => {
  assert.deepEqual([...owned].sort(), ['email_finder', 'identify_email_type']);
  assert.equal(owned.size, 2);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invoked) assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invoked) {
    assert.ok(!(name in (OWNERS.unclaimed || {})),
      `${name} is unclaimed (${OWNERS.unclaimed?.[name]}) and must not be invoked`);
    assert.notEqual(CATALOG.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default`);
  }
});

test('the rules table names the same two endpoints the owners file does', () => {
  assert.equal(RULES.paid_fill.endpoint, 'email_finder');
  assert.equal(RULES.classifier.endpoint, 'identify_email_type');
  assert.ok(owned.has(RULES.paid_fill.endpoint));
  assert.ok(owned.has(RULES.classifier.endpoint));
});

test('the expensive personal-address endpoint is named as out of scope and never invoked', () => {
  const body = skillBody();
  // find_personal_email reaches a personal mailbox and is in gates.yaml:always_ask.
  // Personal addresses do not belong in an audience assembled from a business list.
  assert.ok(!owned.has('find_personal_email'));
  assert.ok(!/`find_personal_email\(/.test(body), 'the skill must not invoke find_personal_email');
  assert.ok(body.includes('find_personal_email'),
    'the skill must say out loud that this endpoint is not its route, so a reader does not go looking');
});

test('the LLM hop is not in this skill (local inference)', () => {
  const body = skillBody();
  assert.ok(!owned.has('ai_enrich'), 'endpoint-owners.yaml does not give ai_enrich to this skill');
  assert.ok(!/`ai_enrich\(/.test(body), 'a local-inference skill must not invoke the paid LLM hop');
  assert.match(body, /Inference mode: local/i, 'a local-inference skill states its inference mode and why');
  assert.equal(RULES.inference_mode, 'local');
  assert.equal(RULES.llm_hop, 'none');
});

test('both invoked endpoints are flat-priced, which is why the plan total can be exact', () => {
  // The skill promises an exact total rather than a range. That promise is only honest
  // while neither endpoint is per-result; a reprice to per_result must break this test.
  for (const name of invoked) {
    const p = CATALOG.endpoints[name].pricing;
    assert.equal(p.model, 'flat', `${name} is no longer flat-priced — the SKILL.md promises an exact plan total`);
    assert.equal(p.page_gated, false, `${name} is now page-gated — the skill has no page-gate handling`);
  }
});
