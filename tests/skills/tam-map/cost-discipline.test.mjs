// tests/skills/tam-map/cost-discipline.test.mjs
//
// The shape contract can prove this skill HAS a plan. It cannot prove the plan is the
// cheap one, and for /tam-map that is the whole risk: "how many are there" is answered
// by exactly the endpoints with no bound on the total. Three of this skill's seven are
// page-gated in `_lib/gates.yaml:unbounded_endpoints.endpoints`, and for those three the
// charge never comes back in the response, so the estimate is the only number that will
// ever exist.
//
// So this file asserts the money, not the markdown:
//
//   1. The free-total table in the SKILL.md is what the SPEC says, endpoint by endpoint.
//      Derived, never hardcoded — the table is this suite's headline claim and a claim
//      nobody re-derives is a claim that rots.
//   2. Where a total-count field exists, the skill reaches the TAM figure from page one
//      and explicitly refuses to page-walk to it.
//   3. Where none exists, the skill says so and prices the alternative.
//   4. Every page-gated endpoint it touches is named AND covered by the page-gate keys.
//   5. `_lib/gates.yaml` and `_lib/api-catalog.json` agree about which of the seven are
//      page-gated. Two skills computing that set differently is a billing surprise, and
//      it has happened in this repo before.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates, hasGate, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';
import {
  catalog, gates, skillBody, skillProse, ownedEndpoints, citedGateKeys,
  hasFreeTotalCount, billingCountField, documentedCountTable, responseExample,
} from './helpers.mjs';

const owned = [...ownedEndpoints()].sort();
const body  = skillBody();
const prose = skillProse();

const PAGE_GATE_KEYS = [
  'unbounded_endpoints.pages_before_confirm',
  'unbounded_endpoints.hard_page_ceiling',
  'unbounded_endpoints.assumed_results_per_page',
];

// ---------------------------------------------------------------------------
// 1. The free-total table, re-derived from the spec
// ---------------------------------------------------------------------------

test('the spec agrees: exactly one of the seven reports a total for free', () => {
  const free = owned.filter(hasFreeTotalCount);
  assert.deepEqual(free, ['linkedin_company_search'],
    'the set of endpoints that hand back a whole-result-set total has changed — '
    + 're-read the spec and rewrite the table before touching anything else');
});

test('the SKILL.md table matches the spec, row for row', () => {
  const documented = documentedCountTable(body);
  assert.equal(Object.keys(documented).length, owned.length,
    'the free-total table must carry a row for every endpoint this skill owns');
  for (const ep of owned) {
    assert.equal(documented[ep], hasFreeTotalCount(ep),
      `the table says ${ep} ${documented[ep] ? 'does' : 'does not'} report a free total; `
      + `the spec says it ${hasFreeTotalCount(ep) ? 'does' : 'does not'}`);
  }
});

test('the counted source is billed on the PAGE, not on the total — that is why it is free', () => {
  // If x-pricing ever named `totalElements` as the billing field, page one would be
  // charged for the whole market. That reading is what kept post_keyword_search
  // disabled until the 2026-09-17 re-pin moved its bill onto the page.
  assert.equal(billingCountField('linkedin_company_search'), 'elements',
    'linkedin_company_search is no longer billed on the page it returns — a count probe '
    + 'may now be charged for the entire result set. STOP and escalate to the API provider.');
  assert.equal(billingCountField('post_keyword_search'), 'numberOfElements',
    'post_keyword_search bills on the page it returns; if it moves back to totalElements, '
    + 'a keyword search is charged for every match. STOP and re-disable it.');
});

test('the two count-shaped traps are named, because both look like a market size', () => {
  // similarweb's totalVisits and google maps totalScore are the near-misses. Neither is
  // a result count, and both sit in a response a TAM author is already reading.
  assert.ok(String(responseExample('similarweb_scraper_sync') ?? '').length > 0
    || responseExample('similarweb_scraper_sync') !== null);
  assert.match(prose, /totalVisits/,
    'similarweb returns totalVisits; the skill must say it is traffic, not a result count');
  assert.match(prose, /_list_count/,
    'four of the seven price on _list_count; the skill must say it is a page length, '
    + 'not a market size');
});

