// tests/skills/inbound/per-lead-bound.test.mjs
//
// THE ASSERTION THAT MATTERS IN THIS SUITE.
//
// /inbound targets under five minutes from form to owner, and an inbound form is filled
// at 02:14 on a Sunday when there is nobody to approve anything. Law 3 has no
// exceptions, so the gate cannot be removed. The resolution shipped in the SKILL.md is
// that the spend is made small, FIXED and pre-approved as a standing policy: the human
// approves one exact recipe, once, in advance, and the recipe's price is a
// catalog-derived constant that does not vary from lead to lead.
//
// That argument is only sound while the premise holds. The premise is:
//
//   every endpoint this skill owns is flat-priced, bounded, and NOT page-gated,
//   therefore the per-lead cost has a finite ceiling computable before the lead arrives.
//
// A per-result or page-gated hop would make the per-lead cost a function of a result
// set nobody has seen yet, and a standing approval over an unknown number is a blank
// cheque. So the premise is asserted here against the catalog and against gates.yaml,
// not eyeballed — the catalog reprices (16 of 53 endpoints in four months) and this is
// the test that turns "a hop became page-gated" into a red run instead of a surprise.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillBody, ownedEndpoints, catalog, gates, citedGateKeys, bodyWithoutFences,
} from './helpers.mjs';

const CATALOG = catalog();
const GATES = gates();
const owned = [...ownedEndpoints()].sort();
const body = skillBody();

test('every hop this skill owns is flat-priced — no per-result, no per-page billing', () => {
  for (const name of owned) {
    const p = CATALOG.endpoints[name].pricing;
    assert.equal(p.model, 'flat', `${name} bills ${p.model}, not flat — the per-lead ceiling is no longer a constant`);
    assert.equal(typeof p.credits_per_call, 'number', `${name} has no flat per-call price in the catalog`);
    assert.ok(Number.isFinite(p.credits_per_call), `${name}'s price is not finite`);
    assert.equal(p.credits_per_result, null, `${name} bills per result — the cost depends on a result set nobody has seen`);
    assert.equal(p.result_count_field, null, `${name} bills on a count field, so its charge is not knowable in advance`);
  }
});

test('every hop this skill owns is bounded and not page-gated, in BOTH files', () => {
  const unbounded = new Set(GATES.unbounded_endpoints.endpoints);
  for (const name of owned) {
    const p = CATALOG.endpoints[name].pricing;
    assert.equal(p.bounded, true, `${name} is unbounded in the catalog`);
    assert.equal(p.page_gated, false, `${name} is page_gated in the catalog`);
    assert.ok(!unbounded.has(name),
      `${name} is in gates.yaml:unbounded_endpoints.endpoints. A page gate puts a human `
      + 'between pages, which is incompatible with an unattended five-minute target. '
      + 'The standing approval must be redesigned, not re-approved.');
  }
  // Both files, because they have disagreed before: profile_activities is marked
  // bounded in the catalog and unbounded in gates.yaml, and gates is the one the
  // runtime reads. Checking only one of them would miss exactly that case.
});

test('the per-lead ceiling is therefore a finite constant computable from the catalog', () => {
  const total = owned.reduce((n, name) => n + CATALOG.endpoints[name].pricing.credits_per_call, 0);
  assert.ok(Number.isFinite(total) && total > 0,
    'the whole owned surface must price to a finite number before any lead arrives');
  // The DEFAULT recipe is a subset: email_finder is deliberately outside the standing
  // approval, so the unattended ceiling is strictly below the whole-surface total.
  const defaultRecipe = [
    'identify_email_type', 'find_linkedin_url_by_email', 'enrich_profile',
    'enrich_company', 'distribute_leads',
  ];
  const recipeTotal = defaultRecipe.reduce((n, name) => n + CATALOG.endpoints[name].pricing.credits_per_call, 0);
  assert.ok(recipeTotal < total,
    'the unattended recipe must cost strictly less than the full owned surface — '
    + 'the expensive conditional hops are opted into with a human present');
  assert.ok(recipeTotal > 0);
});

