// tests/skills/research-agent/fan-out.test.mjs
//
// The cost half of the skill. /research-agent is the most cost-dangerous skill in the
// pack after /tam-map for one structural reason: the user does not know what they are
// asking for in credits. "Just check one thing for each" is per-row cost times rows,
// and neither factor is visible in the sentence.
//
// So these tests assert the PLAN, not the prose: that a freeform question produces a
// per-row fan-out AND a list total before anything runs, that the prices come out of
// the generated catalog rather than out of this file, that the hops which can never
// be reconciled are marked on the plan, and that every ceiling fails closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadResearchRoutes, classifyQuestion, planFanOut, pilotVerdict, planLlmHop,
  ROUTE, REFUSE, STOP,
} from './harness.mjs';
import { catalog, gatesWithRequestedKeys, gatesWithout, REQUESTED_GATES } from './helpers.mjs';
import { loadGates, gateValue, hasGate } from '../../../_lib/gates.mjs';
import { priceCall } from '../../../_lib/dryrun.mjs';

const ROUTES = loadResearchRoutes();
const CATALOG = catalog();
const REAL_GATES = loadGates();                       // the shipped file: block merged
const MERGED = gatesWithRequestedKeys(REAL_GATES);    // the same, with this suite's pins
/** The shipped gates with this skill's whole block deleted — the law-5 input. */
const STRIPPED = gatesWithout(REAL_GATES, 'skills.research_agent');

const plan = (question, opts = {}) => planFanOut({
  question, catalog: CATALOG, gates: MERGED, routes: ROUTES, ...opts,
});

test('a freeform question shows its full fan-out — per row AND the list total — before it runs', () => {
  const p = plan('find their pricing page and tell me the plans', { rows: 412 });

  assert.equal(p.decision, ROUTE);
  assert.equal(p.template, 'site_page_lookup');
  assert.equal(p.dry_run, true);
  assert.equal(p.calls_made, 0, 'planning must make zero calls');

  // Per row: every hop named, with its own price.
  assert.ok(p.per_row.length > 1, 'a multi-hop template must show every hop');
  for (const hop of p.per_row) {
    assert.ok(CATALOG.endpoints[hop.endpoint], `${hop.endpoint} is not in the catalog`);
    assert.equal(typeof hop.credits, 'number', `${hop.endpoint} has no price on the plan`);
  }

  // And the multiplication, which is the line a freeform ask hides.
  assert.equal(typeof p.per_row_credits, 'number');
  assert.equal(p.rows, 412);
  assert.equal(p.list_total_credits, p.per_row_credits * 412);
  assert.ok(p.list_total_credits > p.per_row_credits, 'the list total must not be the per-row cost');
  assert.equal(p.requires_approval, true);
});

test('every price on the plan comes out of the generated catalog, never out of the skill', () => {
  // Law 1. If a price were typed anywhere, re-pricing from the catalog independently
  // would disagree with the plan. phone_finder went 3 -> 25 credits in four months.
  const p = plan('what recent news is there about them', { rows: 10, expectedResults: 5 });
  assert.equal(p.template, 'open_web_fact');
  let expected = 0;
  for (const hop of p.per_row) {
    const fromCatalog = priceCall(CATALOG.endpoints[hop.endpoint], { expectedResults: 5 });
    assert.equal(hop.credits, fromCatalog.credits, `${hop.endpoint} priced off-catalog`);
    assert.equal(hop.basis, fromCatalog.basis);
    if (!hop.optional && fromCatalog.known) expected += fromCatalog.credits;
  }
  assert.equal(p.per_row_credits, expected);
  assert.equal(p.list_total_credits, expected * 10);
});

test('a per-result hop with no result count is UNPRICED, and an unpriced line stops the plan', () => {
  // "The limit you set IS the estimate basis, so an unset limit is an unpriced call."
  // An unknown cost is reported as unknown and blocks approval — never silently zero.
  const p = plan('what recent news is there about them', { rows: 10 });
  assert.equal(CATALOG.endpoints.google_search_scraper_sync.pricing.model, 'per_result');
  assert.ok(p.unpriced_hops.includes('google_search_scraper_sync'), JSON.stringify(p.unpriced_hops));
  assert.equal(p.per_row_credits, null, 'an unknown cost must not be priced at zero');
  assert.equal(p.list_total_credits, null);
  assert.equal(p.blocked, true);
});

