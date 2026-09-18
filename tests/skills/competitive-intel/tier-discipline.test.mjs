// tests/skills/competitive-intel/tier-discipline.test.mjs
//
// Fifteen endpoints is a menu, not a workflow. The whole design of this skill is the
// line between the tier that runs by default and the tiers a user opts into, and that
// line is only real if the default tier CANNOT reach a page-gated endpoint.
//
// The failure this guards is a one-line edit: moving `linkedin_ad_search` up into the
// default tier so the default "feels more useful" turns a flat, exactly-priced default
// into one whose bill has no ceiling. Nothing else in the repo would notice.
//
// The second failure is unique to this skill: a sweep multiplies every line by the
// number of rivals. That ceiling is merged now, so the OPEN path is the live one and is
// asserted against the shipped file — while the closed path, which is the one that
// costs money if it ever fails open, is asserted against a copy of the shipped gates
// with `skills.competitive_intel` STRIPPED back out. A fail-closed test pointed at "the
// real file happens to lack the key" stops testing anything the day the key lands; one
// pointed at a stripped block keeps testing law 5 for every future key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL, skillBody, skillSource, invokedEndpoints, ownedEndpoints, catalog, section, sections,
  gatesWithRequestedKeys, gatesWithout, REQUESTED_GATES,
} from './helpers.mjs';
import { loadGates, gateValue, hasGate, isUnbounded } from '../../../_lib/gates.mjs';
import {
  loadTierMap, defaultTier, tierEndpoints, allTierEndpoints, pageGatedIn,
  planSweep, pendingCeiling, TierMapUnavailable, ALLOW, STOP,
} from './harness.mjs';

const CATALOG = catalog();
const GATES = loadGates();
const MERGED = gatesWithRequestedKeys(GATES);
/** The shipped gates with this skill's whole block deleted — the law-5 input. */
const STRIPPED = gatesWithout(GATES, 'skills.competitive_intel');
const BODY = skillBody();
const MAP = loadTierMap();
const owned = ownedEndpoints();

const pageGated = [...owned].filter(e => isUnbounded(GATES, e)).sort();

// ---------------------------------------------------------------------------
// The block is the gate.
// ---------------------------------------------------------------------------

test('there is exactly one tier block, and it declares one default tier', () => {
  const fences = [...skillSource().matchAll(/^```yaml[ \t]+competitive-intel-tiers[ \t]*$/gm)];
  assert.equal(fences.length, 1, 'two tier blocks is no tier block');
  assert.equal(MAP.default_tier, 'posture');
  assert.equal(defaultTier(MAP).default, true);
  assert.equal(Object.keys(MAP.tiers).length, 4);
});

test('a block edit that promotes a page-gated endpoint into the default is caught', () => {
  // Not by the loader — by the rule below. This test documents which of the two the
  // failure lands on, so a future reader does not assume the loader covers it.
  const src = skillSource().replace(
    '      - search_google_trends\n    cost_shape: exact',
    '      - search_google_trends\n      - linkedin_ad_search\n    cost_shape: exact');
  const tampered = loadTierMap({ src });
  assert.ok(pageGatedIn(tampered, 'posture', GATES).includes('linkedin_ad_search'),
    'the page-gate check must see through the tier block, not trust its cost_shape label');
});

test('a block with two defaults, or none, is a STOP', () => {
  for (const [find, replace] of [
    ['    default: true\n    opt_in: false', '    default: false\n    opt_in: true'],
    ['  paid_acquisition:\n    question: What are they buying, and what are they saying in it?\n    default: false',
      '  paid_acquisition:\n    question: What are they buying, and what are they saying in it?\n    default: true'],
  ]) {
    const src = skillSource();
    assert.ok(src.includes(find), `tamper fixture is stale: ${find}`);
    assert.throws(() => loadTierMap({ src: src.replace(find, replace) }),
      (e) => e instanceof TierMapUnavailable);
  }
});

// ---------------------------------------------------------------------------
// The default tier.
// ---------------------------------------------------------------------------

test('gates.yaml and the catalog agree on which of these endpoints are page-gated', () => {
  assert.deepEqual(pageGated, [
    'linkedin_ad_search',
    'linkedin_company_posts',
    'profile_activities',
    'similarweb_scraper_sync',
  ], 'the page-gated subset of this skill moved — re-read the tier design before shipping');
  for (const e of owned) {
    const catalogSays = CATALOG.endpoints[e].pricing.page_gated === true;
    assert.equal(catalogSays, pageGated.includes(e),
      `${e}: catalog page_gated=${catalogSays} but gates.yaml unbounded=${pageGated.includes(e)} — `
      + 'the runtime reads gates; a disagreement here is a billing surprise waiting to happen');
  }
});

test('the DEFAULT TIER calls no page-gated endpoint', () => {
  const leaked = pageGatedIn(MAP, MAP.default_tier, GATES);
  assert.deepEqual(leaked, [],
    `the default tier reaches page-gated endpoint(s) ${leaked.join(', ')}. `
    + 'A default whose total is a ceiling rather than a total is not a default.');
  assert.ok(tierEndpoints(MAP, MAP.default_tier).length > 0, 'the default tier must fetch something');
});

test('every default-tier call is flat, so the plan total is exact rather than a ceiling', () => {
  for (const e of tierEndpoints(MAP, MAP.default_tier)) {
    const p = CATALOG.endpoints[e].pricing;
    // "Exact" means the price is fully determined BEFORE the call, which is what flat
    // pricing gives. It never meant the charge comes back in the response: no endpoint
    // reports its charge (billing_field_present_in_response is false everywhere), and
    // asserting `true` here was reading a flat price as a reconciliation.
    assert.equal(p.model, 'flat', `${e} is ${p.model} in the default tier`);
    assert.equal(p.credits_per_call !== null, true,
      `${e} has no flat price, so the tier total is not exact`);
  }
  assert.equal(defaultTier(MAP).cost_shape, 'exact');
});

test('every page-gated endpoint lives in an opt-in tier, and those tiers say they are opt-in', () => {
  const optIn = Object.entries(MAP.tiers).filter(([, t]) => t.opt_in === true);
  assert.equal(optIn.length, 3, 'expected exactly three opt-in tiers');
  const reachable = new Set(optIn.flatMap(([n]) => tierEndpoints(MAP, n)));
  for (const e of pageGated) {
    assert.ok(reachable.has(e), `page-gated ${e} is not reachable from any opt-in tier`);
  }
  for (const [, t] of optIn) assert.equal(t.cost_shape, 'ceiling');
});

test('the prose tiers and the block tiers are the same tiers', () => {
  // A block that drifts from the paragraphs above it is worse than no block: the tests
  // pass and the reader is told something else.
  const headings = sections(BODY).map(s => s.heading);
  assert.ok(headings.some(h => /^Tier 1 — posture \(the default/i.test(h)));
  for (const [name, t] of Object.entries(MAP.tiers)) {
    for (const e of t.endpoints) {
      assert.ok(new RegExp(`\`${e}\\(`).test(BODY),
        `tier ${name} lists ${e}, which the SKILL.md never invokes`);
    }
  }
});

