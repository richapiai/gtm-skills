// Verify criteria for the credit ledger:
//   - NO FABRICATED ACTUAL is ever written: a response lacking the billing
//     field yields cost_status "estimated_unverifiable"
//   - a 402 body populates the balance at zero cost
//   - drift is reported at session end

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { trackedTmp } from '../helpers/index.mjs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import * as L from '../../_lib/ledger.mjs';
import { catalog, ep } from './fixture-catalog.mjs';

const SCHEMA = JSON.parse(readFileSync(
  fileURLToPath(new URL('../../_lib/contracts/ledger-line.schema.json', import.meta.url)), 'utf8'));

const tmp = () => trackedTmp('spend-gates-ledger-');
const newLedger = (opts = {}) => new L.Ledger({ dir: join(tmp(), 'gtm'), runId: 'run-test', ...opts });

/** Structural conformance to the FROZEN ledger-line contract. */
function assertConforms (line) {
  for (const k of SCHEMA.required) assert.ok(k in line, `line missing required key ${k}`);
  assert.equal(line.schema_version, 1);
  assert.ok(!Number.isNaN(Date.parse(line.ts)), 'ts is not a date-time');
  assert.equal(typeof line.endpoint, 'string');
  assert.equal(typeof line.credits_estimated, 'number');
  assert.ok(SCHEMA.properties.cost_status.enum.includes(line.cost_status));
  assert.ok(line.credits_actual === null || typeof line.credits_actual === 'number');
  assert.ok(line.result_count === null || Number.isInteger(line.result_count));
  assert.ok(line.balance_after === null || typeof line.balance_after === 'number');
  assert.ok(SCHEMA.properties.balance_source.enum.includes(line.balance_source));
  assert.ok(Number.isInteger(line.http_status));
  for (const k of Object.keys(line)) {
    assert.ok(k in SCHEMA.properties, `line carries key "${k}" that is not in the frozen contract`);
  }
}

// ---------------------------------------------------------------------------
// ESTIMATES — from x-pricing, before the call
// ---------------------------------------------------------------------------

test('estimates come from the catalog x-pricing shape, per model', () => {
  assert.equal(L.estimate(ep('enrich_company')).credits, 1);
  assert.equal(L.estimate(ep('enrich_company'), { batchSize: 30 }).credits, 30);
  assert.equal(L.estimate(ep('phone_finder')).credits, 25);
  assert.equal(L.estimate(ep('people_search'), { resultCount: 50 }).credits, 5);
  assert.equal(L.estimate(ep('lead_search'), { resultCount: 25 }).credits, 22.5);   // 10 base + 0.5 x 25
  assert.equal(L.estimate(ep('google_search_scraper_sync'), { resultCount: 10 }).credits, 10);
});

test('an unknown pricing model yields NO estimate — the caller must stop, not guess', () => {
  const e = L.estimate(ep('mystery_endpoint'));
  assert.equal(e.credits, null);
  assert.equal(e.basis, 'unknown_pricing_model');
  assert.equal(e.verifiable, false);
});

test('a per-result estimate without a result count is null, not zero', () => {
  assert.equal(L.estimate(ep('people_search')).credits, null);
  assert.equal(L.estimate(ep('lead_search')).credits, null);
});

test('the estimate declares up front whether the charge will be verifiable', () => {
  assert.equal(L.estimate(ep('people_search'), { resultCount: 1 }).verifiable, true);
  assert.equal(L.estimate(ep('google_search_scraper_sync'), { resultCount: 1 }).verifiable, false);
  assert.equal(L.estimate(ep('profile_activities'), { resultCount: 1 }).verifiable, false);
});

// ---------------------------------------------------------------------------
// LAW 4 — NEVER FABRICATE AN ACTUAL
// ---------------------------------------------------------------------------

test('a response LACKING the billing field is written estimated_unverifiable with a null actual', () => {
  const led = newLedger();
  // google_search_scraper_sync bills on `_list_count`, which appears in ZERO responses.
  const line = led.record({
    endpoint: 'google_search_scraper_sync',
    catalogEntry: ep('google_search_scraper_sync'),
    estimatedCredits: 10,
    responseBody: { results: [{ url: 'a' }, { url: 'b' }] },   // no _list_count, ever
    httpStatus: 200
  });
  assert.equal(line.cost_status, 'estimated_unverifiable');
  assert.equal(line.credits_actual, null);
  assert.equal(line.credits_estimated, 10);
  assertConforms(line);
});