// ---------------------------------------------------------------------------
// 2. The count is reached without a page-walk
// ---------------------------------------------------------------------------

test('the TAM figure is read from page one, not walked to', () => {
  assert.match(body, /pagination\.totalElements/,
    'the free total is `pagination.totalElements`; name the field');
  assert.match(body, /--pages 1\b/,
    'a count probe is one page — the plan must show `--pages 1`');
  // The refusal is load-bearing: without it "read the total" and "walk the pages" are
  // both documented and the reader picks.
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /will not walk pages to reach a number a count field already gives/i,
    'the boundary must refuse the page-walk-to-count outright');
});

test('the count discipline is stated before any page-walking instruction', () => {
  const countIdea = body.search(/a count is not a list/i);
  const walkRules = body.search(/pages_before_confirm/);
  assert.ok(countIdea > -1, 'the count-is-not-a-list section is missing');
  assert.ok(walkRules > -1, 'the page-gate rules are missing');
  assert.ok(countIdea < walkRules,
    'the reader must learn the total is free before they are told how to buy pages');
});

test('the runtime gap is stated honestly rather than routed around silently', () => {
  // `richapi search` persists _results/_page/_count; the pagination envelope is not
  // carried into --out. The body IS written to the read-through cache, which is where
  // the total is actually readable today.
  assert.match(body, /gtm\/enrichment-cache\/linkedin_company_search\.jsonl/,
    'say where the total is actually readable today');
  assert.match(prose, /count-only mode/i, 'name the verb the runtime still needs');
});

// ---------------------------------------------------------------------------
// 3. The six with no total are priced as something else
// ---------------------------------------------------------------------------

test('every endpoint with no total is named in a paragraph that says what it is instead', () => {
  for (const ep of owned.filter(e => !hasFreeTotalCount(e))) {
    const paras = prose.split(/\n\s*\n/).filter(p => p.includes(`${ep}()`));
    assert.ok(paras.length > 0, `${ep}() is never discussed in prose`);
  }
});

test('the two Maps endpoints are barred from producing a market size', () => {
  // They have no `page` field at all: `limit` is the only control, so the response is
  // the caller's own parameter coming back.
  for (const ep of ['google_maps_places_scraper_keyword', 'google_maps_places_scraper_sync_using_url']) {
    const props = catalog.endpoints[ep].required_request_fields ?? [];
    assert.ok(props.includes('limit'), `${ep} is expected to be limit-bounded`);
    assert.equal(catalog.endpoints[ep].pricing.page_gated, false,
      `${ep} has no page to gate; if that changed, the skill's advice changed too`);
  }
  assert.match(prose, /parameter, not a measurement|request parameter coming back/i,
    'the skill must say that a limit-bounded sample is not a market size');
});

test('a per-result endpoint run as a row call is priced with --expect', () => {
  // Without --expect, planRowCall prices a per-result endpoint at
  // unbounded_endpoints.assumed_results_per_page, which understates a large `limit`.
  assert.match(body, /--expect 1\b/,
    'a single-domain per-result call must be planned as one result');
  assert.match(prose, /Without `--expect`/,
    'say what the plan does when --expect is omitted, and which way it is wrong');
  assert.match(body, /richapi call similarweb_scraper_sync/,
    'similarweb has no page parameter; it must be routed through `richapi call`');
  assert.ok(!/richapi search similarweb_scraper_sync/.test(body),
    'similarweb has no page parameter — a paged search over it is a fabricated page walk');
});

test('the max_pages booby trap on directory_yellowpages is named and refused', () => {
  assert.match(prose, /max_pages/,
    'directory_yellowpages scrapes several pages inside ONE request; say so');
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /max_pages/,
    'the boundary must refuse raising max_pages — it disables the page gate from inside '
    + 'the request body');
});