test('the page gate itself is cited, not merely implied', () => {
  for (const key of ['unbounded_endpoints.pages_before_confirm',
    'unbounded_endpoints.hard_page_ceiling',
    'unbounded_endpoints.assumed_results_per_page',
    'unbounded_endpoints.endpoints',
    'always_ask.endpoints']) {
    assert.ok(BODY.includes(`gates.yaml:${key}`), `the skill never cites gates.yaml:${key}`);
    assert.doesNotThrow(() => gateValue(GATES, key), `gates.yaml:${key} does not resolve`);
  }
});

// ---------------------------------------------------------------------------
// The multiplier.
// ---------------------------------------------------------------------------

test('strip the block and not one of these ceilings resolves — the law-5 input is real', () => {
  // The guard on the guard, after tests/skills/evidence-score/rules-block.test.mjs. The
  // fail-closed cases below feed STRIPPED; if that strip ever became a no-op — the
  // block renamed, moved, nested differently — they would pass while proving nothing.
  for (const k of Object.keys(REQUESTED_GATES.competitive_intel)) {
    assert.equal(hasGate(STRIPPED, `skills.competitive_intel.${k}`), false,
      `skills.competitive_intel.${k} survived the strip`);
  }
});

test('a multi-competitor sweep is REFUSED when its ceiling does not resolve', () => {
  // Was: "while its ceiling does not exist" — true only because the shipped file had no
  // block. It has one now, so the refusal is proven against a gates object with the
  // block STRIPPED: same MissingGateKey -> STOP path, but it stays true for every
  // future key rather than expiring at the merge.
  //
  // One competitor is still allowed with no ceiling, because one is not a multiplier;
  // three is refused, because a sweep multiplies every line by the number of rivals and
  // nothing else in the pack can see that shape.
  const key = MAP.one_competitor_per_run_until;
  assert.equal(key, 'skills.competitive_intel.max_competitors_per_sweep');
  assert.equal(hasGate(STRIPPED, key), false, 'the strip must actually remove the key');

  const one = planSweep({ tier: 'posture', competitors: ['acme.example'], map: MAP, gates: STRIPPED });
  assert.equal(one.decision, ALLOW);
  assert.equal(one.failed_closed, true);

  const many = planSweep({
    tier: 'posture', competitors: ['acme.example', 'beta.example', 'gamma.example'],
    map: MAP, gates: STRIPPED,
  });
  assert.equal(many.decision, STOP);
  assert.equal(many.failed_closed, true);
  assert.equal(many.gate, key);
  assert.match(many.reason, /multiplies every line/);
});

