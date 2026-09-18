// tests/skills/signal-watch/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by nobody. It cannot see the other
// direction: a SKILL.md that quietly calls something it does not own, or that silently
// drops one of the nine it is responsible for.
//
// It also pins the specific damage an earlier version did. It invoked
// `ad_search` and `ad_details`, neither of which is an operation in the pinned spec; it
// invoked `post_keyword_search`, which is disabled pending an API billing answer; and it
// fanned `profile_activities` — unbounded, per-result, charge absent from the response —
// across tracked execs on a schedule. A port that quietly reintroduces any of those is a
// billing incident, so each one is asserted rather than reviewed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const GATES = loadGates();
const owned = ownedEndpoints();
const body = skillBody();

test('the owners file assigns this skill exactly nine endpoints', () => {
  assert.deepEqual([...owned].sort(), [
    'crunchbase_company_scraper_sync',
    'google_search_scraper_sync',
    'lead_search',
    'linkedin_ad_search',
    'linkedin_company_posts',
    'linkedin_job_detail',
    'linkedin_job_search',
    'search_bing',
    'web_tech_stack',
  ]);
  assert.equal(owned.size, 9);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(body);
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(body)) {
    assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invokedEndpoints(body)) {
    assert.ok(!(name in (OWNERS.unclaimed || {})),
      `${name} is unclaimed (${OWNERS.unclaimed?.[name]}) and must not be invoked`);
    const pricing = CATALOG.endpoints[name].pricing || {};
    assert.notEqual(pricing.disabled_by_default, true,
      `${name} is disabled by default (${pricing.disabled_reason})`);
  }
});

test('retired endpoint names that do not exist stay uninvoked', () => {
  for (const phantom of ['ad_search', 'ad_details']) {
    assert.equal(CATALOG.endpoints[phantom], undefined,
      `${phantom} now exists in the catalog — re-check this assertion against the spec`);
    assert.ok(!new RegExp('`' + phantom + '\\(').test(body),
      `the SKILL.md invokes \`${phantom}(\`, which is not a real endpoint`);
  }
  assert.ok(/`linkedin_ad_search\(/.test(body),
    'the real LinkedIn ad endpoint must be the one invoked');
  assert.ok(/\bad_search\b[\s\S]{0,200}?\bad_details\b|\bad_details\b/.test(body),
    'the SKILL.md must name the phantom endpoints so a future port does not reintroduce them');
});

test('post_keyword_search is named as not used and never invoked', () => {
  assert.ok(!/`post_keyword_search\(/.test(body),
    'post_keyword_search is unclaimed and this skill must never invoke it, '
    + 'however an earlier version used it for company posts and content search');
  assert.match(body, /`post_keyword_search` is not used by this\s+skill/,
    'the skill must say out loud that the old route is not used');
  assert.ok(!/gates\.yaml:disabled\.post_keyword_search/.test(body),
    'nothing disables it any more; the skill must not cite a reason that no longer exists');
});

test('profile_activities is not owned here, not invoked, and named as deliberately absent', () => {
  assert.ok(!owned.has('profile_activities'),
    'endpoint-owners.yaml does not give profile_activities to this skill');
  assert.ok(!/`profile_activities\(/.test(body),
    'profile_activities is per-result on a count absent from the response and page-gated; '
    + 'an earlier version fanned it across execs every cycle, which is the worst possible '
    + 'endpoint to put on a clock');
  assert.ok(/profile_activities/.test(body),
    'the skill must state why it is absent, or a future author will add it back');
  // It is in always_ask AND in unbounded_endpoints — the two facts that make it wrong here.
  assert.ok(gateValue(GATES, 'always_ask.endpoints').includes('profile_activities'));
  assert.ok(gateValue(GATES, 'unbounded_endpoints.endpoints').includes('profile_activities'));
});

test('the LLM hop is not in this skill (local inference)', () => {
  assert.ok(!owned.has('ai_enrich'), 'endpoint-owners.yaml does not give ai_enrich to this skill');
  assert.ok(!/`ai_enrich\(/.test(body), 'a local-inference skill must not invoke the paid LLM hop');
  assert.match(body, /Inference mode: local/i,
    'a local-inference skill states its inference mode and why');
});

test('the five page-gated watches are named as page-gated', () => {
  const pageGated = [...owned].filter(e => CATALOG.endpoints[e].pricing?.page_gated === true).sort();
  assert.deepEqual(pageGated,
    ['lead_search', 'linkedin_ad_search', 'linkedin_company_posts', 'linkedin_job_search', 'search_bing'],
    'the catalog decides which of this skill\'s endpoints are page-gated');
  assert.ok(/gates\.yaml:unbounded_endpoints\.endpoints/.test(body),
    'the skill must point at the gates list rather than restating which endpoints are unbounded');
  assert.ok(/gates\.yaml:unbounded_endpoints\.pages_before_confirm/.test(body)
    && /gates\.yaml:unbounded_endpoints\.hard_page_ceiling/.test(body),
    'a recurring skill running page-gated endpoints must cite both page-gate keys');
});

test('the one unverifiable watch is named as unverifiable on the plan', () => {
  const unverifiable = [...owned].filter(e => {
    const p = CATALOG.endpoints[e].pricing || {};
    return p.billing_field_present_in_response === false;
  }).sort();
  // 2026-09-17: the flag is evidence-derived now, and no recorded response carries a
  // charge, so this is every watch rather than one. The assertion that matters is
  // unchanged — the skill names the status on the plan — but the old single-name
  // deepEqual asserted a distinction the catalog no longer draws.
  assert.deepEqual(unverifiable, [...owned].sort(),
    'the catalog decides which charge cannot be read back; today that is all of them');
  assert.match(body, /google_search_scraper_sync[\s\S]{0,400}?estimated_unverifiable/,
    'law 4: a charge the response does not carry is reported estimated_unverifiable, and on a '
    + 'recurring watch it is reported that way every cycle');
});
