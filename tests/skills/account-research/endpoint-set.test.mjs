// tests/skills/account-research/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by nobody. It cannot see the other
// direction: a SKILL.md that quietly calls something it does not own, or that silently
// drops one of the twenty-three it is responsible for.
//
// This skill has the largest endpoint surface in the pack, so "drops one" is the likely
// failure and it is invisible in review. The set is asserted, not eyeballed.
//
// It also pins retired endpoint names that DO NOT EXIST, so a
// future port cannot quietly reintroduce them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const owned = ownedEndpoints();

test('the owners file assigns this skill the full 23-endpoint surface', () => {
  // Guards against a merge that quietly reassigns part of the surface to another skill.
  assert.deepEqual([...owned].sort(), [
    'crunchbase_company_scraper_sync',
    'enrich_company',
    'find_sitemap_urls',
    'google_maps_reviews_scraper_sync',
    'lead_search',
    'linkedin_ad_search',
    'linkedin_company_employees_search',
    'linkedin_company_posts',
    'meta_ads_library_scraper_sync',
    'post_activities',
    'post_details',
    'profile_activities',
    'profile_social_metrics',
    'similarweb_scraper_sync',
    'web_emails',
    'web_json_ld',
    'web_meta_tags',
    'web_pixels',
    'web_scrape',
    'web_sitemap',
    'web_social_links',
    'web_tech_stack',
    'website_intelligence',
  ]);
  assert.equal(owned.size, 23, 'account-research owns 23 endpoints, more than any other skill');
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

test('retired endpoint names that do not exist stay uninvoked', () => {
  const body = skillBody();
  // `ad_search` was a retired name for the LinkedIn ad library. There is no such
  // operationId in the pinned spec; the real one is `linkedin_ad_search`.
  assert.equal(CATALOG.endpoints.ad_search, undefined,
    'ad_search now exists in the catalog — re-check this assertion against the spec');
  assert.ok(!/`ad_search\(/.test(body), 'the SKILL.md invokes `ad_search(`, which is not a real endpoint');
  assert.ok(/`linkedin_ad_search\(/.test(body), 'the real LinkedIn ad endpoint must be the one invoked');
});

test('post_keyword_search is named as not used and never invoked', () => {
  const body = skillBody();
  assert.ok(!/`post_keyword_search\(/.test(body),
    'post_keyword_search is unclaimed and this skill must never invoke it, '
    + 'however an earlier version used it to read company posts');
  assert.match(body, /`post_keyword_search` is not used by this\s+skill/,
    'the skill must say out loud that the old route is not used, so a reader '
    + 'does not go looking for it');
  assert.doesNotMatch(body, /gates\.yaml:disabled\.post_keyword_search/,
    'nothing disables it any more; the skill must not cite a reason that no longer exists');
});

test('the LLM hop is not in this skill (local inference)', () => {
  const body = skillBody();
  assert.ok(!owned.has('ai_enrich'), 'endpoint-owners.yaml does not give ai_enrich to this skill');
  assert.ok(!/`ai_enrich\(/.test(body), 'a local-inference skill must not invoke the paid LLM hop');
  assert.match(body, /Inference mode: local/i,
    'a local-inference skill states its inference mode and why');
});
