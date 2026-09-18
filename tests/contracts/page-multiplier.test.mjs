// tests/contracts/page-multiplier.test.mjs
//
// Endpoints that defeat the page gate from inside the request body.
//
// The page gate counts REQUESTS. Some endpoints take a field that multiplies
// how many pages the provider walks per request, so the gate fires once,
// hard_page_ceiling counts one, and the bill covers everything returned.
//
// Two were found independently by two different reviews on the same day, which
// is what turns a quirk into a class:
//
//   directory_yellowpages.max_pages   one request scrapes N pages
//   google_search_scraper_sync.limit  "Maximum number of result PAGES to fetch"
//
// The second is the trap worth the test. `limit` means "max results to return"
// on all five sibling scrapers and "max PAGES" on this one alone, while
// x-pricing charges credits_per_result. Someone who learned the field on
// google_maps_places_scraper_keyword and writes limit: 100 here is asking for
// roughly ten times what they think — and billing_field_present_in_response is
// false, so the receipt cannot correct them afterwards.
//
// This test derives the hazard FROM THE SPEC rather than from a list somebody
// maintains, so the next endpoint with this shape is caught when the spec moves
// rather than when a bill arrives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const catalog = JSON.parse(readFileSync(join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));
const gates = parseYaml(readFileSync(join(ROOT, '_lib', 'gates.yaml'), 'utf8'));
const spec = parseYaml(readFileSync(join(ROOT, 'spec', 'openapi.yaml'), 'utf8'));

/** Every operation's request-body properties, keyed by operationId. */
function requestProperties () {
  const out = {};
  for (const ops of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(ops ?? {})) {
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      const schema = op.requestBody?.content?.['application/json']?.schema ?? {};
      out[op.operationId] = schema.properties ?? {};
    }
  }
  return out;
}

const PROPS = requestProperties();

/**
 * A field whose description bounds the NUMBER OF PAGES walked in one request.
 *
 * Three shapes mention "page" and only one is the hazard:
 *
 *   "Maximum number of result PAGES to fetch"  → multiplier. One request, N
 *                                                pages, charged per result.
 *                                                THIS is what we are hunting.
 *   "Number of items PER PAGE"                 → page SIZE. Bounds one page,
 *                                                which is the opposite; the
 *                                                total is then bounded by the
 *                                                page gate counting requests.
 *   "Page number to fetch"                     → a cursor. Buys one page.
 *
 * The first draft of this predicate matched all three and reported
 * people_search and profile_activities, both of which are page-SIZE fields on
 * endpoints already in unbounded_endpoints and therefore already controlled.
 * Reporting them would have been worse than useless: two false alarms teach the
 * next reader to skim this test's output.
 */
function pageMultiplierFields (endpoint) {
  const props = PROPS[endpoint] ?? {};
  const hits = [];
  for (const [name, def] of Object.entries(props)) {
    const desc = String(def?.description ?? '');
    if (!/\bpages?\b/i.test(desc)) continue;
    if (name === 'page') continue;
    if (/\bper\s+page\b/i.test(desc)) continue;                 // page size
    if (/^\s*(the\s+)?page\s+(number|index)/i.test(desc)) continue; // cursor
    if (!/\b(max|maximum|number of|up to)\b/i.test(desc)) continue;
    hits.push({ name, desc });
  }
  return hits;
}

const declared = gates.request_page_multipliers?.endpoints ?? {};

test('the two known page multipliers are declared and clamped', () => {
  for (const ep of ['directory_yellowpages', 'google_search_scraper_sync']) {
    assert.ok(declared[ep], `${ep} multiplies pages from inside the request body and must be clamped`);
    assert.ok(declared[ep].field, `${ep} must name the field that multiplies`);
    assert.ok(Number.isInteger(declared[ep].clamp) && declared[ep].clamp >= 1,
      `${ep} needs an integer clamp of at least 1`);
  }
});

test('each declared multiplier field actually exists in the spec', () => {
  // A clamp on a field the API does not have is a control that silently does
  // nothing — the worst kind, because the config looks like protection.
  for (const [ep, cfg] of Object.entries(declared)) {
    const props = PROPS[ep];
    assert.ok(props, `${ep} is clamped but is not an operation in the pinned spec`);
    assert.ok(Object.prototype.hasOwnProperty.call(props, cfg.field),
      `${ep}.${cfg.field} is clamped but that field does not exist in the request body`);
  }
});

test('no per-result endpoint hides an UNDECLARED page multiplier', () => {
  // The derived half. Any endpoint charged per result, carrying a request field
  // whose description bounds pages, must be declared above — otherwise the
  // charge scales with pages while the user reads the field as a result count.
  const missed = [];
  for (const [name, def] of Object.entries(catalog.endpoints)) {
    if (def.pricing?.model !== 'per_result') continue;
    if (declared[name]) continue;
    for (const f of pageMultiplierFields(name)) {
      missed.push(`${name}.${f.name} — "${f.desc}"`);
    }
  }
  assert.deepEqual(missed, [],
    'these are charged per result and take a request field that bounds PAGES, but are not '
    + 'declared in gates.yaml:request_page_multipliers, so one request can multiply the bill '
    + 'while the page gate counts one call:\n  ' + missed.join('\n  '));
});

test('google_search_scraper_sync is the odd one out among its siblings', () => {
  // Pins the specific confusion, because it is the reason a reasonable person
  // gets this wrong: five sibling scrapers use `limit` for RESULTS and this one
  // uses it for PAGES. If a future spec revision makes them consistent, this
  // fails and the clamp can be reconsidered.
  const siblings = [
    'google_maps_places_scraper_keyword',
    'google_maps_places_scraper_sync_using_url',
    'google_maps_reviews_scraper_sync',
    'google_ad_transparency_scraper_sync',
    'meta_ads_library_scraper_sync',
  ];
  for (const s of siblings) {
    const desc = String(PROPS[s]?.limit?.description ?? '');
    assert.ok(desc, `${s} should still have a limit field`);
    assert.doesNotMatch(desc, /\bpages?\b/i,
      `${s}.limit now mentions pages — it may have joined the multiplier class`);
  }
  assert.match(String(PROPS.google_search_scraper_sync?.limit?.description ?? ''), /\bpages?\b/i,
    'google_search_scraper_sync.limit no longer bounds pages — re-check its clamp');
});

test('a clamped endpoint whose charge is unverifiable is the worst case, and is clamped hardest', () => {
  // When the charge never appears in the response, the receipt cannot correct a
  // user who over-asked. There is no after-the-fact remedy, so the before-the-
  // fact clamp is the only control.
  for (const [ep, cfg] of Object.entries(declared)) {
    const p = catalog.endpoints[ep]?.pricing;
    if (!p || p.billing_field_present_in_response !== false) continue;
    assert.equal(cfg.clamp, 1,
      `${ep} charges per result with no billing field in the response, so an over-large `
      + `${cfg.field} can never be reconciled afterwards. Its clamp must stay 1.`);
  }
});
