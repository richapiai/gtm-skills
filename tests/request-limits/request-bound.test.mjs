// REGRESSION: per-result estimates ignored the request's own bound, which disarmed
// `session_budget.fractions.single_call_confirm`.
//
// `planRowCall` derived its result count from ARRAY LENGTHS only, so a scalar `limit`
// in the payload was invisible and the plan fell back to
// gates.yaml:unbounded_endpoints.assumed_results_per_page.
//
// MEASURED: `richapi search people_search --param limit=1000 --pages 1` planned at 2.5
// credits against a real charge of 0.1 x 1000 = 100. Zero gates fired — the page gate
// saw one page, and `single_call_confirm` (0.25 of the session budget) was evaluated
// against 2.5 rather than 100, which is precisely the "one huge unbounded search on
// call #1" that gate exists to catch. `--page-size 1000` priced it correctly all along,
// so the CLI had the knob; nothing tied it to `--param limit`.
//
// The last test derives the field-name set FROM THE PINNED SPEC, so a spec revision
// that introduces another spelling of "how many results one call returns" fails here
// rather than at a bill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { CATALOG, GATES, REPO, fixture, noCache, noStore } from './helpers.mjs';
import { planRowCall, planSearch, requestBound, RESULT_BOUND_FIELDS, runSearch } from '../../_lib/run.mjs';
import { createSession, setBudget, checkCall, assumedResultsPerPage, CONFIRM } from '../../_lib/gates.mjs';

const ASSUMED = assumedResultsPerPage(GATES);

test('the measured case: people_search --param limit=1000 --pages 1 plans at 100, not 2.5', () => {
  const planned = planSearch({
    runId: 'r', endpoint: 'people_search', params: { limit: 1000, title: 'CTO' },
    catalog: CATALOG, gates: GATES, cache: noCache, pages: 1,
  });
  assert.equal(planned.expected, 1000, 'the request\'s own bound is the count basis');
  assert.equal(planned.plan.totals.credits_estimated, 100,
    '0.1 credits per result x the 1000 results the request asked for. It planned at 2.5 '
    + '(the 25-result gate assumption) while the real charge was 100');

  // And the assumption is still what answers when the caller states no bound.
  const unhinted = planSearch({
    runId: 'r', endpoint: 'people_search', params: { title: 'CTO' },
    catalog: CATALOG, gates: GATES, cache: noCache, pages: 1,
  });
  assert.equal(unhinted.expected, ASSUMED);
});

test('pricing the bound is what re-arms single_call_confirm', () => {
  // The gate this bug disarmed, exercised end to end against the two numbers.
  const fraction = GATES.session_budget.fractions.single_call_confirm;
  const budget = 200;
  const entry = CATALOG.endpoints.people_search;

  const armed = (credits) => {
    const s = createSession({ gates: GATES, runId: 'r' });
    setBudget(s, budget);
    const d = checkCall(s, { endpoint: 'people_search', catalogEntry: entry, estimatedCredits: credits, page: 1 });
    return d.decision;
  };

  assert.ok(100 >= budget * fraction, 'the real 100-credit charge is over a quarter of a 200 budget');
  assert.ok(2.5 < budget * fraction, 'the old 2.5-credit estimate was nowhere near it');
  assert.equal(armed(2.5), 'allow', 'the old estimate waved the call straight through');
  assert.equal(armed(100), CONFIRM,
    'priced honestly, the same call asks — which is the entire purpose of the gate');
});

test('an explicit --page-size still wins over the request bound', () => {
  const planned = planSearch({
    runId: 'r', endpoint: 'people_search', params: { limit: 1000 },
    catalog: CATALOG, gates: GATES, cache: noCache, pages: 1, pageSize: 40,
  });
  assert.equal(planned.expected, 40,
    'the caller overriding their own request is still the most specific statement there is');
});