test('with the merged ceiling in place, the sweep opens and still has a ceiling', () => {
  const key = 'skills.competitive_intel.max_competitors_per_sweep';
  const max = REQUESTED_GATES.competitive_intel.max_competitors_per_sweep;
  assert.equal(hasGate(GATES, key), true, 'the key must resolve now that it is merged');
  assert.equal(gateValue(GATES, key), max,
    'this suite is calibrated to that ceiling; reconcile a change deliberately');

  const list = (n) => Array.from({ length: n }, (_, i) => `rival${i}.example`);
  // On the SHIPPED file, so the open half is the live behaviour and not a fixture's.
  const at = planSweep({ tier: 'posture', competitors: list(max), map: MAP, gates: GATES });
  assert.equal(at.decision, ALLOW);
  assert.notEqual(at.failed_closed, true, 'the merged path must not be a fail-closed allow');
  assert.equal(planSweep({ tier: 'posture', competitors: list(max + 1), map: MAP, gates: GATES }).decision, STOP);
  assert.equal(planSweep({ tier: 'posture', competitors: list(max), map: MAP, gates: MERGED }).decision, ALLOW);
});

test('even the allowed sweep of the deep tiers reports its page-gated lines', () => {
  const plan = planSweep({ tier: 'voice', competitors: ['acme.example'], map: MAP, gates: GATES });
  assert.equal(plan.decision, ALLOW);
  assert.deepEqual(plan.page_gated, ['linkedin_company_posts', 'profile_activities']);
});

test('the other three ceilings are declared, and each one still closes something', () => {
  const expected = {
    'skills.competitive_intel.max_pages_per_run': REQUESTED_GATES.competitive_intel.max_pages_per_run,
    'skills.competitive_intel.ad_details_max_per_competitor': REQUESTED_GATES.competitive_intel.ad_details_max_per_competitor,
    'skills.competitive_intel.profile_activities_max_profiles': REQUESTED_GATES.competitive_intel.profile_activities_max_profiles,
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.ok(MAP.pending_gate_keys[key], `${key} is not declared in pending_gate_keys`);
    assert.ok(MAP.pending_gate_keys[key].closed_behaviour,
      `${key} declares no closed_behaviour — "missing key" must say what stops`);

    // Merged, at the value this suite is calibrated to.
    assert.equal(hasGate(GATES, key), true, `${key} must resolve now that it is merged`);
    assert.equal(gateValue(GATES, key), value,
      `${key} shipped as ${gateValue(GATES, key)}, not ${value} — reconcile it deliberately`);

    // Fail closed. Was asserted against the real file when it had no block; now the
    // input is MADE by deleting this one key, so the STOP is attributable to THAT key
    // rather than to whatever else the file does or does not contain. A request of 1 —
    // the smallest thing anyone can ask for — is refused, which is the whole property:
    // a missing ceiling is not a generous ceiling.
    const closed = pendingCeiling({ key, requested: 1, gates: gatesWithout(GATES, key), map: MAP });
    assert.equal(closed.decision, STOP);
    assert.equal(closed.failed_closed, true);

    // And on the SHIPPED file the ceiling is a ceiling: at it, allowed; one over, STOP.
    assert.equal(pendingCeiling({ key, requested: value, gates: GATES, map: MAP }).decision, ALLOW);
    assert.equal(pendingCeiling({ key, requested: value + 1, gates: GATES, map: MAP }).decision, STOP);
    assert.equal(pendingCeiling({ key, requested: value, gates: MERGED, map: MAP }).decision, ALLOW);
  }
  // And the SKILL.md cites every one of them in the resolvable form, now that they do.
  for (const key of Object.keys(MAP.pending_gate_keys)) {
    assert.ok(BODY.includes(`gates.yaml:${key}`),
      `${key} resolves now, so the SKILL.md must cite it as gates.yaml:${key}`);
    assert.ok(hasGate(GATES, key), `the SKILL.md cites gates.yaml:${key}, which does not resolve`);
  }
});

test('an undeclared pending key cannot be waved through', () => {
  const res = pendingCeiling({ key: 'skills.competitive_intel.invented', requested: 1, gates: MERGED, map: MAP });
  assert.equal(res.decision, STOP);
});

// ---------------------------------------------------------------------------
// The traps inside the deep tiers.
// ---------------------------------------------------------------------------