test('profile_activities bills on totalElements but returns only elements — unverifiable', () => {
  const led = newLedger();
  const line = led.record({
    endpoint: 'profile_activities',
    catalogEntry: ep('profile_activities'),
    estimatedCredits: 20,
    responseBody: { elements: new Array(10).fill({ text: 'post' }) },   // no totalElements
    httpStatus: 200
  });
  assert.equal(line.cost_status, 'estimated_unverifiable');
  assert.equal(line.credits_actual, null);
  assert.equal(line.result_count, 10, 'the returned count is still recorded — it just is not the billed count');
});

test('an estimate is never echoed back as an actual, even when it would look right', () => {
  const led = newLedger();
  // Response HAS a count field — but the catalog says the billing field is not
  // present, so it is not the billed quantity and must not become an actual.
  const line = led.record({
    endpoint: 'google_search_scraper_sync',
    catalogEntry: ep('google_search_scraper_sync'),
    estimatedCredits: 3,
    responseBody: { count: 3, results: [1, 2, 3] },
    httpStatus: 200
  });
  assert.equal(line.cost_status, 'estimated_unverifiable');
  assert.notEqual(line.credits_actual, line.credits_estimated);
  assert.equal(line.credits_actual, null);
});

test('EVERY unverifiable endpoint in the fixture writes estimated_unverifiable, no exceptions', () => {
  const led = newLedger();
  const unverifiable = Object.values(catalog.endpoints)
    .filter(e => e.pricing.billing_field_present_in_response === false);
  assert.ok(unverifiable.length >= 3);
  for (const e of unverifiable) {
    const line = led.record({
      endpoint: e.name, catalogEntry: e, estimatedCredits: 7,
      responseBody: { elements: [1, 2], count: 2, numberOfElements: 2, totalElements: 999, _list_count: 42 },
      httpStatus: 200
    });
    assert.equal(line.cost_status, 'estimated_unverifiable',
      `${e.name} fabricated an actual from a response the catalog says cannot carry one`);
    assert.equal(line.credits_actual, null);
  }
});

test('an actual IS written where the response really carries the billed count', () => {
  const led = newLedger();
  const a = led.record({
    endpoint: 'people_search', catalogEntry: ep('people_search'),
    estimatedCredits: 5, responseBody: { numberOfElements: 37, elements: new Array(37).fill({}) }, httpStatus: 200
  });
  assert.equal(a.cost_status, 'actual');
  assert.equal(a.credits_actual, 3.7);          // 0.1 x 37 actually returned
  assert.equal(a.credits_estimated, 5);         // the estimate is preserved, not overwritten
  assertConforms(a);

  const b = led.record({
    endpoint: 'lead_search', catalogEntry: ep('lead_search'),
    estimatedCredits: 22.5, responseBody: { elements: 12 }, httpStatus: 200
  });
  assert.equal(b.cost_status, 'actual');
  assert.equal(b.credits_actual, 16);            // 10 base + 0.5 x 12
});

test('a per-result endpoint whose promised billing field is absent from THIS response is unverifiable', () => {
  const led = newLedger();
  // Catalog says numberOfElements will be there. This response omits it.
  const line = led.record({
    endpoint: 'people_search', catalogEntry: ep('people_search'),
    estimatedCredits: 5, responseBody: { elements: [1, 2, 3] }, httpStatus: 200
  });
  assert.equal(line.cost_status, 'estimated_unverifiable');
  assert.equal(line.credits_actual, null);
});

test('a literal credits_charged in the response is an actual outright', () => {
  const led = newLedger();
  const line = led.record({
    endpoint: 'google_search_scraper_sync', catalogEntry: ep('google_search_scraper_sync'),
    estimatedCredits: 10, responseBody: { credits_charged: 8, results: [] }, httpStatus: 200
  });
  assert.equal(line.cost_status, 'actual');
  assert.equal(line.credits_actual, 8);
});

test('a non-2xx costs a known zero — "a non-2xx response deducts no credits"', () => {
  const led = newLedger();
  for (const status of [400, 429, 500, 502]) {
    const line = led.record({
      endpoint: 'people_search', catalogEntry: ep('people_search'),
      estimatedCredits: 5, responseBody: { error: 'nope' }, httpStatus: status
    });
    // This was `actual` once. The contract gained `known_zero` because `actual` was
    // "honest but overloaded". A non-2xx costing zero
    // is a fact about the BILLING RULE, not a charge read off the response, and
    // conflating them made a 429 storm look like verified charges in the totals.
    assert.equal(line.cost_status, 'known_zero');
    assert.equal(line.credits_actual, 0);
    assertConforms(line);
  }
});