test('planRowCall reads a scalar bound as well as an array length', () => {
  const bounded = planRowCall({
    runId: 'r', endpoint: 'google_maps_places_scraper_keyword', records: [{}],
    catalog: CATALOG, gates: GATES, store: noStore, cache: noCache,
    params: { search_query: 'dentist', limit: 50 },
  });
  assert.equal(bounded.expected, 50);
  assert.equal(bounded.plan.totals.credits_estimated, 5, '0.1 x 50');

  const unhinted = planRowCall({
    runId: 'r', endpoint: 'google_maps_places_scraper_keyword', records: [{}],
    catalog: CATALOG, gates: GATES, store: noStore, cache: noCache,
    params: { search_query: 'dentist' },
  });
  assert.equal(unhinted.expected, ASSUMED);
});

test('an explicit --expect still overrides the request bound', () => {
  const planned = planRowCall({
    runId: 'r', endpoint: 'google_maps_places_scraper_keyword', records: [{}],
    catalog: CATALOG, gates: GATES, store: noStore, cache: noCache,
    params: { search_query: 'x', limit: 50 }, expectedResults: 12,
  });
  assert.equal(planned.expected, 12);
});

test('an array length still wins where it is the larger, honest bound', () => {
  // enrich_profiles_bulk takes `urns`, and that list IS the count. The rule is "the
  // larger of the two", so neither source of truth can be used to understate a plan.
  const urns = Array.from({ length: 30 }, (_, i) => `urn:li:person:${i}`);
  const planned = planRowCall({
    runId: 'r', endpoint: 'enrich_profiles_bulk', records: [{}],
    catalog: CATALOG, gates: GATES, store: noStore, cache: noCache, params: { urns },
  });
  assert.equal(planned.expected, 30);
});

test('a flat-priced endpoint is never handed a result count', () => {
  const planned = planRowCall({
    runId: 'r', endpoint: 'search_bing', records: [{}],
    catalog: CATALOG, gates: GATES, store: noStore, cache: noCache,
    params: { query: 'x', limit: 50 },
  });
  assert.equal(CATALOG.endpoints.search_bing.pricing.model, 'flat');
  assert.equal(planned.expected, null,
    'a flat endpoint is one credit per CALL — multiplying by a result count invents a '
    + 'charge that cannot happen');
});

test('a PAGE multiplier is never mistaken for a result count', () => {
  // `google_search_scraper_sync.limit` bounds PAGES, not results, and is clamped. Using
  // it as a result count would price 1 page as 1 result and understate again — the same
  // error in the opposite direction.
  const cfg = GATES.request_page_multipliers.endpoints.google_search_scraper_sync;
  assert.equal(requestBound('google_search_scraper_sync', { search_query: 'x', limit: cfg.clamp }, GATES), null);

  const planned = planRowCall({
    runId: 'r', endpoint: 'google_search_scraper_sync', records: [{}],
    catalog: CATALOG, gates: GATES, store: noStore, cache: noCache,
    params: { search_query: 'x', limit: 100 },
  });
  assert.equal(planned.expected, ASSUMED,
    'a clamped page multiplier falls back to the stated assumption, not to "one result"');
});

test('requestBound ignores a zero, a negative and a non-number', () => {
  for (const bad of [0, -5, 'lots', null, undefined, {}, []]) {
    assert.equal(requestBound('people_search', { limit: bad }, GATES), null, `limit: ${JSON.stringify(bad)}`);
  }
  assert.equal(requestBound('people_search', { limit: '250' }, GATES), 250,
    'the CLI hands params through as strings, so a numeric string is a number');
});

