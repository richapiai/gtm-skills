// Verify criteria for the gate evaluator:
//   - a missing gates.yaml key fails CLOSED (STOP, not pass-through)
//   - unbounded endpoints page-gate
//   - a session-budget fraction gate fires at the right cumulative spend

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { trackedTmp } from '../helpers/index.mjs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import * as G from '../../_lib/gates.mjs';
import { catalog, ep } from './fixture-catalog.mjs';

const GATES_PATH = fileURLToPath(new URL('../../_lib/gates.yaml', import.meta.url));

/** Load gates.yaml with one dotted key deleted, via a real temp file. */
function gatesMinus (dotted) {
  const doc = parseYaml(readFileSync(GATES_PATH, 'utf8'));
  const parts = dotted.split('.');
  const leaf = parts.pop();
  let node = doc;
  for (const p of parts) node = node[p];
  delete node[leaf];
  const dir = trackedTmp('spend-gates-gates-');
  const path = join(dir, 'gates.yaml');
  writeFileSync(path, stringifyYaml(doc), 'utf8');
  return G.loadGates(path);
}

// ---------------------------------------------------------------------------
// FAIL CLOSED (law 5)
// ---------------------------------------------------------------------------

test('gates.yaml parses and exposes every documented section', () => {
  const g = G.loadGates();
  assert.equal(G.gateValue(g, 'schema_version'), 1);
  for (const k of ['session_budget', 'always_ask', 'disabled', 'unbounded_endpoints',
    'quality_stops', 'audience_minimums', 'watchlist', 'cache_ttl']) {
    assert.ok(G.hasGate(g, k), `missing top-level section ${k}`);
  }
});

test('a missing gates.yaml FILE fails closed — every check STOPs, nothing passes through', () => {
  const g = G.loadGates('/nonexistent/path/gates.yaml');
  const session = G.createSession({ gates: g, budgetCredits: 500 });

  const checks = [
    G.checkDisabled(g, 'enrich_company'),
    G.checkAlwaysAsk(g, 'enrich_company'),
    G.checkPageGate(g, 'people_search', 3),
    G.checkCoverage(g, 99),
    G.checkVerificationFailRate(g, { failPct: 0 }),
    G.checkWaterfallReruns(g, session),
    G.checkAudienceMinimum(g, 'linkedin', 100000),
    G.checkWatchlistSize(g, 1),
    G.cacheTtlDays(g, { endpoint: 'enrich_company' }),
    G.checkSessionSpend(session, 1)
  ];
  for (const c of checks) {
    assert.equal(c.decision, G.STOP, `expected STOP from ${c.gate}, got ${c.decision}`);
    assert.equal(c.failed_closed, true, `${c.gate} stopped but did not mark failed_closed`);
  }
});

test('a missing KEY fails closed — deleting a gate does not disable it, it wedges the call', () => {
  const cases = [
    ['session_budget.fractions.confirm', g => G.checkSessionSpend(G.createSession({ gates: g, budgetCredits: 500 }), 10)],
    ['session_budget.fractions.stop',    g => G.checkSessionSpend(G.createSession({ gates: g, budgetCredits: 500 }), 10)],
    ['session_budget.on_stop',           g => G.checkSessionSpend(G.createSession({ gates: g, budgetCredits: 500 }), 10)],
    ['always_ask.endpoints',             g => G.checkAlwaysAsk(g, 'enrich_company')],
    ['disabled',                         g => G.checkDisabled(g, 'enrich_company')],
    ['unbounded_endpoints.endpoints',    g => G.checkPageGate(g, 'people_search', 2)],
    ['unbounded_endpoints.hard_page_ceiling', g => G.checkPageGate(g, 'people_search', 2)],
    ['unbounded_endpoints.pages_before_confirm', g => G.checkPageGate(g, 'people_search', 2)],
    ['quality_stops.coverage_min_pct',   g => G.checkCoverage(g, 100)],
    ['quality_stops.verification_max_fail_rate_pct', g => G.checkVerificationFailRate(g, { failPct: 0 })],
    ['quality_stops.max_waterfall_reruns', g => G.checkWaterfallReruns(g, G.createSession({ gates: g }))],
    ['audience_minimums.linkedin',       g => G.checkAudienceMinimum(g, 'linkedin', 999999)],
    ['watchlist.max_entities',           g => G.checkWatchlistSize(g, 1)],
    ['watchlist.max_entities_hard_stop', g => G.checkWatchlistSize(g, 1)],
    ['cache_ttl.classes',                g => G.cacheTtlDays(g, { endpoint: 'enrich_company' })],
    ['cache_ttl.classes.unknown',        g => G.cacheTtlDays(g, { endpoint: 'nope', capabilityGroup: 'nope' })],
    ['cache_ttl.endpoints',              g => G.cacheTtlDays(g, { endpoint: 'enrich_company' })],
    ['cache_ttl.capability_groups',      g => G.cacheTtlDays(g, { capabilityGroup: 'enrichment' })]
  ];
  for (const [key, run] of cases) {
    const d = run(gatesMinus(key));
    assert.equal(d.decision, G.STOP, `deleting ${key} did NOT stop — it passed through as ${d.decision}`);
    assert.equal(d.failed_closed, true, `deleting ${key} stopped but did not mark failed_closed`);
    assert.match(d.reason, /failing closed/, `deleting ${key} gave no fail-closed reason`);
  }
});

