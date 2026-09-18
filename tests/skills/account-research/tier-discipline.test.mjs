// tests/skills/account-research/tier-discipline.test.mjs
//
// Twenty-three endpoints is a menu, not a workflow. The whole design of this skill is
// the line between the pass that runs by default and the passes a user opts into, and
// that line is only real if the default pass cannot reach an unbounded, page-gated,
// per-result endpoint.
//
// The failure this guards is a one-word edit: moving `lead_search()` up into the brief
// so the default "feels more useful" turns a flat, exactly-priced default into one whose
// bill has no ceiling. Nothing else in the repo would notice.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, invokedEndpoints, ownedEndpoints, catalog, section, sections } from './helpers.mjs';
import { loadGates, gateValue, isUnbounded, parseDuration } from '../../../_lib/gates.mjs';

const CATALOG = catalog();
const GATES = loadGates();
const owned = ownedEndpoints();

/** The owned endpoints gates.yaml page-gates: no request field bounds the total charge. */
const pageGated = [...owned].filter(e => isUnbounded(GATES, e)).sort();

test('gates.yaml and the catalog agree on which of these endpoints are page-gated', () => {
  assert.deepEqual(pageGated, [
    'lead_search',
    'linkedin_ad_search',
    'linkedin_company_employees_search',
    'linkedin_company_posts',
    'post_activities',
    'profile_activities',
    'similarweb_scraper_sync',
  ], 'the page-gated subset of this skill moved — re-read the pass design before shipping');

  for (const e of owned) {
    const catalogSays = CATALOG.endpoints[e].pricing.page_gated === true;
    assert.equal(catalogSays, pageGated.includes(e),
      `${e}: catalog page_gated=${catalogSays} but gates.yaml unbounded=${pageGated.includes(e)} — `
      + 'the runtime reads gates; a disagreement here is a billing surprise waiting to happen');
  }
});

test('the default passes invoke ZERO page-gated endpoints', () => {
  const resolve = section(/^Pass 0\b/);
  const brief = section(/^Pass 1\b/);
  const def = resolve.text + '\n' + brief.text;
  const invoked = [...invokedEndpoints(def)];
  assert.ok(invoked.length > 0, 'the default passes must actually fetch something');

  const leaked = invoked.filter(e => pageGated.includes(e)).sort();
  assert.deepEqual(leaked, [],
    `the default passes invoke page-gated endpoint(s) ${leaked.join(', ')}. `
    + 'A default whose total is a ceiling rather than a total is not a default.');
});

test('every default-pass call is flat or has a required bound, so the plan total is exact', () => {
  const def = section(/^Pass 0\b/).text + '\n' + section(/^Pass 1\b/).text;
  for (const e of invokedEndpoints(def)) {
    const p = CATALOG.endpoints[e].pricing;
    if (p.model === 'flat') continue;
    // The one per-result call allowed in the default: web_sitemap bills on `count` and
    // its `limit` field is REQUIRED, so the limit chosen is the bill.
    assert.equal(e, 'web_sitemap', `${e} is ${p.model} in the default pass and is not web_sitemap`);
    assert.ok(CATALOG.endpoints[e].required_request_fields.includes('limit'),
      'web_sitemap only belongs in the default pass because `limit` is a required field');
  }
});

test('every page-gated endpoint lives in an opt-in pass, and the passes say they are opt-in', () => {
  const optIn = sections().filter(s => /^Pass [234]\b/.test(s.heading));
  assert.equal(optIn.length, 3, 'expected exactly three opt-in passes');
  const reachable = new Set(optIn.flatMap(s => [...invokedEndpoints(s.text)]));
  for (const e of pageGated) {
    assert.ok(reachable.has(e), `page-gated ${e} is not invoked in any opt-in pass`);
  }
  for (const s of optIn) {
    assert.match(s.heading, /opt-in/i, `"${s.heading}" does not declare itself opt-in`);
  }
});

test('the page gate itself is cited, not merely implied', () => {
  const body = skillBody();
  for (const key of ['unbounded_endpoints.pages_before_confirm',
    'unbounded_endpoints.hard_page_ceiling',
    'unbounded_endpoints.assumed_results_per_page',
    'unbounded_endpoints.endpoints']) {
    assert.ok(body.includes(`gates.yaml:${key}`), `the skill never cites gates.yaml:${key}`);
    assert.doesNotThrow(() => gateValue(GATES, key), `gates.yaml:${key} does not resolve`);
  }
});