test('a hop whose charge is absent from its response is marked unreconcilable ON THE PLAN', () => {
  // Law 4, and the point is the timing: it belongs on the plan, not in the receipt
  // afterwards, because afterwards is too late to decline it.
  const p = plan('what recent news is there about them', { rows: 5, expectedResults: 5 });
  assert.ok(p.unverifiable_hops.includes('google_search_scraper_sync'),
    `expected the unverifiable search hop to be flagged, saw ${JSON.stringify(p.unverifiable_hops)}`);
  assert.equal(
    CATALOG.endpoints.google_search_scraper_sync.pricing.billing_field_present_in_response, false,
    'the catalog is the source of that fact, not this test');
  for (const hop of p.per_row) {
    if (hop.endpoint === 'google_search_scraper_sync') assert.equal(hop.actual_verifiable, false);
  }
});

test('the free decisions never reach a price — a refusal, a handoff and a reformat cost nothing', () => {
  for (const q of [
    "What is this 4-person company's exact ARR?",   // register
    'reformat these rows',                          // local
    'find the ceo of each of these',                // handoff
    'what colour is their office carpet',           // unmatched -> refuse
  ]) {
    const p = plan(q, { rows: 5000 });
    assert.equal(p.calls_made, 0);
    assert.equal(p.per_row.length, 0, `"${q}" planned a paid hop`);
    assert.equal(p.list_total_credits, 0, `"${q}" costs money`);
    assert.equal(p.spend, 'none');
  }
});

test('a question that belongs to another skill is handed off, not shadowed', () => {
  const cases = {
    'find the ceo of each of these': 'build-prospect-list',
    'what tech stack do they run': 'account-research',
    'check for domain validation across the list': 'list-hygiene',
    'what job posts are open': 'signal-watch',
  };
  for (const [q, skill] of Object.entries(cases)) {
    const cls = classifyQuestion({ question: q, routes: ROUTES });
    assert.equal(cls.decision, 'handoff', `"${q}" was not handed off`);
    assert.equal(cls.handoff_to, skill, `"${q}" went to ${cls.handoff_to}`);
    assert.equal(cls.planned_calls, 0);
  }
});

test('strip the block and not one of these ceilings resolves — the law-5 input is real', () => {
  // The guard on the guard, after tests/skills/evidence-score/rules-block.test.mjs. The
  // fail-closed tests below feed STRIPPED; if that strip ever became a no-op — the
  // block renamed, moved, nested differently — they would pass while proving nothing.
  for (const k of Object.keys(REQUESTED_GATES.research_agent)) {
    assert.equal(hasGate(STRIPPED, `skills.research_agent.${k}`), false,
      `skills.research_agent.${k} survived the strip`);
  }
});

test('every ceiling FAILS CLOSED when its gate key does not resolve', () => {
  // Was: "while its gate key is unmerged" — asserted against the real file, which
  // happened to lack the block. It has one now, so the fail-closed input is MADE: a
  // copy of the shipped gates with `skills.research_agent` deleted. Same
  // MissingGateKey -> STOP path, but it stays true for every future key, and it is a
  // property of the CODE (a lost merge hunk wedges the skill) rather than an accident
  // of the file's current contents.
  //
  // A skill that cannot read its fan-out ceiling must refuse to fan out. It must never
  // read the absence as "no ceiling" — that is the one failure that spends money.
  const p = planFanOut({
    question: 'find their pricing page', rows: 10, catalog: CATALOG,
    gates: STRIPPED, routes: ROUTES,
  });
  assert.equal(p.blocked, true, 'an unreadable ceiling must block the run');
  const stopped = p.stops.map(s => s.gate);
  for (const key of ['skills.research_agent.max_rows_per_run',
    'skills.research_agent.max_endpoints_per_row',
    'skills.research_agent.pilot_rows']) {
    assert.ok(stopped.includes(key), `${key} did not STOP when absent`);
  }
  for (const s of p.stops) {
    assert.equal(s.decision, STOP);
    assert.equal(s.failed_closed, true);
  }

  // And the same plan against the SHIPPED file is not blocked, so the STOP above is
  // specific to the missing key rather than to something else about the question.
  const shipped = planFanOut({
    question: 'find their pricing page', rows: 10, catalog: CATALOG,
    gates: REAL_GATES, routes: ROUTES,
  });
  assert.equal(shipped.blocked, false, 'the merged keys must let a bounded plan through');
  assert.deepEqual(shipped.stops ?? [], []);
  assert.equal(plan('find their pricing page', { rows: 10 }).blocked, false);
});