test('an unknown platform fails closed rather than falling back to a default minimum', () => {
  const g = G.loadGates();
  const d = G.checkAudienceMinimum(g, 'tiktok', 5_000_000);
  assert.equal(d.decision, G.STOP);
  assert.equal(d.failed_closed, true);
  assert.equal(G.checkAudienceMinimum(g, 'linkedin', 5_000_000).decision, G.ALLOW);
});

test('a missing key inside checkCall stops the whole call, not just one sub-check', () => {
  const g = gatesMinus('unbounded_endpoints.endpoints');
  const session = G.createSession({ gates: g, budgetCredits: 500 });
  const d = G.checkCall(session, { endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1 });
  assert.equal(d.decision, G.STOP);
});

// ---------------------------------------------------------------------------
// PAGE GATING (the real bound on the 14 unbounded endpoints)
// ---------------------------------------------------------------------------

test('all 14 page-gated endpoints are listed and page-gate', () => {
  // Was 12: post_activities and search_bing are flat per call but take `page`, and
  // each page is another flat charge, so they joined once the predicate stopped
  // excluding flat endpoints.
  //
  // Was 11. profile_activities was added once catalog-gen started emitting
  // pricing.page_gated and the two files could finally be compared: it is
  // per_result at 2 credits billed on totalElements, with no billing field in
  // the response, so the charge is never verifiable AND the total is unbounded.
  // The runtime gate reads this list, so its absence here meant no page gate at
  // all. tests/contracts/page-gate-agreement.test.mjs now compares the two
  // files on every run so the sets cannot drift apart again.
  const g = G.loadGates();
  const list = G.gateValue(g, 'unbounded_endpoints.endpoints');
  assert.equal(list.length, 14, 'the unbounded set is 14 endpoints');
  for (const name of list) {
    assert.equal(G.checkPageGate(g, name, 1).decision, G.ALLOW, `${name} page 1 should run`);
    assert.equal(G.checkPageGate(g, name, 1).page_gated, true, `${name} page 1 should be marked page-gated`);
    assert.equal(G.checkPageGate(g, name, 2).decision, G.CONFIRM, `${name} page 2 must ask`);
    assert.equal(G.checkPageGate(g, name, 7).decision, G.CONFIRM, `${name} page 7 must ask`);
  }
});

test('page gating asks between EVERY page — one page at a time, not a one-off confirm', () => {
  const g = G.loadGates();
  const asked = [];
  for (let page = 1; page <= 6; page++) {
    if (G.checkPageGate(g, 'lead_search', page).decision === G.CONFIRM) asked.push(page);
  }
  assert.deepEqual(asked, [2, 3, 4, 5, 6]);
});

