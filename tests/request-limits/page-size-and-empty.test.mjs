// Two money defects the 2026-09-17 live runs found.
//
//   3. `--page-size` was a PRICING knob and nothing else — it was never put on the
//      wire, for any endpoint. LIVE: `lead_search --page-size 10` planned 15 credits
//      (10 base + 0.5 x 10), the API answered 25 results and billed 22.5. The spec says
//      why: lead_search declares `page` and `session_id` and NO size field at all, so
//      there was never a parameter to send. The bill beat the plan by 50% and the walk
//      would have bought nineteen more pages at that price under the same approval.
//
//   4. A row whose required column was PRESENT BUT EMPTY was sent anyway. Only the
//      server's 422 saved the credits, six times over. A MISSING column was correctly
//      refused for free — so the two shapes of the same fact were priced differently.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson, okWithoutBillingField } from '../helpers/index.mjs';
import { CATALOG, GATES, fixture, apiOver, fakeHttp } from './helpers.mjs';
import {
  runSearch, planSearch, buildRequestFor, pageSizeFieldFor, overdelivered, overdeliveryTolerance,
} from '../../_lib/run.mjs';
import { buildRequest } from '../../_lib/client.mjs';
import { nullCache } from '../../_lib/cache.mjs';

const ep = (name) => CATALOG.endpoints[name];

// ---------------------------------------------------------------------------
// 3a. only send a page-size parameter the endpoint actually declares
// ---------------------------------------------------------------------------

test('the catalog now says which request fields an endpoint declares, and which one sizes a page', () => {
  // Read off the pinned spec by the catalog generator, not typed here.
  assert.deepEqual(ep('web_emails').request_fields, ['cache', 'max_pages', 'url']);
  assert.ok(ep('lead_search').request_fields.includes('page'));

  assert.equal(pageSizeFieldFor(ep('people_search'), GATES, 'people_search'), 'limit');
  assert.equal(pageSizeFieldFor(ep('post_activities'), GATES, 'post_activities'), 'limit');
  assert.equal(pageSizeFieldFor(ep('lead_search'), GATES, 'lead_search'), null,
    'lead_search has NO page-size control — the measured defect');
  // `max_pages` bounds PAGES, not results, and is the clamped multiplier class.
  assert.equal(pageSizeFieldFor(ep('web_emails'), GATES, 'web_emails'), null);
});

test('--page-size is SENT when the endpoint declares the field', () => {
  const planned = planSearch({
    runId: 'ps-1', endpoint: 'people_search', params: { job_title: 'CTO' },
    catalog: CATALOG, gates: GATES, cache: nullCache('t'), pages: 2, pageSize: 10,
  });
  for (const p of planned.prepared) {
    assert.equal(p.request.limit, 10, 'the number the caller approved is the number on the wire');
  }
  assert.equal(planned.plan.totals.page_size, 10);
  assert.equal(planned.plan.totals.page_size_basis, 'explicit');
  assert.equal(planned.plan.totals.page_size_field, 'limit');
  assert.deepEqual(planned.notes, []);
});

