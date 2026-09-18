// tests/skills/signal-watch/recurring-cost.test.mjs
//
// /signal-watch is the only recurring-cost skill in the pack. Every other skill spends
// once, when a human asks, and the receipt closes the session. This one spends every
// cycle, and the bill compounds while nobody is watching.
//
// The requirement is therefore not "the plan is priced" — every skill does that. It is
// that the STANDING cost is computed and shown BEFORE the first cycle, in the unit the
// user is actually billed in. Two halves are tested here:
//
//   1. the arithmetic is derivable from the catalog and gates.yaml ALONE, and fails
//      closed rather than guessing when a price is missing; and
//   2. the SKILL.md actually puts that number in front of the user before the first
//      cycle, as a per-week and per-month figure, with exact rows and ranged rows kept
//      visibly apart.
//
// A skill that priced one cycle and called it a plan would pass every other test in
// this directory and still be the failure this file exists to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';
import { catalog, skillBody, sections, section, proseOnly, SKILL_MD } from './helpers.mjs';

const CATALOG = catalog();
const GATES = loadGates();
const body = skillBody();

/** Markdown wraps prose across lines; a phrase assertion must not care where. */
const flat = (t) => t.replace(/\s+/g, ' ');

const HOURS_IN_A_WEEK = 24 * 7;
const WEEKS_IN_A_MONTH = 52 / 12;

/**
 * The projection the SKILL.md specifies, implemented against the real catalog.
 *
 * Everything is read; nothing is typed. `perCall` throws on an endpoint the catalog
 * cannot price, because law 5 says a missing input is a STOP and never a default — a
 * subscription quoted from a guessed price is the exact thing this skill exists to
 * prevent.
 */
export function perCallCredits (endpoint, { resultsPerPage, endpoints = CATALOG.endpoints } = {}) {
  const def = endpoints[endpoint];
  if (!def || !def.pricing) throw new Error(`no catalog entry for ${endpoint} — STOP, not a guess`);
  const p = def.pricing;
  if (p.model === 'flat') {
    if (typeof p.credits_per_call !== 'number') throw new Error(`${endpoint}: flat with no price — STOP`);
    return { credits: p.credits_per_call, exact: true, verifiable: p.billing_field_present_in_response };
  }
  if (typeof p.credits_per_result !== 'number') throw new Error(`${endpoint}: per-result with no rate — STOP`);
  const base = typeof p.credits_base === 'number' ? p.credits_base : 0;
  return {
    credits: base + p.credits_per_result * resultsPerPage,
    exact: false,
    verifiable: p.billing_field_present_in_response,
  };
}

export function projectSubscription ({ entities, watches, intervalHours, endpoints = CATALOG.endpoints }) {
  if (!Number.isFinite(entities) || entities <= 0) throw new Error('entities must be positive');
  if (!Number.isFinite(intervalHours) || intervalHours <= 0) throw new Error('interval must be positive');
  const resultsPerPage = gateValue(GATES, 'unbounded_endpoints.assumed_results_per_page');
  const rows = watches.map(w => {
    const c = perCallCredits(w, { resultsPerPage, endpoints });
    return { watch: w, per_entity: c.credits, exact: c.exact, verifiable: c.verifiable };
  });
  const perCycle = entities * rows.reduce((n, r) => n + r.per_entity, 0);
  const cyclesPerWeek = HOURS_IN_A_WEEK / intervalHours;
  const perWeek = cyclesPerWeek * perCycle;
  return {
    rows,
    entities,
    interval_hours: intervalHours,
    cycles_per_week: cyclesPerWeek,
    per_cycle: perCycle,
    per_week: perWeek,
    per_month: WEEKS_IN_A_MONTH * perWeek,
    exact: rows.every(r => r.exact),
    unverifiable_watches: rows.filter(r => r.verifiable === false).map(r => r.watch),
    estimate_basis: rows.every(r => r.exact) ? null : 'gates.yaml:unbounded_endpoints.assumed_results_per_page',
  };
}

const DEFAULT_WATCHES = ['search_bing', 'web_tech_stack'];
const ALL_WATCHES = [
  'search_bing', 'web_tech_stack', 'linkedin_job_search', 'linkedin_job_detail',
  'linkedin_ad_search', 'linkedin_company_posts', 'crunchbase_company_scraper_sync',
  'google_search_scraper_sync', 'lead_search',
];

// --- 1. the arithmetic --------------------------------------------------------------