test('the merged ceilings resolve at the values this suite is calibrated to', () => {
  // Pinning the VALUES, not only their presence: a ceiling edited in gates.yaml would
  // otherwise re-price every fan-out below while these tests stayed green.
  for (const [k, expected] of Object.entries(REQUESTED_GATES.research_agent)) {
    const dotted = `skills.research_agent.${k}`;
    assert.ok(hasGate(REAL_GATES, dotted), `${dotted} does not resolve`);
    assert.equal(gateValue(REAL_GATES, dotted), expected,
      `${dotted} shipped as ${gateValue(REAL_GATES, dotted)}, not ${expected} — this suite's `
      + 'fan-out arithmetic is calibrated to the second number; reconcile it deliberately');
  }
});

test('the row ceiling and the fan-out WIDTH both stop, and width is the one people miss', () => {
  const tooMany = plan('find their pricing page',
    { rows: REQUESTED_GATES.research_agent.max_rows_per_run + 1 });
  assert.equal(tooMany.blocked, true);
  assert.ok(tooMany.stops.some(s => s.gate === 'skills.research_agent.max_rows_per_run'));

  // Width: four hops over a thousand rows is four thousand calls, and no per-endpoint
  // gate in the pack sees that shape, because each hop looks small on its own.
  const narrow = gatesWithRequestedKeys(REAL_GATES);
  narrow.skills.research_agent.max_endpoints_per_row = 1;
  const wide = planFanOut({
    question: 'find their youtube channel', rows: 10, catalog: CATALOG, gates: narrow, routes: ROUTES,
  });
  assert.equal(wide.blocked, true);
  assert.ok(wide.stops.some(s => s.gate === 'skills.research_agent.max_endpoints_per_row'),
    JSON.stringify(wide.stops));

  // The widest template in the library fits the requested ceiling exactly, so the
  // ceiling is a real constraint on the NEXT template rather than a dead number.
  const widest = Math.max(...ROUTES.templates.map(t => (t.route || []).length));
  assert.equal(widest, REQUESTED_GATES.research_agent.max_endpoints_per_row);
});

test('the pilot slice gates the full run on the ANSWERED fraction, not on the spend', () => {
  // A question that answers one row in ten is not worth paying for on the other four
  // hundred and ninety. The fix is a better question, not more rows.
  const floor = gateValue(REAL_GATES, 'quality_stops.coverage_min_pct');
  const bad = pilotVerdict({ answered: 2, total: 20, gates: REAL_GATES, routes: ROUTES });
  assert.equal(bad.decision, STOP);
  assert.equal(bad.gate, 'quality_stops.coverage_min_pct');
  assert.equal(bad.floor, floor);

  const good = pilotVerdict({ answered: 19, total: 20, gates: REAL_GATES, routes: ROUTES });
  assert.equal(good.decision, 'continue');

  const empty = pilotVerdict({ answered: 0, total: 0, gates: REAL_GATES, routes: ROUTES });
  assert.equal(empty.decision, STOP, 'an empty pilot is not a passing pilot');

  // The plan carries the pilot size, so the slice is visible before approval.
  assert.equal(plan('find their pricing page', { rows: 400 }).pilot_rows,
    REQUESTED_GATES.research_agent.pilot_rows);
});