test('--page-size is NOT sent when the endpoint declares no such field, and the plan says so', () => {
  const planned = planSearch({
    runId: 'ps-2', endpoint: 'lead_search', params: { search_query: 'CTO' },
    catalog: CATALOG, gates: GATES, cache: nullCache('t'), pages: 2, pageSize: 10,
  });
  for (const p of planned.prepared) {
    for (const f of ['limit', 'page_size', 'per_page', 'max_results']) {
      assert.equal(p.request[f], undefined, `${f} is not a field lead_search declares`);
    }
  }
  assert.equal(planned.plan.totals.page_size_field, null);
  assert.equal(planned.plan.totals.page_size_basis, 'server_choice',
    'the size is the server\'s choice and the plan must not print it as a bound');
  const note = planned.notes.find((n) => n.includes('no page-size request field'));
  assert.ok(note, JSON.stringify(planned.notes));
  assert.match(note, /server's choice/);
});

// ---------------------------------------------------------------------------
// 3b. after page 1, re-price the rest of the walk from the size the response reported
// ---------------------------------------------------------------------------

/** The recorded lead_search paging shape: 25 a page, whatever was asked for. */
const TWENTY_FIVE = () => okWithoutBillingField({
  elements: Array.from({ length: 25 }, (_, i) => ({ id: `e${i}` })),
  pagination: { pageSize: 25, pageNumber: 1, totalPages: 100, totalElements: 3476992 },
});

test('the walk re-prices from the size the API reported, not the size that was planned', async (t) => {
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'lead_search', params: { search_query: 'CTO' }, pages: 3, pageSize: 25,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: TWENTY_FIVE })), budget: 500,
    confirm: async () => true, stopOnShortPage: false, runId: 'ps-3',
  });
  assert.equal(res.search.page_size, 25);
  assert.equal(res.search.page_size_basis, 'response',
    'the number in force after page 1 comes from the response, not the plan');
  // 3 x (10 base + 0.5 x 25) = 3 x 22.5
  assert.equal(res.ledger_totals.ledger_total, 67.5);
});

// ---------------------------------------------------------------------------
// 3c. a page that delivers materially more than the plan priced STOPS the walk
// ---------------------------------------------------------------------------

test('the measured shape: a plan of 10 a page meets a page of 25, and the walk stops', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: TWENTY_FIVE });
  const res = await runSearch({
    endpoint: 'lead_search', params: { search_query: 'CTO' }, pages: 20, pageSize: 10,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 5000, confirm: async () => true,
    stopOnShortPage: false, runId: 'ps-4',
  });

  assert.equal(res.http_calls, 1, 'nineteen pages at a price nobody approved were NOT bought');
  assert.equal(res.search.exhausted, true);
  assert.equal(res.search.exhausted_basis, 'page_size_overdelivery');
  const note = res.notes.find((n) => n.includes('delivered 25 result(s) against a planned 10'));
  assert.ok(note, JSON.stringify(res.notes));
  assert.match(note, /was NOT bought/);
  assert.match(note, /--page-size 25/, 'a stop the user cannot act on is just a failure');
});

test('a page inside the tolerance does NOT stop the walk', async (t) => {
  const { tree } = fixture(t);
  // 25 planned, 27 delivered: +8%, inside the 20% the policy allows.
  const slightly = () => okWithoutBillingField({
    elements: Array.from({ length: 27 }, (_, i) => ({ id: `e${i}` })),
  });
  const res = await runSearch({
    endpoint: 'lead_search', params: { search_query: 'CTO' }, pages: 3, pageSize: 25,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: slightly })), budget: 5000,
    confirm: async () => true, stopOnShortPage: false, runId: 'ps-5',
  });
  assert.equal(res.http_calls, 3);
  assert.equal(res.search.exhausted, false);
});

test('the tolerance is a gate key, and a missing key is zero tolerance (law 5)', () => {
  assert.equal(overdeliveryTolerance(GATES), 0.2);
  assert.equal(overdeliveryTolerance({}), 0, 'a missing key reads as STOP, not as "no gate"');
  assert.equal(overdelivered(10, 12, 0.2), false);
  assert.equal(overdelivered(10, 13, 0.2), true);
  assert.equal(overdelivered(10, 11, 0), true, 'with no policy, any over-delivery stops');
  assert.equal(overdelivered(null, 500, 0.2), false, 'an unknown plan cannot be exceeded');
});

// ---------------------------------------------------------------------------
// 4. an empty required value is refused exactly as a missing one is
// ---------------------------------------------------------------------------

const MISSING = 'insufficient input for web_emails; missing required field(s): url';