test('the recurring cost is computable from the catalog and gates.yaml alone', () => {
  const floor = gateValue(GATES, 'watchlist.min_refresh_interval_hours');
  const p = projectSubscription({ entities: 10, watches: DEFAULT_WATCHES, intervalHours: floor });
  assert.ok(p.per_cycle > 0, 'a cycle over a non-empty watchlist costs something');
  assert.ok(p.exact, 'the default watch set is flat-priced, so its projection is a total, not a ceiling');
  assert.equal(p.estimate_basis, null, 'an exact projection must not claim an estimate basis');
});

test('the per-week figure is strictly larger than the per-cycle figure at any sub-weekly cadence', () => {
  const floor = gateValue(GATES, 'watchlist.min_refresh_interval_hours');
  assert.ok(floor < HOURS_IN_A_WEEK,
    'the interval floor is sub-weekly, which is exactly why the weekly figure is the one that matters');
  const p = projectSubscription({ entities: 10, watches: DEFAULT_WATCHES, intervalHours: floor });
  assert.ok(p.per_week > p.per_cycle,
    'quoting a cycle instead of a week understates the standing charge — the whole failure mode');
  assert.ok(p.per_month > p.per_week);
  assert.ok(Math.abs(p.cycles_per_week - HOURS_IN_A_WEEK / floor) < 1e-9);
});

test('the standing charge compounds in all three dimensions, and only one has a ceiling', () => {
  const floor = gateValue(GATES, 'watchlist.min_refresh_interval_hours');
  const base = projectSubscription({ entities: 10, watches: DEFAULT_WATCHES, intervalHours: floor });

  const moreEntities = projectSubscription({ entities: 20, watches: DEFAULT_WATCHES, intervalHours: floor });
  const moreWatches = projectSubscription({ entities: 10, watches: ALL_WATCHES, intervalHours: floor });
  const faster = projectSubscription({ entities: 10, watches: DEFAULT_WATCHES, intervalHours: floor / 2 });

  assert.ok(moreEntities.per_week > base.per_week);
  assert.ok(moreWatches.per_week > base.per_week);
  assert.ok(faster.per_week > base.per_week);

  // gates.yaml bounds the entity count. It bounds neither of the other two multipliers,
  // which is precisely why the number has to be stated rather than gated.
  assert.ok(Number.isFinite(gateValue(GATES, 'watchlist.max_entities')));
  assert.ok(Number.isFinite(gateValue(GATES, 'watchlist.max_entities_hard_stop')));
  assert.ok(/nothing in `gates\.yaml` bounds the product/i.test(flat(body)),
    'the skill must say out loud that the ceilings bound one multiplier out of three');
});

test('a watchlist at the soft ceiling on the fastest legal cadence is a real, quotable weekly number', () => {
  const entities = gateValue(GATES, 'watchlist.max_entities');
  const floor = gateValue(GATES, 'watchlist.min_refresh_interval_hours');
  const p = projectSubscription({ entities, watches: ALL_WATCHES, intervalHours: floor });
  assert.ok(p.per_week > p.per_cycle);
  assert.equal(p.exact, false, 'the full watch set contains per-result endpoints, so it is a range');
  assert.equal(p.estimate_basis, 'gates.yaml:unbounded_endpoints.assumed_results_per_page');
  // Every watch, not one: no recorded response carries a charge, so a recurring
  // subscription is quoted entirely from catalog prices. The quote is still real —
  // that is what `exact`/`estimate_basis` above pin — it is simply never reconciled.
  assert.deepEqual([...p.unverifiable_watches].sort(), [...ALL_WATCHES].sort(),
    'no watch bills on a count the response carries back');
});

test('a missing catalog price is a STOP, never a zero and never a guess', () => {
  const stripped = { ...CATALOG.endpoints };
  delete stripped.web_tech_stack;
  assert.throws(
    () => projectSubscription({ entities: 10, watches: DEFAULT_WATCHES, intervalHours: 24, endpoints: stripped }),
    /no catalog entry for web_tech_stack/,
    'projecting a subscription over an unpriced endpoint must refuse, not quote a smaller number');

  const priceless = { ...CATALOG.endpoints, web_tech_stack: { pricing: { model: 'flat', credits_per_call: null } } };
  assert.throws(
    () => projectSubscription({ entities: 10, watches: DEFAULT_WATCHES, intervalHours: 24, endpoints: priceless }),
    /flat with no price/);
});

