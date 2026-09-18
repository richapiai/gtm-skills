// tests/skills/inbound/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint. CI already fails on an endpoint owned by nobody; it cannot see the other
// direction — a SKILL.md that quietly calls something it does not own, or that silently
// drops one of the eight it is responsible for.
//
// For /inbound the drift is not merely untidy, it is a correctness failure: the whole
// unattended-approval design in this skill rests on the recipe being a CLOSED set of
// flat-priced, non-page-gated hops. An eighth-and-a-half endpoint sneaking into the
// body is exactly the change that makes the per-lead ceiling a lie.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners, gates,
} from './helpers.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const GATES = gates();
const owned = ownedEndpoints();

test('the owners file assigns /inbound exactly these eight endpoints', () => {
  assert.deepEqual([...owned].sort(), [
    'distribute_leads',
    'email_finder',
    'email_verifier',
    'enrich_company',
    'enrich_profile',
    'find_linkedin_url_by_email',
    'find_website_by_company_name',
    'identify_email_type',
  ]);
  assert.equal(owned.size, 8);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(skillBody());
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(!(name in (OWNERS.unclaimed || {})),
      `${name} is unclaimed (${OWNERS.unclaimed?.[name]}) and must not be invoked`);
    const pricing = CATALOG.endpoints[name].pricing || {};
    assert.notEqual(pricing.disabled_by_default, true,
      `${name} is disabled by default (${pricing.disabled_reason})`);
  }
});

test('no hop in the recipe is on the always-ask list', () => {
  // An always-ask endpoint confirms every single time regardless of budget, which is
  // the definition of "cannot run unattended". If one ever lands in this skill's set,
  // the standing-approval design has to be redesigned rather than re-approved.
  const alwaysAsk = new Set(GATES.always_ask.endpoints);
  for (const name of owned) {
    assert.ok(!alwaysAsk.has(name),
      `${name} is in gates.yaml:always_ask.endpoints and therefore can never run unattended`);
  }
});

test('the LLM hop is not in this skill (local inference)', () => {
  const body = skillBody();
  assert.ok(!owned.has('ai_enrich'), 'endpoint-owners.yaml does not give ai_enrich to this skill');
  assert.ok(!/`ai_enrich\(/.test(body), 'a local-inference skill must not invoke the paid LLM hop');
  assert.match(body, /Inference mode: local/i,
    'a local-inference skill states its inference mode and why');
});

test('the hand-off out of this skill is named, and the sender artifact is not written here', () => {
  const body = skillBody();
  assert.ok(!/\bwriteSenderExport\b/.test(body),
    'only /launch may write a sender export');
  assert.match(body, /\]\(\.\.\/launch\/SKILL\.md\)/,
    'the skill must route the sending artifact to /launch by link');
});
