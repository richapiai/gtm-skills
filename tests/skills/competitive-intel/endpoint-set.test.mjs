// tests/skills/competitive-intel/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by nobody. It cannot see the
// other direction: a SKILL.md that quietly calls something it does not own, or silently
// drops one of the fifteen it is responsible for.
//
// This is the second-largest surface in the pack, so "drops one" is the likely failure
// and it is invisible in review. The set is asserted, not eyeballed.
//
// It also pins every retired endpoint name THAT DOES NOT EXIST. Two sibling skills
// were caught calling operationIds nobody had checked against the spec; this skill
// once did it too, so the guard is explicit.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const BODY = skillBody();
const owned = ownedEndpoints();

test('the owners file assigns this skill the full 15-endpoint surface', () => {
  assert.deepEqual([...owned].sort(), [
    'google_ad_transparency_scraper_sync',
    'linkedin_ad_details',
    'linkedin_ad_search',
    'linkedin_company_posts',
    'meta_ads_library_scraper_sync',
    'profile_activities',
    'search_google_trends',
    'similarweb_scraper_sync',
    'web_pixels',
    'web_tech_stack',
    'website_intelligence',
    'youtube_channel',
    'youtube_channel_videos',
    'youtube_search',
    'youtube_video',
  ]);
  assert.equal(owned.size, 15, 'competitive-intel owns 15 endpoints, the second-largest set in the pack');
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(BODY);
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(BODY)) {
    assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invokedEndpoints(BODY)) {
    assert.ok(!(name in (OWNERS.unclaimed || {})),
      `${name} is unclaimed (${OWNERS.unclaimed?.[name]}) and must not be invoked`);
    assert.notEqual(CATALOG.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default (${CATALOG.endpoints[name].pricing?.disabled_reason})`);
  }
});

test('every retired endpoint name that does not exist stays uninvoked', () => {
  // An earlier version's first step called `ad_search`, that step's tail called `ad_details`,
  // and its fourth step called `enrich_profile` — an endpoint this skill does not own.
  // None of those names is an operationId in the pinned spec except the last.
  for (const fake of ['ad_search', 'ad_details', 'ad_library', 'tech_stack', 'pixels']) {
    assert.equal(CATALOG.endpoints[fake], undefined,
      `${fake} now exists in the catalog — re-check this assertion against the spec`);
    assert.ok(!new RegExp(`\`${fake}\\(`).test(BODY),
      `the SKILL.md invokes \`${fake}(\`, which is not a real endpoint`);
  }
  // The real names, which must be the ones invoked.
  for (const real of ['linkedin_ad_search', 'linkedin_ad_details', 'web_tech_stack', 'web_pixels']) {
    assert.ok(CATALOG.endpoints[real], `${real} is missing from the catalog`);
    assert.ok(new RegExp(`\`${real}\\(`).test(BODY), `${real} is the real endpoint and is never invoked`);
  }
});

test('endpoints owned by OTHER skills are not reached for here', () => {
  // An earlier version ran `enrich_profile` on named executives. It belongs to
  // /enrich-waterfall, /inbound and /call-intel; a competitive read that enriches
  // people has quietly become a prospecting run with no suppression screen behind it.
  for (const e of ['enrich_profile', 'enrich_company', 'lead_search',
    'linkedin_company_employees_search', 'email_finder', 'ai_enrich']) {
    assert.ok(!owned.has(e), `${e} is now owned by ${SKILL} — re-read the tier design`);
    assert.ok(!new RegExp(`\`${e}\\(`).test(BODY), `${SKILL} invokes ${e}, which it does not own`);
  }
});

test('post_keyword_search is named as not used and never invoked', () => {
  assert.ok(!/`post_keyword_search\(/.test(BODY),
    'post_keyword_search is unclaimed and this skill must never invoke it, '
    + 'however an earlier version used it as the main route to company content');
  assert.match(BODY, /`post_keyword_search` is not\s+used by this skill/,
    'the skill must say out loud that the old route is not used, so a reader '
    + 'does not go looking for it');
  assert.ok(!(('post_keyword_search') in OWNERS.endpoints),
    'post_keyword_search is unclaimed: no skill searches posts by keyword yet');
  assert.ok('post_keyword_search' in OWNERS.unclaimed);
});