test('the paid LLM hop fires for Perplexity grounding and for nothing else', () => {
  // Batch scale is /personalize's and /call-intel's escape because THEIR unit of work
  // is a model call. This skill's unit of work is a fetch.
  assert.equal(ROUTES.inference.batch_scale_allowed, false);
  for (const reason of ['batch_scale', 'read_it_harder', 'summarise_faster', '']) {
    const d = planLlmHop({ reason, gates: MERGED, routes: ROUTES });
    assert.equal(d.decision, REFUSE, `"${reason}" bought a paid hop`);
    assert.equal(d.mode, 'local');
  }

  // The allowed reason still needs the grounding actually switched on.
  const ungrounded = planLlmHop({ reason: 'perplexity_web_grounding', gates: MERGED, routes: ROUTES });
  assert.equal(ungrounded.decision, REFUSE, 'without web search the hop is the local model at a price');

  const ok = planLlmHop({
    reason: 'perplexity_web_grounding', provider: 'perplexity', useWebSearch: true,
    gates: MERGED, routes: ROUTES,
  });
  assert.equal(ok.decision, 'emit');
  assert.equal(ok.mode, 'paid');
  assert.equal(ok.requires_dry_run, true);

  // And with the gate key stripped the whole route is unavailable, not permissive.
  // Was asserted against the real file back when it carried no block; the block is
  // merged now, so the closed case is made by deleting the one key the route reads.
  const closed = planLlmHop({
    reason: 'perplexity_web_grounding', provider: 'perplexity', useWebSearch: true,
    gates: gatesWithout(REAL_GATES, 'skills.research_agent.ai_enrich_requires_web_grounding'),
    routes: ROUTES,
  });
  assert.equal(closed.decision, REFUSE);
  assert.equal(closed.failed_closed, true);

  // The counterpart on the SHIPPED file: the merged key opens the grounded route, so
  // the REFUSE above is the missing key and nothing else.
  const onShipped = planLlmHop({
    reason: 'perplexity_web_grounding', provider: 'perplexity', useWebSearch: true,
    gates: REAL_GATES, routes: ROUTES,
  });
  assert.equal(onShipped.decision, 'emit');
  assert.equal(onShipped.mode, 'paid');
});

test('the routing table cannot be edited into failing open', () => {
  // Each mutation below is a single plausible edit that would disarm a guardrail in
  // production while every happy-path test stayed green. All of them must refuse to
  // load at all — a router that half-loads is worse than one that does not.
  const mutations = [
    ['default_decision', d => { d.default_decision = 'answer'; }],
    ['unmatched_question_action', d => { d.unmatched_question_action = 'best_effort'; }],
    ['free_text_null_allowed', d => { d.free_text_null_allowed = true; }],
    ['banned_result_strings', d => { d.banned_result_strings = []; }],
    ['register checked after routing', d => { d.undiscoverable.checked_before_routing = false; }],
    ['register costs money', d => { d.undiscoverable.planned_calls = 1; }],
    ['register emptied', d => { d.undiscoverable.shapes = []; }],
    ['the Iron Law shape removed', d => {
      d.undiscoverable.shapes = d.undiscoverable.shapes.filter(s => s.id !== 'private_financials');
    }],
    ['the Iron Law shape softened', d => {
      d.undiscoverable.shapes.find(s => s.id === 'private_financials').answers_null = 'not_verifiable';
    }],
    ['plan not required', d => { d.fan_out.approval_required_before_first_call = false; }],
    ['list total hidden', d => { d.fan_out.show_list_total = false; }],
    ['pilot skipped', d => { d.fan_out.pilot_required_before_full_run = false; }],
    ['gate failure ignored', d => { d.fan_out.on_missing_key = 'allow'; }],
    ['inference mode remote', d => { d.inference.mode = 'remote'; }],
    ['batch scale re-opened', d => { d.inference.batch_scale_allowed = true; }],
    ['a second paid reason', d => { d.inference.paid_hop_allowed_reasons.push('batch_scale'); }],
    ['inferred merged into verified', d => { d.inference.llm_output_merged_into_verified = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const doc = JSON.parse(JSON.stringify(ROUTES));
    mutate(doc);
    // The loader's checks are what the table is for; run them against the mutated doc
    // by re-validating through the same code path the harness uses at load.
    assert.throws(() => revalidate(doc), /ResearchRoutesUnavailable|must|Iron Law|law 5/,
      `a fail-open edit survived: ${label}`);
  }
});

/**
 * Re-run the loader's validation against an in-memory doc, by writing it back into a
 * throwaway SKILL.md-shaped string. Keeps ONE copy of the rules: the checks under test
 * are literally the ones loadResearchRoutes() runs at load time.
 */
function revalidate (doc) {
  const { writeFileSync, mkdtempSync } = require$('node:fs');
  const { join } = require$('node:path');
  const { tmpdir } = require$('node:os');
  const { stringify } = require$('yaml');
  const dir = mkdtempSync(join(tmpdir(), 'research-agent-routes-'));
  const p = join(dir, 'SKILL.md');
  writeFileSync(p, '# t\n\n```yaml research-routes\n' + stringify(doc) + '```\n', 'utf8');
  return loadResearchRoutes({ path: p });
}

// Tiny sync require shim so the helper above stays readable inside an ESM test file.
import { createRequire } from 'node:module';
const require$ = createRequire(import.meta.url);