test('law 4 — the unverifiable charge is passed on as an estimate, never as an actual', () => {
  // REWRITTEN 2026-09-17. `billing_field_present_in_response` is now an EVIDENCE flag:
  // true only where a RECORDED 2xx body carries a numeric billing field. None do, so
  // the property is universal and a frozen four-name list can no longer be the
  // assertion. What still has to hold is the part that protects the user: the calls
  // this skill already marks on its plan are still marked, and law 4's ledger status
  // is still named. This fails against the old catalog, where the list was a subset.
  const unverifiable = owned.filter(e => catalog.endpoints[e].pricing.billing_field_present_in_response === false);
  assert.deepEqual(unverifiable.sort(), [...owned].sort(),
    'no endpoint reports its charge, so every owned call is an estimate');
  assert.match(prose, /estimated_unverifiable/,
    'law 4: name the ledger status those rows carry');
  assert.match(prose, /A range stays a range/i,
    'a range must not be rounded into one confident number');
});

// ---------------------------------------------------------------------------
// 4 + 5. Page gating, and the two files agreeing about who is page-gated
// ---------------------------------------------------------------------------

test('gates.yaml and api-catalog.json agree on which of the seven are page-gated', () => {
  const fromGates = new Set(
    (gates.unbounded_endpoints?.endpoints ?? []).filter(e => owned.includes(e))
  );
  const fromCatalog = new Set(owned.filter(e => catalog.endpoints[e].pricing.page_gated === true));
  assert.deepEqual([...fromGates].sort(), [...fromCatalog].sort(),
    'the page-gated set disagrees between _lib/gates.yaml and _lib/api-catalog.json — '
    + 'that disagreement is a billing surprise, not a docs nit');
  assert.deepEqual([...fromGates].sort(), [
    'directory_yellowpages',
    'linkedin_company_search',
    'similarweb_scraper_sync',
  ]);
});

test('every page-gated endpoint this skill touches is named in the body', () => {
  const pageGated = owned.filter(e => catalog.endpoints[e].pricing.page_gated === true);
  assert.ok(pageGated.length > 0, 'the fixture must reflect that this skill touches page-gated endpoints');
  for (const ep of pageGated) {
    assert.ok(body.includes(`${ep}()`), `${ep}() is page-gated and must be named in the skill`);
  }
});

test('every page-gated endpoint is covered by the page-gate keys, cited not restated', () => {
  const cited = citedGateKeys(body);
  for (const key of PAGE_GATE_KEYS) {
    assert.ok(cited.has(key), `the page gate is unusable without gates.yaml:${key}`);
  }
  // A single-call blowout does not need cumulative spend to have happened first.
  assert.ok(cited.has('session_budget.fractions.single_call_confirm'),
    'one huge unbounded probe on call #1 is exactly what this fraction catches');
});

test('every cited gate key resolves against the real gates.yaml (law 5)', () => {
  const loaded = loadGates();
  const cited = [...citedGateKeys(body)];
  assert.ok(cited.length >= PAGE_GATE_KEYS.length, 'this skill must cite its thresholds');
  for (const key of cited) {
    assert.ok(hasGate(loaded, key), `gates.yaml:${key} does not resolve — a missing key reads as STOP`);
    assert.notEqual(gateValue(loaded, key), null);
  }
});

test('the skill says a missing gate key is a STOP, not "no gate" (law 5)', () => {
  assert.match(prose, /missing gate key reads as STOP|never as "no gate"/i,
    'fail-closed must be stated where the page walk is described');
});

test('law 1 — not one threshold in this skill is hand-typed', () => {
  const findings = scanForBareNumbers(body, { file: 'skills/tam-map/SKILL.md' });
  assert.deepEqual(findings.map(f => `${f.line}: ${f.message}`), []);
});

test('no credit price is written into the document at all', () => {
  // scanForBareNumbers catches "N credits". This catches the sneakier forms — a price
  // copied out of the catalog as a bare per-result rate.
  for (const ep of owned) {
    const p = catalog.endpoints[ep].pricing;
    for (const n of [p.credits_per_call, p.credits_per_result, p.credits_base]) {
      if (n === null || n === undefined || n === 0) continue;
      const re = new RegExp(`\\b${String(n).replace('.', '\\.')}\\s*(?:cr|credits?|/\\s*result|per result)`, 'i');
      assert.ok(!re.test(prose), `the ${ep} price appears literally in the prose (law 1)`);
    }
  }
});
