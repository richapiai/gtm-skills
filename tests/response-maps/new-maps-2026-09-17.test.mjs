/**
 * The 21 maps added on 2026-09-17, and the reasoned refusals beside them.
 *
 * Eleven live recipe runs found these endpoints answering 2xx with real data and
 * arriving as a raw body because there was no `RESPONSE_MAPS` entry at all. Every one
 * of these assertions fails against the tree as it stood that morning, where
 * `RESPONSE_MAPS` held eight endpoints.
 *
 * `response-map-coverage.test.mjs` already enforces the invariants that make a map
 * trustworthy (every path is one the recording contains; every recorded scalar is
 * either read or declared unread; the recorded body really produces the columns). This
 * file pins the two things that file cannot see:
 *
 *   1. that these specific endpoints are mapped at all, so a later edit that quietly
 *      drops one is a failing build rather than a silent return to raw delivery;
 *   2. that the endpoints deliberately left unmapped are left unmapped FOR THE REASON
 *      GIVEN — an array body, a not-found recording, or no recording at all — so that
 *      the refusal is checkable instead of being a comment nobody re-reads.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RESPONSE_MAPS, RESPONSE_HEADLINE_COLUMNS, mapResponse } from '../../_lib/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE = path.join(ROOT, 'tests', 'fixtures', 'live');

const body = (ep) => JSON.parse(fs.readFileSync(path.join(LIVE, `${ep}.json`), 'utf8'));

/** endpoint -> one column a GTM user buys the call for, which the recording produces. */
const ADDED = {
  clean_domain: 'cleaned_domain',
  normalize_company: 'normalized_company_name',
  normalize_phone: 'phone_e164',
  distribute_leads: 'assigned_to',
  web_tech_stack: 'tech_stack_summary',
  web_pixels: 'pixels_found_count',
  web_meta_tags: 'page_title',
  web_json_ld: 'json_ld_type',
  web_scrape: 'page_title',
  web_sitemap: 'sitemap_url_count',
  find_sitemap_urls: 'sitemap_first_url',
  search_bing: 'search_top_url',
  search_google_trends: 'trend_top_rising_query',
  linkedin_ad_details: 'ad_id',
  youtube_channel: 'youtube_channel_id',
  youtube_channel_videos: 'youtube_latest_video_id',
  youtube_search: 'youtube_top_video_id',
  youtube_video: 'youtube_video_id',
  profile_social_metrics: 'follower_count',
  directory_yellowpages: 'business_name',
  website_intelligence: 'seo_score',
};

test('each endpoint added on 2026-09-17 is mapped and delivers its column off the recording', () => {
  for (const [endpoint, column] of Object.entries(ADDED)) {
    assert.ok(RESPONSE_MAPS[endpoint], `${endpoint} lost its map — it would go back to raw delivery`);
    assert.ok(RESPONSE_HEADLINE_COLUMNS[endpoint], `${endpoint} names no headline column`);
    const cols = mapResponse(endpoint, body(endpoint).body);
    assert.ok(
      Object.prototype.hasOwnProperty.call(cols, column),
      `${endpoint} was paid for and delivered no "${column}" column from its own recording`
    );
  }
});

test('a body-root path is never confused with an envelope path', () => {
  // The 2026-09-02 defect in miniature: `data.seo.title` is where web_meta_tags puts
  // the title, and a map that read `seo.title` would deliver nothing while reporting
  // success. Checked against the recording rather than asserted in prose.
  const cols = mapResponse('web_meta_tags', body('web_meta_tags').body);
  assert.equal(typeof cols.page_title, 'string');
  assert.ok(cols.page_title.length > 0);
  assert.equal(cols.canonical_url?.startsWith('http'), true);
});

// ---------------------------------------------------------------------------
// The refusals, each checked against the thing that justifies it.
// ---------------------------------------------------------------------------

test('an endpoint whose recorded body is a TOP-LEVEL ARRAY stays unmapped', () => {
  // `mapResponse` maps one object to one row. These answer N rows, which belongs to
  // the batch path, and the catalog publishes their keys at element level, so no
  // single-row map could address them. The refusal is checked, not asserted: if one
  // ever starts answering an object, this fails and the map becomes writable.
  const ARRAY_BODIED = [
    'enrich_profiles_bulk', 'enrich_companies_bulk', 'similarweb_scraper_sync',
    'google_maps_places_scraper_keyword', 'google_maps_places_scraper_sync_using_url',
    'google_search_scraper_sync', 'crunchbase_company_scraper_sync',
    'meta_ads_library_scraper_sync',
  ];
  for (const ep of ARRAY_BODIED) {
    assert.ok(Array.isArray(body(ep).body), `${ep}: the recorded body is no longer an array`);
    assert.ok(!RESPONSE_MAPS[ep], `${ep} is mapped, but a single-row map cannot read an array body`);
  }
});

test('an endpoint whose only recording is a MISS stays unmapped (law 2)', () => {
  // The recorded body carries the not-found envelope and nothing else, so any map
  // written from it would be inventing the hit shape — which is exactly how the
  // email_finder failure happened, one level up.
  const MISSES = {
    find_website_by_company_name: (b) => b.message === 'not found' && b.data?.Website === null,
    find_linkedin_url_by_email: (b) => b.data?.error?.status === 404,
    web_social_links: (b) => Object.keys(b.data?.links ?? {}).length === 0,
    web_emails: (b) => Array.isArray(b.data?.emails) && b.data.emails.length === 0,
  };
  for (const [ep, isMiss] of Object.entries(MISSES)) {
    assert.ok(isMiss(body(ep).body), `${ep}: the recording is no longer a miss — capture a hit and map it`);
    assert.ok(!RESPONSE_MAPS[ep], `${ep} is mapped off a not-found body`);
  }
});

test('an endpoint with no USABLE recording stays unmapped', () => {
  // Not "no 2xx" — three of these did answer. `geo_id_search` answered
  // `{elements: [], pagination: null, error: null}`, `google_maps_reviews_scraper_sync`
  // answered `[]`, and the other two were refused outright. An answer carrying no
  // readable scalar is no evidence about response shape, which is why the live digest
  // has no row for any of them and why nothing here may be mapped from them.
  const DIGEST = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'live-field-maps.json'), 'utf8'));
  const NO_EVIDENCE = [
    'geo_id_search', 'linkedin_ad_search', 'google_ad_transparency_scraper_sync',
    'google_maps_reviews_scraper_sync', 'slack_channel_members',
  ];
  for (const ep of NO_EVIDENCE) {
    assert.ok(!DIGEST.endpoints[ep],
      `${ep} now has a recorded shape in the digest — write its map`);
    assert.ok(!RESPONSE_MAPS[ep], `${ep} is mapped with no recorded shape behind it`);
  }
});

test('search_reference_data stays unmapped: a facet list is not a fact about a row', () => {
  const b = body('search_reference_data').body;
  assert.ok(Array.isArray(b.industries), 'it answers taxonomy lists, not row fields');
  assert.ok(!RESPONSE_MAPS.search_reference_data,
    '"the first industry in LinkedIn\'s reference list" is not a column on a contact');
});