test('the hard page ceiling STOPs even when the user keeps confirming', () => {
  const g = G.loadGates();
  const ceiling = G.gateValue(g, 'unbounded_endpoints.hard_page_ceiling');
  assert.equal(G.checkPageGate(g, 'people_search', ceiling).decision, G.CONFIRM);
  const over = G.checkPageGate(g, 'people_search', ceiling + 1);
  assert.equal(over.decision, G.STOP);
});

test('a bounded endpoint does not page-gate', () => {
  const g = G.loadGates();
  assert.equal(G.checkPageGate(g, 'enrich_company', 4).decision, G.ALLOW);
  assert.equal(G.isUnbounded(g, 'enrich_company'), false);
});

test('people_search is treated as unbounded even though it has a `limit` — limit bounds the page, not the total', () => {
  const g = G.loadGates();
  assert.equal(G.isUnbounded(g, 'people_search'), true);
  assert.equal(ep('people_search').pricing.bounded, false);
});

// ---------------------------------------------------------------------------
// SESSION BUDGET FRACTIONS (not absolute credit numbers)
// ---------------------------------------------------------------------------

test('gates.yaml carries no absolute credit gate thresholds — only fractions', () => {
  const g = G.loadGates();
  const f = G.gateValue(g, 'session_budget.fractions');
  for (const [k, v] of Object.entries(f)) {
    assert.ok(v > 0 && v <= 1, `session_budget.fractions.${k} = ${v} is not a fraction of the budget`);
  }
});

test('the budget is asked once, on the first paid call, and never silently defaulted', () => {
  const g = G.loadGates();
  const session = G.createSession({ gates: g });
  assert.equal(G.needsBudgetPrompt(session), true);
  assert.equal(session.budget_credits, null, 'no budget may be applied without being asked');

  const prompt = G.budgetPrompt(session);
  assert.equal(prompt.decision, G.CONFIRM);
  assert.equal(prompt.suggestion_credits, 25);

  // A paid call before the budget is set does not proceed.
  const before = G.checkCall(session, { endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1 });
  assert.notEqual(before.decision, G.ALLOW);

  G.setBudget(session, 500);
  assert.equal(G.needsBudgetPrompt(session), false);
  assert.equal(G.checkCall(session, { endpoint: 'enrich_company', catalogEntry: ep('enrich_company'), estimatedCredits: 1 }).decision, G.ALLOW);
});

test('a fraction gate fires at the right CUMULATIVE spend, not on any single small call', () => {
  const g = G.loadGates();
  const budget = 1000;
  const session = G.createSession({ gates: g, budgetCredits: budget });

  // 49 x 10cr = 490 (49%) — no gate has fired yet.
  for (let i = 0; i < 49; i++) {
    const d = G.checkSessionSpend(session, 10);
    assert.equal(d.decision, G.ALLOW);
    assert.ok(!d.notify, `notify fired early at spend ${session.spent_credits}`);
    G.recordSpend(session, 10);
  }
  assert.equal(session.spent_credits, 490);

  // The call that crosses 50% notifies (allow + notify), it does not prompt.
  const crossNotify = G.checkSessionSpend(session, 10);
  assert.equal(crossNotify.decision, G.ALLOW);
  assert.equal(crossNotify.notify, true);
  assert.equal(crossNotify.gate, 'session_budget.fractions.notify');
  G.recordSpend(session, 10);   // 500

  // Nothing between 50% and 80%.
  for (let i = 0; i < 29; i++) {
    const d = G.checkSessionSpend(session, 10);
    assert.equal(d.decision, G.ALLOW);
    assert.ok(!d.notify);
    G.recordSpend(session, 10);
  }
  assert.equal(session.spent_credits, 790);

  // The call that crosses 80% asks.
  const crossConfirm = G.checkSessionSpend(session, 10);
  assert.equal(crossConfirm.decision, G.CONFIRM);
  assert.equal(crossConfirm.gate, 'session_budget.fractions.confirm');
  assert.equal(crossConfirm.projected_after, 800);
  G.recordSpend(session, 10);

  // It asks ONCE per crossing, not on every subsequent call — gate fatigue is
  // the failure mode this whole design exists to avoid.
  assert.equal(G.checkSessionSpend(session, 10).decision, G.ALLOW);
});