test('the end-to-end charge matches the plan the user approved', async (t) => {
  const { tree } = fixture(t);
  const rows = Array.from({ length: 1000 }, (_, i) => ({ id: i }));
  const calls = [];
  const api = {
    callCount: 0,
    async post (endpoint, payload) {
      calls.push({ endpoint, payload });
      this.callCount += 1;
      return { status: 200, body: { elements: rows, numberOfElements: rows.length } };
    },
    requireKey () {},
  };

  const res = await runSearch({
    endpoint: 'people_search', params: { limit: 1000, title: 'CTO' }, pages: 1,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api, budget: 1000, confirm: async () => true,
  });

  assert.equal(res.plan.totals.credits_estimated, 100);
  assert.equal(res.ledger_totals.ledger_total, 100,
    'the plan and the bill must agree; understating the plan is wrong in the direction '
    + 'that hides itself');
});

// ---------------------------------------------------------------------------
// The derived half: the field-name set cannot quietly go stale
// ---------------------------------------------------------------------------

test('no per-result endpoint in the spec bounds its results by a name we do not read', () => {
  const spec = parseYaml(readFileSync(join(REPO, 'spec', 'openapi.yaml'), 'utf8'));
  const declared = GATES.request_page_multipliers.endpoints;

  const props = {};
  for (const ops of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(ops ?? {})) {
      if (!op || typeof op !== 'object' || !op.operationId) continue;
      props[op.operationId] = op.requestBody?.content?.['application/json']?.schema?.properties ?? {};
    }
  }

  // "How many THINGS come back from one call", as the spec words it. Page counts are
  // excluded on purpose: they are the multiplier class, they are clamped, and a page is
  // not a result. Filters like `employee_size_end` ("Maximum employee count") are
  // excluded because they bound the QUERY, not the response.
  const RETURNED = /\b(results?|items?|places?|reviews?|urls?|members?|leads?|profiles?|companies|posts?)\b/i;
  const BOUNDS = /\b(max|maximum|number of|up to)\b/i;
  const PER_PAGE = /\bper\s+page\b/i;
  const RETURNS = /\b(to\s+(return|fetch|scrape|crawl)|returned)\b/i;

  const missed = [];
  for (const [name, def] of Object.entries(CATALOG.endpoints)) {
    const model = def.pricing?.model;
    if (model !== 'per_result' && model !== 'base_plus_per_result') continue;
    for (const [field, schema] of Object.entries(props[name] ?? {})) {
      const type = schema?.type;
      if (type !== 'integer' && type !== 'number') continue;
      const desc = String(schema?.description ?? '');
      if (/\bpages?\b/i.test(desc)) continue;                       // multiplier or cursor
      if (!RETURNED.test(desc)) continue;                            // a filter, not a bound
      if (!PER_PAGE.test(desc) && !(BOUNDS.test(desc) && RETURNS.test(desc))) continue;
      if (RESULT_BOUND_FIELDS.includes(field)) continue;
      if (declared[name]?.field === field) continue;
      missed.push(`${name}.${field} — "${desc}"`);
    }
  }

  assert.deepEqual(missed, [],
    'these endpoints are charged per result and take a request field that bounds how many\n'
    + 'results one call returns, but _lib/run.mjs:RESULT_BOUND_FIELDS does not know the name.\n'
    + 'A plan that cannot see the bound falls back to the 25-result gate assumption and\n'
    + 'understates the bill — which is how single_call_confirm got disarmed the first time:\n  '
    + missed.join('\n  ') + '\n');
});

test('every name we read really does appear on a per-result endpoint, or is a plain synonym', () => {
  // The inverse: the set must not grow into a grab-bag whose members shadow unrelated
  // numeric fields. `limit` is the one the spec actually uses today.
  assert.ok(RESULT_BOUND_FIELDS.includes('limit'));
  assert.ok(RESULT_BOUND_FIELDS.length <= 6,
    'keep this set small — every extra name is a numeric field that could be misread as '
    + 'a result count on some endpoint nobody checked');
  assert.equal(RESULT_BOUND_FIELDS.includes('page'), false, 'a cursor is not a bound');
  assert.equal(RESULT_BOUND_FIELDS.includes('max_pages'), false, 'a page count is not a result count');
});
