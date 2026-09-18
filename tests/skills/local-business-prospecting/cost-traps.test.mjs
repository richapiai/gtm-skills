// tests/skills/local-business-prospecting/cost-traps.test.mjs
//
// Two cost traps were measured on this skill's endpoints, and both are the kind that a
// shape linter cannot see: the SKILL.md can carry a dry-run plan, cite every gate key,
// and still hand the user a command line that spends several times what the plan said.
//
//   TRAP 1 — `directory_yellowpages` takes `max_pages` IN THE REQUEST BODY. One request
//            scrapes N pages while the runtime's page gate counts REQUESTS, so the gate
//            fires once and hard_page_ceiling counts one. That is a page-gated endpoint
//            with its page gate switched off from inside the request.
//
//   TRAP 2 — the Maps endpoints are per-result with `limit` in the request. The runtime
//            used to infer a result count only from an ARRAY in the request body;
//            `limit` is a scalar, so an unhinted call was PRICED at
//            gates.yaml:unbounded_endpoints.assumed_results_per_page and BILLED at the
//            limit. The error hid itself: the approved plan was smaller than the bill.
//            CLOSED 2026-08-29 — `_lib/run.mjs:requestBound` reads the request's own
//            bound as the count basis, and the test below now pins the fix instead of
//            the trap. The skill's `--expect` advice is kept as belt and braces.
//
// Both traps are asserted against the runtime's own planner and the spec, not against
// the prose, so a rewrite that keeps the words and drops the flag turns this red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates, hasGate, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';
import { planRowCall, planSearch } from '../../../_lib/run.mjs';
import { loadSuppressionStore } from '../../../_lib/suppression.mjs';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  catalog, gates, skillBody, skillProse, boundarySection, citedGateKeys,
  requestSchema, shellCommands, paramsOf, expectOf, capabilityGroupEndpoints,
} from './helpers.mjs';

/** A real, genuinely-empty suppression store (not an absent one — that is a STOP). */
function emptySuppressionStore () {
  const root = mkdtempSync(join(tmpdir(), 'lbp-emptystore-'));
  mkdirSync(join(root, 'gtm'), { recursive: true });
  const file = join(root, 'gtm', 'suppression.jsonl');
  writeFileSync(file, '', 'utf8');
  return loadSuppressionStore({ root, path: file });
}

const body = skillBody();
const prose = skillProse();
const boundary = boundarySection();
const owned = [...capabilityGroupEndpoints()].sort();

const MAPS = [
  'google_maps_places_scraper_keyword',
  'google_maps_places_scraper_sync_using_url',
  'google_maps_reviews_scraper_sync',
];

// ---------------------------------------------------------------------------
// TRAP 1 — max_pages
// ---------------------------------------------------------------------------

test('the trap is real: the spec puts BOTH page and max_pages in the request body', () => {
  const props = requestSchema('directory_yellowpages')?.properties ?? {};
  assert.ok(props.page, 'directory_yellowpages should expose `page`');
  assert.ok(props.max_pages,
    'directory_yellowpages no longer exposes `max_pages` — if the API dropped it, this '
    + 'skill\'s refusal is obsolete and the prose must be rewritten, not left standing');
  assert.equal(props.max_pages.default, 1,
    'the safe default changed; the clamp in the SKILL.md is written against a default of one page');
});

test('the trap is real: the runtime page-gates this endpoint per REQUEST', () => {
  // planSearch produces one plan row per page NUMBER, i.e. per request. Nothing in it
  // can see a max_pages inside the body, which is exactly why the skill must clamp it.
  const plan = planSearch({
    runId: 'r', endpoint: 'directory_yellowpages',
    params: { search_query: 'plumber', location: 'Austin, TX' },
    catalog, gates: loadGates(), cache: { enabled: false, has: () => false, get: () => null },
    pages: 3,
  });
  assert.equal(plan.pages.length, 3, 'a page is a plan row; three pages must be three rows');
  assert.deepEqual(plan.pages, [1, 2, 3]);
  assert.equal(catalog.endpoints.directory_yellowpages.pricing.page_gated, true);
  assert.ok((gates.unbounded_endpoints?.endpoints ?? []).includes('directory_yellowpages'),
    'gates.yaml and the catalog must agree that this endpoint is page-gated');
});