test('the stop fraction is a hard stop: the call that would exceed the budget does not run', () => {
  const g = G.loadGates();
  const session = G.createSession({ gates: g, budgetCredits: 500, spent: 495 });
  const exact = G.checkSessionSpend(session, 5);                       // lands exactly on 100%
  assert.equal(exact.decision, G.CONFIRM);
  assert.equal(exact.gate, 'session_budget.fractions.stop');
  const over = G.checkSessionSpend(session, 6);
  assert.equal(over.decision, G.STOP);
  assert.equal(over.gate, 'session_budget.fractions.stop');
  assert.match(over.reason, /raise_or_abort/);
});

test('one oversized call asks on its own, however low cumulative spend is', () => {
  const g = G.loadGates();
  const session = G.createSession({ gates: g, budgetCredits: 500 });   // fresh, 0 spent
  const d = G.checkSessionSpend(session, 125);                          // 25% of budget
  assert.equal(d.decision, G.CONFIRM);
  assert.equal(d.gate, 'session_budget.fractions.single_call_confirm');
});

test('the 800-credit waterfall run interrupts three times against a 1000-credit budget, not forty', () => {
  // The scenario the design exists for: ~8cr/contact x 100 contacts.
  const g = G.loadGates();
  const session = G.createSession({ gates: g, budgetCredits: 1000 });
  let prompts = 0, notifies = 0;
  for (let i = 0; i < 100; i++) {
    const d = G.checkSessionSpend(session, 8);
    if (d.decision === G.CONFIRM || d.decision === G.STOP) { prompts++; }
    if (d.notify) notifies++;
    G.recordSpend(session, 8);
  }
  assert.equal(session.spent_credits, 800);
  assert.equal(notifies, 1, 'one 50% notification');
  assert.equal(prompts, 1, 'one 80% prompt');
  // The same run under an absolute 20-credit gate would have prompted 40 times.
  assert.ok(prompts < 800 / 20);
});

// ---------------------------------------------------------------------------
// ALWAYS-ASK, DISABLED, QUALITY STOPS
// ---------------------------------------------------------------------------

test('phone_finder and find_personal_email always ask, even on an untouched budget', () => {
  const g = G.loadGates();
  const session = G.createSession({ gates: g, budgetCredits: 100000 });   // budget effectively unlimited
  for (const name of ['phone_finder', 'find_personal_email']) {
    const d = G.checkCall(session, { endpoint: name, catalogEntry: ep(name), estimatedCredits: 25 });
    assert.equal(d.decision, G.CONFIRM, `${name} must ask regardless of remaining budget`);
    assert.ok(d.fired.some(f => f.gate === 'always_ask.endpoints'));
  }
});

test('an endpoint listed under gates.yaml:disabled STOPs, and the shipped list is empty', () => {
  const shipped = G.loadGates();
  // post_keyword_search left this list on 2026-09-17, when the re-pinned spec priced it
  // per result on the page. The key stays, empty: a missing key would STOP everything.
  assert.deepEqual(shipped.disabled, {});
  assert.equal(G.checkDisabled(shipped, 'post_keyword_search').decision, G.ALLOW);

  const g = { ...shipped, disabled: { post_keyword_search: { reason: 'test reason', api_ask: 1 } } };
  const session = G.createSession({ gates: g, budgetCredits: 500 });
  const d = G.checkCall(session, { endpoint: 'post_keyword_search', catalogEntry: ep('post_keyword_search'), estimatedCredits: 6 });
  assert.equal(d.decision, G.STOP);
  assert.ok(d.fired.some(f => f.gate === 'disabled.post_keyword_search'));
  assert.equal(G.checkDisabled(g, 'post_keyword_search').api_ask, 1);
});

test('an endpoint with unknown pricing fails closed — an uncostable call never runs', () => {
  const g = G.loadGates();
  const session = G.createSession({ gates: g, budgetCredits: 500 });
  const d = G.checkCall(session, { endpoint: 'mystery_endpoint', catalogEntry: ep('mystery_endpoint'), estimatedCredits: null });
  assert.equal(d.decision, G.STOP);
  assert.ok(d.fired.some(f => f.gate === 'catalog.pricing.model' && f.failed_closed));
});