test('the written jsonl file is one conforming object per line', () => {
  const led = newLedger();
  led.record({ endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1, responseBody: {}, httpStatus: 200 });
  led.record({ endpoint: 'profile_activities', catalogEntry: ep('profile_activities'), estimatedCredits: 2, responseBody: { elements: [] }, httpStatus: 200 });
  assert.ok(led.path.endsWith('gtm/api-calls.jsonl'), 'the ledger is gtm/api-calls.jsonl');
  assert.ok(existsSync(led.path));
  const lines = readFileSync(led.path, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const raw of lines) assertConforms(JSON.parse(raw));
});

// ---------------------------------------------------------------------------
// 402 — a free balance refresh
// ---------------------------------------------------------------------------

test('a 402 body populates the balance at ZERO cost', () => {
  process.env.richapi_SKILLS_HOME = tmp();
  const led = newLedger();
  const body = { error: 'Insufficient credits', reserved: '5', balance: '2.5' };   // strings, per the spec
  const r = led.recordInsufficientCredits({ endpoint: 'phone_finder', catalogEntry: ep('phone_finder'), body, estimatedCredits: 25 });

  assert.equal(r.reserved, 5);
  assert.equal(r.balance, 2.5);
  assert.equal(r.credits_charged, 0);
  assert.equal(led.balance, 2.5);
  assert.equal(led.balanceSource, '402_body');

  assert.equal(r.line.http_status, 402);
  assert.equal(r.line.credits_actual, 0, 'a 402 is free');
  // Same migration as the non-2xx test above: a 402 costs nothing BY RULE, which is
  // `known_zero`, not a charge verified from the response.
  assert.equal(r.line.cost_status, 'known_zero');
  assert.equal(r.line.balance_after, 2.5);
  assert.equal(r.line.balance_source, '402_body');
  assertConforms(r.line);

  // and it lands in the cache the BALANCE preflight key reads
  const cached = L.readBalanceCache();
  assert.equal(cached.balance, 2.5);
  assert.equal(cached.source, '402_body');
  delete process.env.richapi_SKILLS_HOME;
});

test('a 402 with no parseable balance does not invent one', () => {
  process.env.richapi_SKILLS_HOME = tmp();
  const led = newLedger();
  const r = led.recordInsufficientCredits({ endpoint: 'phone_finder', body: { error: 'Insufficient credits' }, estimatedCredits: 25 });
  assert.equal(r.balance, null);
  assert.equal(r.line.balance_after, null);
  assert.equal(r.line.balance_source, 'unknown');
  assert.equal(L.readBalanceCache(), null, 'nothing was cached');
  delete process.env.richapi_SKILLS_HOME;
});

test('subsequent lines carry the balance the 402 taught us', () => {
  process.env.richapi_SKILLS_HOME = tmp();
  const led = newLedger();
  led.recordInsufficientCredits({ endpoint: 'phone_finder', body: { error: 'x', reserved: '25', balance: '2.5' } });
  const next = led.record({ endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1, responseBody: {}, httpStatus: 200 });
  assert.equal(next.balance_after, 2.5);
  assert.equal(next.balance_source, '402_body');
  delete process.env.richapi_SKILLS_HOME;
});

test('GET /usage can also set the balance, tagged usage_endpoint', () => {
  process.env.richapi_SKILLS_HOME = tmp();
  const led = newLedger();
  assert.equal(led.setBalanceFromUsage({ credits: { balance: 412.5, used: 87.5 } }), 412.5);
  assert.equal(led.balanceSource, 'usage_endpoint');
  assert.equal(L.readBalanceCache().source, 'usage_endpoint');
  // an unparseable body sets nothing
  assert.equal(led.setBalanceFromUsage({ something_else: true }), null);
  delete process.env.richapi_SKILLS_HOME;
});

// ---------------------------------------------------------------------------
// SESSION-END RECONCILIATION AND DRIFT
// ---------------------------------------------------------------------------