test('the skill refuses to raise max_pages, in the boundary section and not only in prose', () => {
  assert.match(prose, /max_pages/,
    'the trap must be named where the endpoint is described');
  assert.match(boundary, /max_pages/,
    'the boundary must carry the refusal — an unstated ceiling reads as a promise');
  assert.match(boundary, /will not raise `?max_pages/i,
    'the refusal must be explicit, not a caveat the reader has to infer');
});

test('the skill says WHY: the gate counts requests, so one request defeats it', () => {
  assert.match(prose, /counts\s+\*{0,2}requests\*{0,2}/i,
    'say that the page gate counts requests, which is the whole mechanism');
  const cited = citedGateKeys(body);
  for (const key of ['unbounded_endpoints.pages_before_confirm',
    'unbounded_endpoints.hard_page_ceiling']) {
    assert.ok(cited.has(key), `the trap is unexplainable without gates.yaml:${key}`);
  }
});

test('the skill paginates one request per page, and no example ever sends max_pages', () => {
  assert.match(prose, /one request per page/i,
    'the replacement behaviour must be stated, not just the refusal');
  const yp = shellCommands().filter((c) => c.endpoint === 'directory_yellowpages');
  assert.ok(yp.length > 0, 'the skill must show how to page this endpoint');
  for (const c of yp) {
    assert.equal(c.verb, 'search',
      'a paged endpoint is bought through `richapi search`, so every page is a plan row');
    assert.ok(!('max_pages' in paramsOf(c.text)),
      `an example sends max_pages: ${c.text}`);
    assert.match(c.text, /--pages\s+\d+/,
      'the page count belongs on the command line, where the gate can see it');
    assert.match(c.text, /--dry-run/,
      'law 3: the first action is a plan, never a call');
  }
});

test('the skill reads its OWN clamp key, and the precedent key still exists', () => {
  // WAS: this asserted the skill cited `skills.tam_map.directory_max_pages_per_request`
  // (another skill's key) and said in prose that it "needs its own". That premise was
  // overturned on 2026-08-31: `skills.local_business_prospecting` now exists, so the
  // skill reads its own key and the deferral prose is gone. Citing another skill's gate
  // was always a stopgap — a clamp scoped to /tam-map does not bind this page.
  const loaded = loadGates();

  // The precedent must still exist: it is the same clamp on the same endpoint, and a
  // rename is a silent STOP (law 5).
  assert.ok(hasGate(loaded, 'skills.tam_map.directory_max_pages_per_request'),
    'the precedent key has moved or been renamed');
  assert.equal(gateValue(loaded, 'skills.tam_map.directory_max_pages_per_request'), 1);

  // This skill now has its own, at the same value and for the same structural reason.
  const own = 'skills.local_business_prospecting.directory_max_pages_per_request';
  assert.ok(hasGate(loaded, own), `${own} must exist — this page is clamped by a key, not by prose`);
  assert.equal(gateValue(loaded, own), 1,
    'directory_yellowpages takes max_pages in the REQUEST BODY, so one request scrapes N '
    + 'pages while the page gate counts one request. Clamping to 1 keeps the human gate real.');
  assert.ok(citedGateKeys(body).has(own),
    'the skill must cite its own key so the number is never restated in prose (law 1)');

  // The two ceilings that decide the bill must be keys too, not prose.
  for (const k of ['skills.local_business_prospecting.max_reviews_per_place',
                   'skills.local_business_prospecting.max_places_per_run']) {
    assert.ok(hasGate(loaded, k), `${k} must exist`);
    assert.ok(citedGateKeys(body).has(k), `the skill must cite ${k}`);
  }

  // And it must no longer claim it is waiting for someone to add them.
  assert.doesNotMatch(prose, /needs its own gate keys? .{0,40}does not have (them|it) yet/i,
    'the deferral prose outlived the keys it was waiting for');
  assert.doesNotMatch(prose, /orchestrator/i,
    'internal build-process language must not ship to users');
});

// ---------------------------------------------------------------------------
// TRAP 2 — per-result `limit`, and the plan that cannot see it
// ---------------------------------------------------------------------------

// TRAP 2 IS CLOSED, 2026-08-29, in the runtime rather than in this skill's prose.
//
// This test used to assert the trap: `planRowCall` inferred a result count from ARRAY
// lengths only, so a scalar `limit` was invisible and an unhinted Maps call was priced
// at gates.yaml:unbounded_endpoints.assumed_results_per_page while it was BILLED at the
// limit. Its failure message named its own exit condition — "if it no longer does, the
// runtime learned to read `limit` and this trap is closed" — and that is what happened:
// `_lib/run.mjs:requestBound` now reads the request's own bound as the count basis.
//
// The same fix re-armed `session_budget.fractions.single_call_confirm`, which had been
// evaluated against the 25-result assumption on calls that were an order of magnitude
// larger. See `tests/request-limits/request-bound.test.mjs` for the measured before/after
// (people_search --param limit=1000 planned at 2.5 against a real charge of 100).
//
// The assertion is INVERTED rather than deleted, because the property that matters is
// unchanged: the plan must not understate the bill. `--expect` is now a redundant
// belt on this braces — still honoured, still required by the examples below, and no
// longer the only thing standing between a reader and a 20x surprise.
test('the trap is CLOSED: an unhinted Maps call is priced at its own limit', () => {
  const g = loadGates();
  const assumed = Number(gateValue(g, 'unbounded_endpoints.assumed_results_per_page'));
  const cache = { enabled: false, has: () => false, get: () => null };
  // A REAL empty store, not a `{ has: () => false }` stub.
  //
  // The stub used to be enough only because the suppression check read the record,
  // the record here is `{}`, and `rowIdentifiers({})` is empty — so `.some()` never
  // invoked the store at all. The check now also reads the built payload (law 5:
  // `--param` puts the address there and nowhere else), the params below are
  // non-empty, so the store is finally exercised — and a stub that is not a store
  // fails closed, exactly as a missing store should.
  //
  // This test is about pricing, so it wants a store that is genuinely empty rather
  // than one that is genuinely absent. Those are different states and the pack is
  // deliberate about the difference.
  const store = emptySuppressionStore();

  const params = {
    limit: 50, search_query: 'x', location_query: 'y',
    google_map_search_url: 'https://maps.example/x',
    google_map_review_url: 'https://maps.example/p',
  };

  for (const ep of MAPS) {
    assert.equal(catalog.endpoints[ep].pricing.model, 'per_result',
      `${ep} is expected to be per-result; if that changed, so did this skill's advice`);

    const unhinted = planRowCall({
      runId: 'r', endpoint: ep, records: [{}], catalog, gates: g, store, cache, params,
    });
    assert.equal(unhinted.expected, params.limit,
      `${ep} must be priced at the limit the request itself carries. Falling back to the `
      + `${assumed}-result gate assumption is the trap: the approved plan comes out smaller `
      + 'than the bill, which is wrong in the direction that hides itself');

    const hinted = planRowCall({
      runId: 'r', endpoint: ep, records: [{}], catalog, gates: g, store, cache, params,
      expectedResults: params.limit,
    });
    assert.equal(hinted.expected, params.limit, '--expect is still honoured');
    assert.equal(hinted.plan.totals.credits_estimated, unhinted.plan.totals.credits_estimated,
      `--expect ${params.limit} must now agree with the plan rather than correct it`);

    // The property the trap was really about, stated directly and independently of how
    // the count is derived: the plan may never come in under the charge.
    const perResult = catalog.endpoints[ep].pricing.credits_per_result;
    assert.equal(unhinted.plan.totals.credits_estimated, perResult * params.limit,
      `${ep} at ${perResult} credits a result x a limit of ${params.limit}`);
  }

  // And an endpoint that states NO bound still falls back to the stated assumption,
  // so the fix did not quietly replace one silent number with another.
  const noBound = planRowCall({
    runId: 'r', endpoint: MAPS[0], records: [{}], catalog, gates: g, store, cache,
    params: { search_query: 'x' },
  });
  assert.equal(noBound.expected, assumed);
});