test('coverage below the floor STOPs; unmeasured coverage also STOPs', () => {
  const g = G.loadGates();
  assert.equal(G.checkCoverage(g, 69.9).decision, G.STOP);
  assert.equal(G.checkCoverage(g, 70).decision, G.ALLOW);
  assert.equal(G.checkCoverage(g, null).decision, G.STOP);
  assert.equal(G.checkCoverage(g, undefined).decision, G.STOP);
});

test('verification fail-rate and hard-bounce thresholds STOP', () => {
  const g = G.loadGates();
  assert.equal(G.checkVerificationFailRate(g, { failPct: 10 }).decision, G.ALLOW);
  assert.equal(G.checkVerificationFailRate(g, { failPct: 40 }).decision, G.STOP);
  assert.equal(G.checkVerificationFailRate(g, { failPct: 1, hardBouncePct: 9 }).decision, G.STOP);
  assert.equal(G.checkVerificationFailRate(g, { failPct: NaN }).decision, G.STOP);
});

test('N waterfall re-runs STOP', () => {
  const g = G.loadGates();
  const session = G.createSession({ gates: g, budgetCredits: 500 });
  const max = G.gateValue(g, 'quality_stops.max_waterfall_reruns');
  for (let i = 0; i < max; i++) {
    assert.equal(G.checkWaterfallReruns(g, session, 'list-a').decision, G.ALLOW);
    G.noteWaterfallRun(session, 'list-a');
  }
  assert.equal(G.checkWaterfallReruns(g, session, 'list-a').decision, G.STOP);
  assert.equal(G.checkWaterfallReruns(g, session, 'list-b').decision, G.ALLOW, 'the counter is per-list');
});

test('platform audience minimums: LinkedIn 300, Meta 1k, Google 1k', () => {
  const g = G.loadGates();
  assert.equal(G.checkAudienceMinimum(g, 'linkedin', 299).decision, G.STOP);
  assert.equal(G.checkAudienceMinimum(g, 'linkedin', 300).decision, G.ALLOW);
  assert.equal(G.checkAudienceMinimum(g, 'meta', 999).decision, G.STOP);
  assert.equal(G.checkAudienceMinimum(g, 'meta', 1000).decision, G.ALLOW);
  assert.equal(G.checkAudienceMinimum(g, 'Google', 999).decision, G.STOP);
});

test('watchlist ceilings: soft confirm, hard stop', () => {
  const g = G.loadGates();
  assert.equal(G.checkWatchlistSize(g, 250).decision, G.ALLOW);
  assert.equal(G.checkWatchlistSize(g, 251).decision, G.CONFIRM);
  assert.equal(G.checkWatchlistSize(g, 1001).decision, G.STOP);
});

test('cache TTLs resolve endpoint -> capability group -> fail-closed floor', () => {
  const g = G.loadGates();
  // endpoint entries, as a class name and as a literal duration
  assert.equal(G.cacheTtlDays(g, { endpoint: 'enrich_company' }).ttl_days, 90);
  assert.equal(G.cacheTtlDays(g, { endpoint: 'web_tech_stack' }).ttl_days, 30);
  assert.equal(G.cacheTtlDays(g, { endpoint: 'email_verifier' }).ttl_days, 7);
  // capability groups
  assert.equal(G.cacheTtlDays(g, { capabilityGroup: 'enrichment' }).ttl_days, 90);
  assert.equal(G.cacheTtlDays(g, { capabilityGroup: 'funding' }).ttl_days, 30);
  assert.equal(G.cacheTtlDays(g, { capabilityGroup: 'web_intelligence' }).ttl_days, 30);
  assert.equal(G.cacheTtlDays(g, { capabilityGroup: 'email_and_phone' }).ttl_days, 7);
  assert.equal(G.cacheTtlDays(g, { capabilityGroup: 'posts_activity' }).ttl_days, 1);
  // an endpoint entry beats the capability group
  assert.equal(G.cacheTtlDays(g, { endpoint: 'profile_activities', capabilityGroup: 'enrichment' }).ttl_days, 1);
  assert.equal(G.cacheTtlSeconds(g, { capabilityGroup: 'enrichment' }).ttl_seconds, 90 * 86400);
});