test('session end reports drift between the ledger sum and GET /usage', () => {
  const led = newLedger();
  led.record({ endpoint: 'people_search', catalogEntry: ep('people_search'), estimatedCredits: 5, responseBody: { numberOfElements: 50 }, httpStatus: 200 });   // actual 5
  // NOTE: a flat catalog price is an ESTIMATE, not a charge read from the
  // response, so this line is only an actual when the response says so.
  led.record({ endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 }); // actual 1
  led.record({ endpoint: 'google_search_scraper_sync', catalogEntry: ep('google_search_scraper_sync'), estimatedCredits: 10, responseBody: { results: [] }, httpStatus: 200 }); // unverifiable 10

  const t = led.totals();
  assert.equal(t.credits_actual, 6);
  assert.equal(t.credits_estimated_unverifiable, 10);
  assert.equal(t.ledger_total, 16);
  assert.equal(t.unverifiable_lines, 1);

  const r = led.reconcile({ used: 19 });
  assert.equal(r.usage_total, 19);
  assert.equal(r.drift, 3);
  assert.equal(r.status, 'drift');
  assert.match(r.reason, /1 of 3 line\(s\) are estimates we cannot verify/);
  assert.match(r.report, /Drift: 3 credits/);
});

test('a matching total reconciles cleanly', () => {
  const led = newLedger();
  led.record({ endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1, responseBody: {}, httpStatus: 200 });
  const r = led.reconcile(1);
  assert.equal(r.status, 'reconciled');
  assert.equal(r.drift, 0);
});

test('an unavailable GET /usage degrades to "unreconciled", never to a fake match', () => {
  const led = newLedger();
  led.record({ endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1, responseBody: {}, httpStatus: 200 });
  const r = led.reconcile(null);
  assert.equal(r.status, 'unreconciled');
  assert.equal(r.usage_total, null);
  assert.equal(r.drift, null);
  assert.match(r.reason, /does not fetch GET \/usage for a run/,
    'the reason must say WHY reconciliation is unavailable in words a user can act on. '
    + 'It used to cite an internal ask number that no public document explains.');
  assert.match(r.report, /NOT reconciled/);

  // an unparseable body is the same thing
  assert.equal(led.reconcile({ nothing: 'useful' }).status, 'unreconciled');
});

test('the reconciliation report states how much of the total is unverifiable', () => {
  const led = newLedger();
  led.record({ endpoint: 'profile_activities', catalogEntry: ep('profile_activities'), estimatedCredits: 40, responseBody: { elements: [] }, httpStatus: 200 });
  const r = led.reconcile({ credits_used: 40 });
  assert.match(r.report, /unverifiable estimates: 40 \(1 line\(s\)\)/);
  assert.equal(r.credits_actual, 0);
});

test('usage/balance probing handles nesting, strings and plain numbers', () => {
  assert.equal(L.extractBalance({ balance: '2.5' }), 2.5);
  assert.equal(L.extractBalance({ data: { account: { credits_remaining: 100 } } }), 100);
  assert.equal(L.extractBalance('{"remaining":7}'), 7);
  assert.equal(L.extractBalance(null), null);
  assert.equal(L.extractBalance({ nope: 1 }), null);
  assert.equal(L.extractUsageSpend({ usage: { credits_used: 12.25 } }), 12.25);
  assert.equal(L.extractUsageSpend(42), 42);
});

// ---------------------------------------------------------------------------
// THE LEDGER MUST NOT COUNT CALLS THE API DID NOT BILL.
//
// Measured on the 2026-09-17 local-business-outbound rerun:
// gtm/api-calls.jsonl carried 27 lines whose `credits_estimated` summed to 41.5,
// of which 14 non-2xx lines contributed 28.0 — while the receipt for the SAME run
// correctly reported "a non-2xx is not billed". /measure, /cost-optimizer and every
// budget gate sum the ledger, so the ledger overstated spend by 2.3x and could stop
// a run at a ceiling it had not come near.
// ---------------------------------------------------------------------------

const PROVIDER_ERROR = Object.freeze({
  ok: false, result: null, billed: false,
  why: '2/5 providers returned an error — retry later',
});

test('an UNBILLED line records zero in the field consumers sum, and keeps the estimate elsewhere', () => {
  const led = newLedger();
  const line = led.record({
    endpoint: 'people_search', catalogEntry: ep('people_search'),
    estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: { error: 'nope' }, httpStatus: 400,
  });
  assert.equal(line.credits_estimated, 0, 'the summed field must be 0 — nothing was billed');
  assert.equal(line.credits_estimated_if_billed, 5, 'the would-have-been price is kept, under its own name');
  assert.equal(line.billed, false);
  assert.equal(line.not_billed_reason, 'non_2xx');
  assert.equal(line.cost_status, 'known_zero');
  assertConforms(line);
});