test('the SKILL.md states the per-lead bound, and states it as catalog-derived', () => {
  assert.match(body, /per-lead ceiling/i, 'the skill must name a per-lead ceiling');
  assert.match(body, /catalog-derived constant/i,
    'the ceiling must be described as derived from the catalog, never typed (law 1)');
  assert.match(body, /unbounded_endpoints\.endpoints/,
    'the skill must cite the page-gate list it is asserting it stays out of');
  assert.match(body, /flat-priced, bounded/i,
    'the premise the standing approval rests on has to be stated in the body, not only in this test');
});

test('the SKILL.md carries no hand-typed credit number for that ceiling (law 1)', () => {
  // Belt and braces over the validator's own scanner: any digit followed by
  // credits/cr outside a fence is a hand-typed price.
  const prose = bodyWithoutFences(body);
  const hits = [...prose.matchAll(/(?<!\w)(\d[\d,]*(?:\.\d+)?)\s*(?:credits?|cr)\b/gi)]
    .filter(m => !/gates\.yaml/.test(prose.slice(Math.max(0, m.index - 200), m.index + 200)));
  assert.deepEqual(hits.map(h => h[0]), [],
    'a credit number is written in prose. Prices rot: phone_finder went 3 -> 25 credits in four months.');
});

test('the standing approval is bound, expiring and voidable — all four codes are named', () => {
  for (const code of ['NO_STANDING_APPROVAL', 'RECIPE_MISMATCH', 'STALE_APPROVAL', 'OVER_PER_LEAD_CEILING']) {
    assert.ok(body.includes(code), `the skill must name the ${code} refusal and its fix`);
  }
  assert.match(body, /recipe hash/i,
    'the approval must be bound to what it approved, the way /launch binds a verdict to a list hash');
  assert.ok(/reprice/i.test(body),
    'the skill must say that a reprice voids the approval — that is what stops it decaying into a blank cheque');
});

test('the gate is moved earlier, not removed: every lead is still dry-run and journalled', () => {
  assert.match(body, /dry[- ]run/i, 'law 3 requires the plan before the spend, on every lead');
  assert.match(body, /Every lead is still dry-run/i,
    'the skill must state plainly that the standing approval does not skip the plan');
  assert.match(body, /journal/i, 'the plan must survive the run as a record');
});

test('unattended, a confirm is a stop — silence is never consent', () => {
  assert.match(body, /Unattended, a\s*\n?\s*\*\*confirm is a stop\*\*|confirm is a stop/i,
    'an unanswered confirm must queue the lead, never proceed');
  assert.match(body, /queue/i, 'the blocked outcome has to be a queue with the plan attached');
  assert.ok(/never a retry/i.test(body),
    'a non-zero exit must not be retried with a bigger budget — that is working around the gate');
});

test('the session-spend gates are cited and not pre-approved away', () => {
  const cited = new Set(citedGateKeys(body));
  for (const key of [
    'session_budget.fractions.confirm',
    'session_budget.fractions.stop',
    'session_budget.fractions.single_call_confirm',
    'session_budget.on_stop',
    'always_ask.endpoints',
    'unbounded_endpoints.endpoints',
  ]) {
    assert.ok(cited.has(key), `the skill must cite gates.yaml:${key}`);
  }
});

test('the most expensive hop is explicitly outside the standing approval', () => {
  // email_finder fires on the weakest input and is the priciest thing this skill can
  // reach. A broken form or a bot flood could ask for it thousands of times.
  const prices = Object.fromEntries(owned.map(n => [n, CATALOG.endpoints[n].pricing.credits_per_call]));
  const dearest = owned.reduce((a, b) => (prices[a] >= prices[b] ? a : b));
  assert.equal(dearest, 'email_finder',
    'the priciest owned hop changed; re-check which hop must sit outside the standing approval');
  assert.match(body, /`email_finder\(\)`[^.]*\*\*outside the standing approval\*\*/,
    'email_finder must be named as excluded from unattended running');
});