test('profile_activities is treated as the trap it is', () => {
  const p = CATALOG.endpoints.profile_activities.pricing;
  // The three facts that make it dangerous, asserted against the catalog so this test
  // starts failing the moment any of them changes.
  assert.equal(p.model, 'per_result');
  assert.equal(p.result_count_field, 'totalElements');
  assert.equal(p.billing_field_present_in_response, false,
    'the charge is not in the response — if that ever changes, relax the prose');
  assert.ok(isUnbounded(GATES, 'profile_activities'));

  const s = section(/^Pass 3\b/);
  assert.match(s.text, /totalElements/,
    'the section must name the field the charge is levied on');
  assert.match(s.text, /estimated_unverifiable/,
    'the ledger writes estimated_unverifiable for this call (law 4) and the skill must say so');
  assert.match(s.text, /`limit`[^\n]*(?:not|does not) bound the bill|does not bound the bill/i,
    'the skill must say plainly that `limit` bounds the page and not the bill');
  assert.match(s.text, /One profile per call/i,
    'the skill must forbid fanning this endpoint across a committee');
  assert.ok(s.text.includes('gates.yaml:session_budget.fractions.single_call_confirm'),
    'a single call this large asks on its own — cite the fraction that makes it do so');
});

test('the cheap flat call gates the expensive per-result one', () => {
  const committee = section(/^Pass 2\b/);
  const voice = section(/^Pass 3\b/);
  assert.ok(committee.text.includes('profile_social_metrics()'),
    'profile_social_metrics() is the flat pre-check and belongs in the committee pass');
  assert.match(voice.text, /profile_social_metrics\(\)/,
    'the activity pass must point back at the flat pre-check as its precondition');
  assert.equal(CATALOG.endpoints.profile_social_metrics.pricing.model, 'flat',
    'the pre-check only works as a pre-check while it is flat-priced');
});

test('the unverifiable endpoints are named on the plan, not discovered in the receipt', () => {
  const body = skillBody();
  // REWRITTEN 2026-09-17. `billing_field_present_in_response` is now an EVIDENCE flag:
  // true only where a RECORDED 2xx body carries a numeric billing field. None do, so
  // the property is universal and a frozen four-name list can no longer be the
  // assertion. What still has to hold is the part that protects the user: the calls
  // this skill already marks on its plan are still marked, and law 4's ledger status
  // is still named. This fails against the old catalog, where the list was a subset.
  const unverifiable = [...owned]
    .filter(e => CATALOG.endpoints[e].pricing.billing_field_present_in_response === false)
    .sort();
  assert.deepEqual(unverifiable, [...owned].sort(),
    'no endpoint reports its charge, so every owned call is an estimate');
  const namedOnPlan = [
    'google_maps_reviews_scraper_sync',
    'meta_ads_library_scraper_sync',
    'profile_activities',
    'similarweb_scraper_sync',
  ];
  const plan = section(/Dry-run/i);
  for (const e of namedOnPlan) {
    assert.ok(plan.text.includes(`${e}()`),
      `${e} does not report its charge back; the dry-run section must mark it before the run`);
  }
  assert.match(body, /estimated_unverifiable/, 'law 4: those rows are written estimated_unverifiable');
});

test('the skill shows a plan before it spends, and takes one approval for it', () => {
  const body = skillBody();
  assert.match(body, /--dry-run/, 'no dry-run invocation anywhere');
  assert.match(body, /zero calls/i, 'the skill must state that a dry run makes no calls');
  assert.match(body, /richapi (?:call|search) /,
    'paid calls go through the gated runtime (`richapi call` / `richapi search`), never hand-rolled');
  assert.match(body, /one approval for the whole plan/i,
    'the user approves the plan, not a number said out loud');
});

test('a long cache TTL is claimed only where gates.yaml actually grants one', () => {
  const s = section(/second pass/i);
  for (const key of ['cache_ttl.endpoints.enrich_company',
    'cache_ttl.classes.firmographics',
    'cache_ttl.capability_groups.web_intelligence',
    'cache_ttl.capability_groups.funding',
    'cache_ttl.endpoints.profile_activities',
    'cache_ttl.classes.posts_activity']) {
    assert.ok(s.text.includes(`gates.yaml:${key}`), `the cache section never cites gates.yaml:${key}`);
    assert.doesNotThrow(() => gateValue(GATES, key), `gates.yaml:${key} does not resolve`);
  }
  // The claim "a second pass is nearly free" is only true because firmographics outlive
  // posts by a wide margin. If that inverts, the section is a lie.
  const firmo = parseDuration(gateValue(GATES, 'cache_ttl.classes.firmographics'));
  const posts = parseDuration(gateValue(GATES, 'cache_ttl.classes.posts_activity'));
  assert.ok(firmo > posts,
    'the cache section claims firmographics survive a re-run while posts do not; gates.yaml disagrees');
  assert.match(s.text, /not free|is not free|not free on a second visit/i,
    'the section must also say which pass is NOT cheap on a second visit');
});