test('the projection reads prices only from the catalog, so a reprice moves it', () => {
  const before = projectSubscription({ entities: 10, watches: ['web_tech_stack'], intervalHours: 24 });
  const repriced = {
    ...CATALOG.endpoints,
    web_tech_stack: {
      ...CATALOG.endpoints.web_tech_stack,
      pricing: { ...CATALOG.endpoints.web_tech_stack.pricing, credits_per_call: CATALOG.endpoints.web_tech_stack.pricing.credits_per_call * 8 },
    },
  };
  const after = projectSubscription({ entities: 10, watches: ['web_tech_stack'], intervalHours: 24, endpoints: repriced });
  assert.ok(after.per_week > before.per_week,
    'law 1: 16 of 53 surviving endpoints repriced in four months and phone_finder moved 8.3x. '
    + 'A standing charge quoted from a hand-typed price is wrong by the time anyone reads it.');
});

// --- 2. the SKILL.md actually shows it, before the first cycle ----------------------

test('the subscription line is a named section and it precedes every section that spends', () => {
  const all = sections(body);
  const subscription = section(/subscription line/i, body);
  const runCycle = section(/run a cycle/i, body);
  const baseline = section(/first cycle is a baseline/i, body);

  assert.ok(subscription.index < runCycle.index,
    'the standing charge must be priced before the section that runs a cycle');
  assert.ok(subscription.index < baseline.index,
    'even the baseline cycle is a cycle and it is not free — price first');

  // Nothing that invokes an endpoint may appear before the subscription section, other
  // than the subscription section's own dry-run block.
  const earlier = all.filter(s => s.index < subscription.index);
  for (const s of earlier) {
    const invoked = [...s.text.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1])
      .filter(t => CATALOG.endpoints[t]);
    if (invoked.length === 0) continue;
    assert.match(s.heading, /choose the watches|cache TTL/i,
      `section "${s.heading}" names paid endpoints before the subscription line and is not a menu section`);
  }
});

test('the subscription line is quoted per cycle, per week AND per month', () => {
  const s = section(/subscription line/i, body).text;
  assert.match(s, /per cycle/i);
  assert.match(s, /per week/i);
  assert.match(s, /per month/i);
  assert.match(s, /standing charge/i,
    'the words "standing charge" are the point: this is a subscription, not a purchase');
  assert.match(s, /repeats/i, 'it must say the charge repeats until stopped');
});

test('the projection formula is in the document and carries no typed prices', () => {
  const s = section(/three multipliers/i, body).text;
  assert.match(s, /cost_per_cycle/);
  assert.match(s, /cost_per_week/);
  assert.match(s, /cycles_per_week/);
  assert.match(s, /catalog/i, 'the per-watch price comes from the catalog, never from this document');
});

test('exact rows and ranged rows are kept apart, with the estimate basis named', () => {
  const s = section(/subscription line/i, body).text;
  assert.match(s, /gates\.yaml:unbounded_endpoints\.assumed_results_per_page/,
    'a ranged row must name its estimate basis');
  assert.match(s, /exact/i);
  assert.match(s, /estimated_unverifiable/,
    'the unverifiable row is named on the plan, not discovered in the receipt');
  assert.match(s, /standing approval/i);
  assert.match(s, /reproject_every_cycles/,
    'a standing charge must re-price itself, because the catalog moves under it');
});

test('no cycle may run without an approved subscription line, and the skill says so twice', () => {
  assert.match(body, /No cycle runs until this exists and has been approved/i);
  const boundary = section(/will not do/i, body).text;
  assert.match(boundary, /will not run a cycle without an approved subscription line/i,
    'the boundary section restates it, because a one-shot framing is how a recurring '
    + 'charge gets approved as a one-off');
});

test('every digest restates the compounding total, not just this cycle', () => {
  const report = section(/report honestly/i, body).text;
  assert.match(flat(report), /since the watch started/i,
    'the cost-to-date is the number that answers "is this worth it"');
  assert.match(flat(report), /projected next week/i);
});

test('the SKILL.md carries no hand-typed credit numbers at all (law 1, checked directly)', () => {
  const findings = scanForBareNumbers(body, { file: SKILL_MD });
  assert.deepEqual(findings, [], findings.map(f => `${f.line}: ${f.message}`).join('\n'));
});

test('the watchlist ceilings are never restated as prose numerals', () => {
  const prose = proseOnly(body)
    .split('\n')
    .filter(l => !/gates\.yaml/.test(l))   // a line citing its key is not a bare number
    .join('\n');
  for (const key of ['max_entities', 'max_entities_hard_stop', 'max_refresh_batch', 'min_refresh_interval_hours']) {
    const value = String(gateValue(GATES, `watchlist.${key}`));
    assert.ok(!new RegExp(`\\b${value}\\b`).test(prose),
      `watchlist.${key} (${value}) appears as a literal in the prose — cite the key instead (law 1)`);
  }
});