test('every Maps example carries --expect, and --expect equals limit', () => {
  // Kept after trap 2 was closed. `--expect` is no longer load-bearing for the PRICE —
  // the runtime reads `limit` now — but an example that states the count it expects is
  // still the example that survives a spec revision renaming the bound field, and it is
  // what makes the reader look at the number before they buy it.
  const cmds = shellCommands().filter((c) => MAPS.includes(c.endpoint));
  // At least one worked example per endpoint; the reviews endpoint carries two, because
  // the measured guidance is probe one review, then buy the pass.
  for (const ep of MAPS) {
    assert.ok(cmds.some((c) => c.endpoint === ep),
      `${ep} needs a worked example; without one the flag is a promise in prose`);
  }
  for (const c of cmds) {
    const params = paramsOf(c.text);
    const expect = expectOf(c.text);
    assert.ok(params.limit !== undefined, `no --param limit= on: ${c.text}`);
    assert.notEqual(expect, null, `no --expect on: ${c.text}`);
    assert.equal(expect, Number(params.limit),
      `--expect ${expect} disagrees with limit ${params.limit}: ${c.text}. `
      + 'The bill is the limit, not the number of rows you hope to keep.');
    assert.match(c.text, /--dry-run/, `law 3: ${c.text} must plan before it spends`);
  }
});

