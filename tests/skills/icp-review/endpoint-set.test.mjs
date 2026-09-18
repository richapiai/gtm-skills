// tests/skills/icp-review/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` decides which skill reaches for which endpoint. CI fails
// on an endpoint owned by nobody; it cannot see a SKILL.md that quietly calls something
// it does not own, or silently drops one it is responsible for. Both directions are
// asserted here.
//
// It also pins the ceiling that matters most for this skill: enrich_company() takes a
// LinkedIn company URL, this skill owns nothing that produces one, and the endpoint
// that does belongs to another skill.

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

test('the owners file assigns this skill exactly its three endpoints', () => {
  assert.deepEqual([...owned].sort(), ['ai_enrich', 'enrich_company', 'search_reference_data']);
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

test('the two endpoints that cost credits are both introduced with a plan', () => {
  const body = skillBody();
  const paid = [...owned].filter(n => (catalog.endpoints[n].pricing?.credits_per_call ?? 0) > 0);
  assert.deepEqual(paid.sort(), ['ai_enrich', 'enrich_company'],
    'the paid set moved; the skill\'s cost prose needs re-checking against the catalog');
  for (const name of paid) {
    const para = body.split(/\n\s*\n/).find(p => p.includes(`${name}()`));
    assert.ok(para, `${name}() is never invoked in a paragraph of its own`);
  }
});

test('the input contract for enrich_company comes from the catalog, and the skill states it', () => {
  // The ceiling: the CRM export has domains and names; this endpoint takes neither.
  assert.deepEqual(catalog.endpoints.enrich_company.required_request_fields, ['url']);
  const body = skillBody();
  assert.match(body, /LinkedIn company page URL/i,
    'the required input must be named exactly, or a user pastes a domain column and pays for nothing');
  assert.match(body, /`url` column/,
    'the CSV column name the runtime needs must be stated');
});

test('the endpoint that could resolve that URL belongs to another skill, and the skill hands off', () => {
  const resolver = owners.endpoints.linkedin_company_search;
  assert.ok(!resolver.includes(SKILL_NAME),
    'if icp-review ever owns linkedin_company_search, the hand-off prose is wrong and must change');
  const body = skillBody();
  assert.match(body, /linkedin_company_search/,
    'the skill must name the endpoint it cannot use, not vaguely gesture at a limitation');
  for (const skill of resolver) {
    assert.ok(body.includes(skill), `the hand-off does not name ${skill}, which owns the resolve`);
  }
  assert.match(body, /never hand-roll|Never hand-roll/i,
    'a raw call has no journal, ledger, cache or gate; the skill must refuse that route explicitly');
});

test('the cache policy the skill leans on is the catalog and gates the runtime actually use', () => {
  // The local-inference argument rests on these two being different, so assert they are.
  const gatesSrc = readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8');
  assert.match(gatesSrc, /ai_enrich: 0d/, 'ai_enrich output is meant to be uncacheable');
  assert.match(gatesSrc, /enrich_company: firmographics/, 'the sample step is meant to be cacheable');
});