test('profile_activities is treated as the trap it is', () => {
  const p = CATALOG.endpoints.profile_activities.pricing;
  assert.equal(p.model, 'per_result');
  assert.equal(p.result_count_field, 'totalElements');
  assert.equal(p.billing_field_present_in_response, false,
    'the charge is not in the response — if that ever changes, relax the prose');
  assert.ok(isUnbounded(GATES, 'profile_activities'));
  assert.ok(gateValue(GATES, 'always_ask.endpoints').includes('profile_activities'));

  const s = section(/^Tier 3\b/);
  assert.match(s.text, /totalElements/, 'the tier must name the field the charge is levied on');
  assert.match(s.text, /estimated_unverifiable/, 'law 4');
  assert.match(s.text, /does not bound the bill/i,
    '`limit` bounds the page and not the bill, and the skill must say so plainly');
  assert.match(s.text, /one executive per run/i, 'the skill must forbid fanning this across executives');
  assert.ok(s.text.includes('gates.yaml:session_budget.fractions.single_call_confirm'));
  assert.ok(s.text.includes('gates.yaml:always_ask.endpoints'));
});

test('the unverifiable endpoints are named on the plan, not discovered in the receipt', () => {
  // REWRITTEN 2026-09-17. `billing_field_present_in_response` is now an EVIDENCE flag:
  // true only where a RECORDED 2xx body carries a numeric billing field. None do, so
  // the property is universal and a frozen four-name list can no longer be the
  // assertion. What still has to hold is the part that protects the user: the calls
  // this skill already marks on its plan are still marked, and law 4's ledger status
  // is still named. This fails against the old catalog, where the list was a subset.
  const unverifiable = [...owned]
    .filter(e => CATALOG.endpoints[e].pricing.billing_field_present_in_response === false).sort();
  assert.deepEqual(unverifiable, [...owned].sort(),
    'no endpoint reports its charge, so every owned call is an estimate');
  const namedOnPlan = [
    'google_ad_transparency_scraper_sync',
    'meta_ads_library_scraper_sync',
    'profile_activities',
    'similarweb_scraper_sync',
  ];
  const plan = section(/Dry-run the tiers/i);
  for (const e of namedOnPlan) {
    assert.ok(plan.text.includes(`${e}()`),
      `${e} does not report its charge back; the dry-run section must mark it before the run`);
  }
  assert.match(BODY, /estimated_unverifiable/);
});

test('the meta zero-default limit and the missing-spend claim are both stated', () => {
  const s = section(/^Tier 2\b/);
  assert.match(s.text, /defaults to zero/i,
    'meta_ads_library_scraper_sync `limit` defaults to zero — an unset limit is an unpriced call');
  assert.match(s.text, /not_found/,
    'no endpoint returns ad spend; the honest answer is the explicit null, not a derived number');
  assert.match(s.text, /\bNot spend\b/,
    'ad count presented as spend is the most repeated lie in competitive intelligence');
});

test('the keyword-search endpoint an earlier version used is named and never invoked', () => {
  assert.ok(!/`post_keyword_search\(/.test(BODY),
    'post_keyword_search is unclaimed and this skill must never invoke it');
  assert.match(BODY, /It will not search posts by keyword/,
    'the skill must say out loud that the old route is not used');
  assert.ok(!BODY.includes('gates.yaml:disabled.post_keyword_search'),
    'nothing disables it any more; the skill must not cite a reason that no longer exists');
});

test('the skill shows a plan before it spends, and takes one approval for it', () => {
  assert.match(BODY, /--dry-run/);
  assert.match(BODY, /zero calls/i);
  assert.match(BODY, /richapi call /);
  assert.match(BODY, /richapi search /);
  assert.match(BODY, /one approval for the whole plan/i);
  const plan = section(/Dry-run the tiers/i);
  assert.match(plan.text, /once per competitor/i,
    'the multiplier is the thing users do not price in their heads; it must be shown explicitly');
});

test('inference is local, and this skill does not own the paid LLM hop', () => {
  assert.equal(MAP.inference.mode, 'local_agent');
  assert.equal(MAP.inference.ai_enrich_owned, false);
  assert.ok(!owned.has('ai_enrich'), 'endpoint-owners.yaml does not give ai_enrich to this skill');
  assert.ok(!/`ai_enrich\(/.test(BODY), 'a local-inference skill must not invoke the paid LLM hop');
  assert.match(BODY, /Inference mode: local/i, 'a local-inference skill states its mode and why');
  assert.match(BODY, /Perplexity web\s+grounding|Perplexity web grounding/i,
    'the skill must say which two conditions would justify the paid hop, and that neither applies');
});

test('the tier block covers the whole owned surface exactly once per endpoint', () => {
  assert.deepEqual(allTierEndpoints(MAP), [...owned].sort());
  const flat = Object.values(MAP.tiers).flatMap(t => t.endpoints);
  assert.equal(flat.length, new Set(flat).size, 'an endpoint appears in two tiers');
  assert.deepEqual([...invokedEndpoints(BODY)].sort(), [...owned].sort(),
    `${SKILL} must invoke exactly the endpoints it owns`);
});