test('the four classes the PII sweep depends on exist with the agreed durations', () => {
  const g = G.loadGates();
  const classes = G.gateValue(g, 'cache_ttl.classes');
  assert.equal(G.parseDuration(classes.firmographics), 90);
  assert.equal(G.parseDuration(classes.funding_tech), 30);
  assert.equal(G.parseDuration(classes.email_verification), 7);
  assert.equal(G.parseDuration(classes.posts_activity), 1);
  assert.equal(G.parseDuration(classes.unknown), 1);
});

test('an endpoint with NO TTL entry resolves to the SHORTEST TTL, never the longest', () => {
  const g = G.loadGates();
  const classes = G.gateValue(g, 'cache_ttl.classes');
  const all = Object.values(classes).map(G.parseDuration);
  const shortest = Math.min(...all);
  const longest = Math.max(...all);

  const d = G.cacheTtlDays(g, { endpoint: 'an_endpoint_nobody_has_classified' });
  assert.equal(d.decision, G.ALLOW);
  assert.equal(d.unmatched, true);
  assert.equal(d.ttl_days, shortest, 'the unmatched fallback is not the shortest TTL');
  assert.notEqual(d.ttl_days, longest);
  // an unknown capability group behaves the same way
  assert.equal(G.cacheTtlDays(g, { capabilityGroup: 'not_a_group' }).ttl_days, shortest);
  assert.equal(G.cacheTtlDays(g, {}).ttl_days, shortest);
});

test('widening the `unknown` class cannot widen an unmatched endpoint — the floor is clamped', () => {
  const doc = parseYaml(readFileSync(GATES_PATH, 'utf8'));
  doc.cache_ttl.classes.unknown = '365d';          // someone edits it upward
  const dir = trackedTmp('spend-gates-ttl-');
  const path = join(dir, 'gates.yaml');
  writeFileSync(path, stringifyYaml(doc), 'utf8');
  const g = G.loadGates(path);
  assert.equal(G.cacheTtlDays(g, { endpoint: 'unclassified' }).ttl_days, 1,
    'an unmatched endpoint inherited a 365d cache from a widened `unknown` class');
});

test('a dangling class reference fails closed rather than silently caching', () => {
  const doc = parseYaml(readFileSync(GATES_PATH, 'utf8'));
  doc.cache_ttl.endpoints.enrich_company = 'no_such_class';
  const dir = trackedTmp('spend-gates-ttl2-');
  const path = join(dir, 'gates.yaml');
  writeFileSync(path, stringifyYaml(doc), 'utf8');
  const d = G.cacheTtlDays(G.loadGates(path), { endpoint: 'enrich_company' });
  assert.equal(d.decision, G.STOP);
  assert.equal(d.failed_closed, true);
});

test('an unparseable class duration fails closed — the floor cannot be computed', () => {
  const doc = parseYaml(readFileSync(GATES_PATH, 'utf8'));
  doc.cache_ttl.classes.firmographics = 'ninety days';
  const dir = trackedTmp('spend-gates-ttl3-');
  const path = join(dir, 'gates.yaml');
  writeFileSync(path, stringifyYaml(doc), 'utf8');
  const d = G.cacheTtlDays(G.loadGates(path), { endpoint: 'email_verifier' });
  assert.equal(d.decision, G.STOP);
  assert.equal(d.failed_closed, true);
});

test('parseDuration handles the unit set and rejects everything else', () => {
  assert.equal(G.parseDuration('90d'), 90);
  assert.equal(G.parseDuration('1w'), 7);
  assert.equal(G.parseDuration('24h'), 1);
  assert.equal(G.parseDuration('1440m'), 1);
  assert.equal(G.parseDuration('86400s'), 1);
  assert.equal(G.parseDuration(30), 30);
  for (const junk of ['firmographics', '', null, undefined, '30 days', '30x', 'd']) {
    assert.equal(G.parseDuration(junk), null, `parseDuration accepted ${JSON.stringify(junk)}`);
  }
});