test('a 2xx whose body says billed:false is a PROVIDER ERROR, costed at zero and named as such', () => {
  const led = newLedger();
  const line = led.record({
    endpoint: 'phone_finder', catalogEntry: ep('phone_finder'),
    estimatedCredits: 25, estimateBasis: 'flat 25', responseBody: PROVIDER_ERROR, httpStatus: 200,
  });
  assert.equal(line.http_status, 200);
  assert.equal(line.credits_estimated, 0, 'the API said billed:false — booking 25 is phantom spend');
  assert.equal(line.credits_estimated_if_billed, 25);
  assert.equal(line.billed, false);
  assert.equal(line.not_billed_reason, 'provider_error', 'distinct from a non-2xx AND from a not-found');
  assert.equal(line.cost_status, 'known_zero');
  assert.equal(line.credits_actual, 0);
  assertConforms(line);
  assert.equal(led.totals().provider_error_lines, 1);
  assert.equal(led.totals().ledger_total, 0);
});

test('a WATERFALL MISS that WAS billed keeps costing — only an explicit billed:false is free', () => {
  const led = newLedger();
  // The recorded email_finder shape, with no address found. No billing flag anywhere.
  const line = led.record({
    endpoint: 'phone_finder', catalogEntry: ep('phone_finder'),
    estimatedCredits: 25, estimateBasis: 'flat 25',
    responseBody: { success: true, result: { phone: null }, providers_tried: 5 }, httpStatus: 200,
  });
  assert.equal(line.credits_estimated, 25, 'a 2xx that found nothing is a successful, billed call');
  assert.equal(line.billed, true);
  assert.equal(line.not_billed_reason, null);
  assert.equal(line.cost_status, 'estimated_unverifiable');
  assert.equal(led.totals().ledger_total, 25);

  // `ok: false` WITHOUT a billing flag is still a billed not-found, not a free retry.
  const led2 = newLedger();
  const b = led2.record({
    endpoint: 'phone_finder', catalogEntry: ep('phone_finder'),
    estimatedCredits: 25, responseBody: { ok: false, result: null }, httpStatus: 200,
  });
  assert.equal(b.billed, true);
  assert.equal(b.credits_estimated, 25);
});

test('a response NEVER SEEN (status 0) is not booked at zero — unknown is not free', () => {
  const led = newLedger();
  const line = led.record({
    endpoint: 'phone_finder', catalogEntry: ep('phone_finder'),
    estimatedCredits: 25, responseBody: null, httpStatus: 0,
  });
  assert.equal(line.billed, null, 'the server may well have processed and billed it');
  assert.equal(line.credits_estimated, 25);
  assert.equal(line.cost_status, 'estimated_unverifiable');
});

test('the ledger total now AGREES with the receipt: unbilled lines contribute nothing', () => {
  const led = newLedger();
  // The shape of the live local-business-outbound rerun, in miniature.
  led.record({ endpoint: 'people_search', catalogEntry: ep('people_search'), estimatedCredits: 5, responseBody: { numberOfElements: 10, elements: new Array(10).fill({}) }, httpStatus: 200 });
  for (let i = 0; i < 3; i += 1) {
    led.record({ endpoint: 'phone_finder', catalogEntry: ep('phone_finder'), estimatedCredits: 25, responseBody: { error: 'bad request' }, httpStatus: 422 });
  }
  led.record({ endpoint: 'phone_finder', catalogEntry: ep('phone_finder'), estimatedCredits: 25, responseBody: PROVIDER_ERROR, httpStatus: 200 });

  const t = led.totals();
  assert.equal(t.lines, 5);
  assert.equal(t.known_zero_lines, 4, '3 non-2xx + 1 provider error');
  assert.equal(t.provider_error_lines, 1);
  assert.equal(t.ledger_total, 1, 'only the one billed call: 0.1/result x 10');

  // The bug, stated as arithmetic: a consumer (/measure, /cost-optimizer, a budget
  // gate) sums `credits_estimated` over every raw line. That sum used to be
  // 5 + 25*4 = 105 for this run — 100 credits of calls the API never billed.
  const naive = led.lines.reduce((s, l) => s + l.credits_estimated, 0);
  assert.equal(naive, 5, 'only the one billed call may contribute to a raw-line sum');
  const unbilled = led.lines.filter(l => l.billed === false);
  assert.equal(unbilled.length, 4);
  assert.equal(unbilled.reduce((s, l) => s + l.credits_estimated, 0), 0);
  // ...and the would-have-been prices are still on record, just not summable by accident.
  assert.equal(unbilled.reduce((s, l) => s + l.credits_estimated_if_billed, 0), 100);
});