test('the Maps endpoints are never bought through `richapi search` — they have no page', () => {
  for (const ep of MAPS) {
    const props = requestSchema(ep)?.properties ?? {};
    assert.ok(!props.page, `${ep} now has a page field; the routing advice must be revisited`);
    assert.equal(catalog.endpoints[ep].pricing.page_gated, false);
  }
  for (const c of shellCommands()) {
    if (!MAPS.includes(c.endpoint)) continue;
    assert.equal(c.verb, 'call',
      `${c.endpoint} has no page parameter, so a paged search over it is a fabricated page walk`);
  }
});

test('the skill says which way the unhinted estimate is wrong', () => {
  assert.match(prose, /--expect/, 'name the flag');
  assert.match(prose, /must equal `?limit`?/i,
    'the rule is an equality, not "set it to something sensible"');
  assert.match(prose, /hides it|smaller than the invoice/i,
    'say that the error is in the direction that hides itself — that is why it matters');
});

test('review mining is capped by places AND by reviews per place, and never runs list-wide', () => {
  // reviews-per-place times places is the multiplier an earlier version of this skill got
  // wrong; it defaulted to running reviews across every sourced row.
  assert.match(prose, /reviews per place times number of places|reviews per place, and how many places/i,
    'the multiplier must be stated, because it is the thing people do not hold in their head');
  assert.match(boundary, /will not run review mining across a whole sourced list/i,
    'the boundary must refuse the list-wide review pass outright');
  const sortEnum = requestSchema('google_maps_reviews_scraper_sync')?.properties?.review_sort;
  assert.ok(sortEnum?.pattern, 'review_sort should still be pattern-constrained');
  // Re-pinned 2026-09-17: the enum is now mostRelevant/newest/highestRanking/lowestRanking.
  for (const value of ['mostRelevant', 'newest', 'highestRanking', 'lowestRanking']) {
    assert.ok(new RegExp(sortEnum.pattern).test(value));
    assert.ok(prose.includes(value), `the skill must name the real sort value \`${value}\``);
  }
  // An earlier version documented `sort: "lowest"`, which this endpoint rejects.
  assert.ok(!/`?review_sort`?[= ]+"?lowest"?(?![A-Za-z_])/.test(body),
    'the earlier invalid sort value must not survive the port');
});

// ---------------------------------------------------------------------------
// Law 4 — nothing here can ever be reconciled
// ---------------------------------------------------------------------------

test('all four endpoints omit the billing field, and the skill says so in every row', () => {
  const unverifiable = owned.filter(
    (e) => catalog.endpoints[e].pricing.billing_field_present_in_response === false);
  assert.deepEqual(unverifiable, owned,
    'the set of this skill\'s endpoints that never report a charge has changed — the '
    + '"every row says No" claim in the SKILL.md is now false');
  assert.match(prose, /estimated_unverifiable/,
    'law 4: name the ledger status these rows carry');
  assert.match(prose, /range stays a range/i,
    'a range must not be rounded into one confident number');
  assert.match(boundary, /will not fabricate an actual/i,
    'the boundary must carry law 4');
});

test('law 1 — not one threshold or price is hand-typed', () => {
  assert.deepEqual(
    scanForBareNumbers(body, { file: 'skills/local-business-prospecting/SKILL.md' })
      .map((f) => `${f.line}: ${f.message}`),
    []);
  // The sneakier form: a per-result rate copied out of the catalog.
  for (const ep of owned) {
    const p = catalog.endpoints[ep].pricing;
    for (const n of [p.credits_per_call, p.credits_per_result, p.credits_base]) {
      if (n === null || n === undefined || n === 0) continue;
      const re = new RegExp(`\\b${String(n).replace('.', '\\.')}\\s*(?:cr|credits?|/\\s*result|per result)`, 'i');
      assert.ok(!re.test(prose), `the ${ep} price appears literally in the prose (law 1)`);
    }
  }
});

test('every cited gate key resolves against the real gates.yaml (law 5)', () => {
  const loaded = loadGates();
  const cited = [...citedGateKeys(body)];
  assert.ok(cited.length >= 6, 'a skill that spends this way must cite its thresholds');
  for (const key of cited) {
    assert.ok(hasGate(loaded, key),
      `gates.yaml:${key} does not resolve — a missing key reads as STOP, not "no gate"`);
  }
  assert.ok(cited.includes('session_budget.fractions.single_call_confirm'),
    'a mistyped limit on call #1 is exactly what this fraction catches');
});

test('the skill says a missing gate key is a STOP, not "no gate"', () => {
  assert.match(prose, /reads\s+as\s+STOP/i,
    'fail-closed must be stated where the clamp is described (law 5)');
});