test('the cache_ttl block stays plain YAML — the PII sweep parses it with a minimal reader', () => {
  // No anchors, aliases, block scalars, or inline flow collections, because
  // _lib/pii.mjs throws on all of them and falls back to its own defaults.
  const src = readFileSync(GATES_PATH, 'utf8');
  const block = src.slice(src.indexOf('\ncache_ttl:'));
  assert.ok(block.length > 0, 'cache_ttl block not found');
  for (const [re, what] of [
    [/(^|\s)&[A-Za-z_]/, 'anchor'],
    [/(^|\s)\*[A-Za-z_]/, 'alias'],
    [/:\s*[|>][-+0-9]*\s*$/m, 'block scalar'],
    [/:\s*\[/, 'flow sequence'],
    [/:\s*\{/, 'flow mapping']
  ]) {
    assert.ok(!re.test(block), `cache_ttl block contains a ${what}, which the PII sweep's reader in _lib/pii.mjs rejects`);
  }
  // and it round-trips through a strict re-parse
  const reparsed = parseYaml(block);
  assert.equal(Object.keys(reparsed.cache_ttl.classes).length >= 5, true);
});

// ---------------------------------------------------------------------------
// LAW 1 — no skill carries a bare number
// ---------------------------------------------------------------------------

test('scanForBareNumbers flags hand-typed thresholds in a SKILL.md', () => {
  const bad = [
    'Stop the run if this would cost more than 50 credits.',
    'LinkedIn needs at least 300 matched members before an upload.',
    'Refuse the list when coverage is below 70%.',
    'Cache firmographics for 90 days.'
  ].join('\n');
  const findings = G.scanForBareNumbers(bad, { file: 'SKILL.md' });
  assert.ok(findings.length >= 4, `expected >= 4 findings, got ${findings.length}`);
  assert.ok(findings.every(f => f.file === 'SKILL.md' && f.line > 0));
});

test('scanForBareNumbers accepts a number that cites the gates.yaml key it came from', () => {
  const good = [
    'Stop the run at `gates.yaml:session_budget.fractions.stop` (1.00 of the session budget).',
    'The audience floor comes from `gates.yaml:audience_minimums.linkedin`.',
    'Coverage floor: `gates.yaml:quality_stops.coverage_min_pct`.',
    '',
    '```bash',
    '# examples in fenced code are not policy',
    'echo "cost 50 credits"',
    '```'
  ].join('\n');
  assert.deepEqual(G.scanForBareNumbers(good), []);
});

test('gateKeys enumerates every leaf, so the validator can name a legal reference', () => {
  const keys = G.gateKeys();
  assert.ok(keys.includes('session_budget.fractions.confirm'));
  assert.ok(keys.includes('audience_minimums.linkedin'));
  assert.ok(keys.includes('cache_ttl.capability_groups.enrichment'));
  assert.ok(keys.includes('unbounded_endpoints.endpoints'));
});

// ---------------------------------------------------------------------------
// the fixture itself must honour the frozen catalog contract
// ---------------------------------------------------------------------------

test('the injected catalog fixture conforms to api-catalog.schema.json', () => {
  const schema = JSON.parse(readFileSync(new URL('../../_lib/contracts/api-catalog.schema.json', import.meta.url), 'utf8'));
  for (const k of schema.required) assert.ok(k in catalog, `catalog missing required key ${k}`);
  assert.equal(catalog.schema_version, 1);
  assert.match(catalog.spec_sha256, /^[a-f0-9]{64}$/);
  const groups = schema.$defs.endpoint.properties.capability_group.enum;
  const models = schema.$defs.pricing.properties.model.enum;
  for (const [name, e] of Object.entries(catalog.endpoints)) {
    for (const k of schema.$defs.endpoint.required) assert.ok(k in e, `${name} missing ${k}`);
    assert.ok(groups.includes(e.capability_group), `${name}: bad capability_group`);
    assert.ok(models.includes(e.pricing.model), `${name}: bad pricing model`);
    assert.ok(schema.$defs.endpoint.properties.field_map_status.enum.includes(e.field_map_status));
  }
});