test('a REQUIRED field that is empty is refused with the same words as a missing one', () => {
  const refused = (record, params = {}) => buildRequestFor('web_emails', record, CATALOG, { params });
  assert.equal(refused({}).reason, MISSING);
  for (const empty of ['', '   ', '\t', 'not_found', 'NOT_FOUND', 'not_verifiable', 'not_applicable']) {
    const r = refused({ url: empty });
    assert.equal(r.ok, false, `url: ${JSON.stringify(empty)} reached the wire`);
    assert.equal(r.reason, MISSING, 'the same fact must read the same way');
  }
  // …and the same through --param, which is the other way a value arrives.
  assert.equal(refused({}, { url: '' }).reason, MISSING);
});

test('the hand-written contracts refuse an empty required value too — the 25-credit floor', () => {
  // client.buildRequest is reached directly by the enrichment executor and by the
  // cache key function, so a guard in buildRequestFor alone left both open. LIVE: an
  // `email` column reading `not_found` bought an email_verifier call on that string.
  for (const empty of ['', '  ', 'not_found', 'not_verifiable']) {
    assert.equal(buildRequest('email_verifier', { email: empty }).ok, false, JSON.stringify(empty));
    assert.equal(buildRequest('enrich_profile', { url: empty }).ok, false, JSON.stringify(empty));
    assert.equal(buildRequest('phone_finder', { linkedin_url: empty }).ok, false, JSON.stringify(empty));
  }
  assert.equal(buildRequest('email_verifier', { email: '' }).reason,
    buildRequest('email_verifier', {}).reason, 'empty and missing read identically');
  // An array of empty identifiers is not a batch.
  assert.equal(buildRequest('enrich_profiles_bulk', { urns: ['', '  ', 'not_found'] }).ok, false);
  assert.deepEqual(buildRequest('enrich_profiles_bulk', { urns: ['a', '', 'b'] }).payload.urns, ['a', 'b']);
});

test('an OPTIONAL field that is empty is dropped, and the call still goes', () => {
  const r = buildRequestFor('web_emails', { url: 'https://example.invalid/', max_pages: '' },
    CATALOG, { fields: ['max_pages'] });
  assert.equal(r.ok, true);
  assert.equal('max_pages' in r.payload, false, 'an empty optional is absent, not an empty string');
  assert.deepEqual(r.payload, { url: 'https://example.invalid/' });

  const missing = buildRequestFor('web_emails', { url: 'https://example.invalid/' },
    CATALOG, { fields: ['max_pages'] });
  assert.deepEqual(missing.payload, r.payload, 'empty and missing build the same request');
});

test('an empty required value costs ZERO http calls over a whole list', async (t) => {
  // JSONL, not CSV: a CSV cannot tell an empty cell from a blank line, and the four
  // shapes below are exactly the distinction under test.
  const { tree } = fixture(t);
  const input = path.join(tree.root, 'empty.jsonl');
  fs.writeFileSync(input, [{ url: '' }, { url: '   ' }, { url: 'not_found' }, { note: 'no url column at all' }]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { runCall } = await import('../../_lib/run.mjs');
  const res = await runCall({
    endpoint: 'web_emails', input, root: tree.root, dir: 'gtm',
    catalog: CATALOG, gates: GATES, budget: 50,
    api: apiOver(fakeHttp({ fallback: () => { throw new Error('ZERO-CALL VIOLATION'); } })),
    confirm: async () => { throw new Error('nothing to approve'); }, runId: 'ps-6',
  });
  assert.equal(res.calls_made, 0);
  assert.equal(res.plan.totals.credits_estimated, 0, 'four 2-credit calls that used to be planned');
  assert.equal(res.skip_reasons.web_emails[MISSING], 4);
});

test('a row that DOES carry the required value is still callable', async (t) => {
  const { tree, input } = fixture(t, { rows: [{ url: 'https://example.invalid/' }], name: 'ok.csv' });
  const { runCall } = await import('../../_lib/run.mjs');
  const res = await runCall({
    endpoint: 'web_emails', input, root: tree.root, dir: 'gtm',
    catalog: CATALOG, gates: GATES, budget: 50, confirm: async () => true, runId: 'ps-7',
    api: apiOver(fakeHttp({ fallback: () => okJson({ data: { emails: [] } }) })),
  });
  assert.equal(res.http_calls, 1);
});
