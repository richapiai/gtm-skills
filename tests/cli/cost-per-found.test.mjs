// tests/cli/cost-per-found.test.mjs
//
// COST PER CALL IS NOT COST PER RECORD.
//
// /enrich-waterfall's hop chain calls email_finder and phone_finder on every eligible
// row, and the API bills every SUCCESSFUL call — a 2xx that carries no email is a
// successful call. So at a 60% hit rate an operator pays ~8.3 credits per email they
// actually get while every cost surface in the pack reported ~5 per call. Two GTM
// reviewers flagged the same gap independently.
//
// Verify:
//   1. a mixed hit/miss run computes cost per found record correctly, per capability
//   2. a zero-find capability renders as "0 found, N credits spent" — never NaN,
//      never Infinity, never blank
//   3. an estimate-derived figure is labelled as an estimate and is never presented
//      as measured, and assertNeverOverstates fires if it is
//   4. the plan states the conditional-hop economics without inventing a hit rate

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, liveEmailFinder, livePhoneFinder, liveEnrichProfile } from '../helpers/index.mjs';
import { Ledger } from '../../_lib/ledger.mjs';
import { loadCatalog, buildWaterfall } from '../../_lib/enrich.mjs';
import { createMappingAudit } from '../../_lib/mapping-audit.mjs';
import { inspectResponse, RESPONSE_MAPS } from '../../_lib/client.mjs';
import { buildPlan, renderPlanText, observedHitRates } from '../../_lib/dryrun.mjs';
import {
  buildReceipt, renderReceipt, assertNeverOverstates, costPerFound, costPerFoundPhrase,
  FOUND_CAPABILITIES, capabilityColumnIsMapped, ReceiptOverstatement,
} from '../../_lib/receipt.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

function ledgerIn (t) {
  const tree = makeGtmTree({ prefix: 'cpf-' });
  t.after(() => tree.cleanup());
  return new Ledger({ dir: path.join(tree.root, 'gtm'), runId: 'r1' });
}

/**
 * Record one real call: a ledger line AND the mapping audit's classification of the
 * same response, exactly as createExecClient does. Both sides must come from the same
 * body or the test is measuring its own fixture rather than the code.
 */
function call (led, audit, endpoint, body) {
  led.record({
    endpoint,
    catalogEntry: CATALOG.endpoints[endpoint],
    estimatedCredits: CATALOG.endpoints[endpoint].pricing.credits_per_call,
    estimateBasis: 'flat',
    responseBody: body,
    httpStatus: 200,
  });
  audit.record(inspectResponse(endpoint, body));
}

/** `credits_charged` is the ONLY thing that promotes a line to `actual`. */
const charged = (endpoint, extra = {}) =>
  ({ credits_charged: CATALOG.endpoints[endpoint].pricing.credits_per_call, ...extra });

const capOf = (r, name) => r.cost_per_found.find(c => c.capability === name);

// ---------------------------------------------------------------------------
// 0. the capability table is not hand-typed folklore
// ---------------------------------------------------------------------------

test('CPF.0 — every capability names a column its finder endpoint really maps', () => {
  assert.ok(FOUND_CAPABILITIES.length > 0);
  for (const cap of FOUND_CAPABILITIES) {
    assert.ok(capabilityColumnIsMapped(cap),
      `${cap.endpoint} must map a "${cap.column}" column, or every run reports a total miss`);
  }
  // email_verifier must stay out of the capability list. It used to be excluded because
  // it ALSO mapped `email`, so counting it would have counted one address twice and
  // halved the reported unit cost. The 2026-08-31 recording shows it never echoes the
  // address at all — it answers `result.status` and nothing else — so the exclusion now
  // rests on a stronger fact: a verifier cannot find an address, it can only judge one.
  assert.ok(!Object.values(RESPONSE_MAPS.email_verifier).includes('email'),
    'the recorded verifier response carries no address; mapping one would invent it');
  assert.ok(!FOUND_CAPABILITIES.some(c => c.endpoint === 'email_verifier'));
});

// ---------------------------------------------------------------------------
// 1. the mixed run — the number the reviewers asked for
// ---------------------------------------------------------------------------

test('CPF.1 — a mixed hit/miss run reports cost per FOUND record, not per call', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();

  // Ten email_finder calls, six of which return an address. Every one is billed.
  for (let i = 0; i < 6; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: { email: `a${i}@b.example` } })));
  for (let i = 0; i < 4; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: null })));

  const mapping = audit.summary();
  const r = buildReceipt({ ledger: led, mapping });
  assertNeverOverstates(r, led);

  const email = capOf(r, 'email');
  assert.equal(email.calls, 10);
  assert.equal(email.found, 6);
  assert.equal(email.not_found, 4);
  assert.equal(email.unreadable, 0);
  assert.equal(email.hit_rate_pct, 60);

  // Every line here is `actual` (credits_charged is present), so the figure is exact.
  assert.equal(email.exact, true);
  assert.equal(email.basis, 'measured');
  const perCall = CATALOG.endpoints.email_finder.pricing.credits_per_call;
  assert.equal(email.credits_floor, perCall * 10);
  assert.equal(email.cost_per_found_floor, email.cost_per_found_ceiling);
  assert.equal(email.cost_per_found_floor, Math.round(((perCall * 10) / 6) * 1000) / 1000);

  // The gap is the whole point: the per-found unit must exceed the per-call price.
  assert.ok(email.cost_per_found_floor > perCall,
    'a hit rate under full must make the per-found unit larger than the per-call price');

  const text = renderReceipt(r);
  assert.match(text, /Cost per found record/);
  assert.match(text, /6 found from 10 call\(s\), 60% hit rate/);
  assert.match(text, /bills on a miss/);
});

test('CPF.2 — capabilities are reported separately, and an untouched hop is absent', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  for (let i = 0; i < 4; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: { email: `a${i}@b.example` } })));
  for (let i = 0; i < 2; i += 1) call(led, audit, 'phone_finder', charged('phone_finder', livePhoneFinder({ result: { phone: '+1', phone_status: 'ok' } })));
  call(led, audit, 'phone_finder', charged('phone_finder', livePhoneFinder({ result: null })));

  const r = buildReceipt({ ledger: led, mapping: audit.summary() });
  assertNeverOverstates(r, led);

  assert.equal(r.cost_per_found.length, 2);
  assert.equal(capOf(r, 'email').hit_rate_pct, 100);
  const phone = capOf(r, 'phone');
  assert.equal(phone.found, 2);
  assert.equal(phone.calls, 3);
  const phonePrice = CATALOG.endpoints.phone_finder.pricing.credits_per_call;
  assert.equal(phone.cost_per_found_ceiling, Math.round(((phonePrice * 3) / 2) * 1000) / 1000);
});

test('CPF.3 — a run that touches neither capability hop grows no block at all', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  call(led, audit, 'enrich_profile', charged('enrich_profile', liveEnrichProfile()));
  const r = buildReceipt({ ledger: led, mapping: audit.summary() });
  assert.deepEqual(r.cost_per_found, []);
  assert.ok(!renderReceipt(r).includes('Cost per found record'));
});

// ---------------------------------------------------------------------------
// 2. the divide by zero
// ---------------------------------------------------------------------------

test('CPF.4 — zero finds renders as "0 found, N credits spent", never NaN/Infinity/blank', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  for (let i = 0; i < 5; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: null })));

  const r = buildReceipt({ ledger: led, mapping: audit.summary() });
  assertNeverOverstates(r, led);

  const email = capOf(r, 'email');
  assert.equal(email.found, 0);
  assert.equal(email.hit_rate_pct, 0);
  assert.equal(email.basis, 'no_finds');
  // Null, not zero and not a number: there is no cost per found record to state.
  assert.equal(email.cost_per_found_floor, null);
  assert.equal(email.cost_per_found_ceiling, null);

  const phrase = costPerFoundPhrase(email);
  assert.match(phrase, /0 found from 5 call\(s\)/);
  assert.match(phrase, /credits.*spent/);
  assert.match(phrase, /undefined — every one of those calls billed on a miss/);
  for (const poison of ['NaN', 'Infinity', 'undefined credits', 'null']) {
    assert.ok(!phrase.includes(poison), `the zero-find line must not render "${poison}"`);
  }

  const text = renderReceipt(r);
  assert.ok(text.includes(phrase), 'the receipt must carry the zero-find sentence verbatim');
  assert.ok(!/NaN|Infinity/.test(text), 'no receipt may render NaN or Infinity');
  // Not blank either: the credits spent must be legible on the same line.
  assert.match(phrase, new RegExp(String(CATALOG.endpoints.email_finder.pricing.credits_per_call * 5)));
});

test('CPF.5 — the guard rejects a hand-built receipt that divides by zero anyway', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  for (let i = 0; i < 5; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: null })));
  const honest = buildReceipt({ ledger: led, mapping: audit.summary() });
  assertNeverOverstates(honest, led);

  const poison = (patch) => ({
    ...honest,
    cost_per_found: honest.cost_per_found.map(c => ({ ...c, ...patch })),
  });

  // The three shapes a naive implementation produces.
  assert.throws(() => assertNeverOverstates(poison({ cost_per_found_ceiling: Infinity }), led),
    ReceiptOverstatement, 'Infinity must never reach a receipt');
  assert.throws(() => assertNeverOverstates(poison({ cost_per_found_ceiling: NaN }), led),
    ReceiptOverstatement, 'NaN must never reach a receipt');
  assert.throws(() => assertNeverOverstates(poison({ cost_per_found_floor: 0, cost_per_found_ceiling: 0 }), led),
    ReceiptOverstatement, '0 credits per found record with 0 found is a fabricated figure');
});

test('CPF.6 — no mapping audit means "unknown", which is not "low" and not "zero"', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  for (let i = 0; i < 3; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: { email: 'a@b.example' } })));

  const r = buildReceipt({ ledger: led });          // no mapping passed
  assertNeverOverstates(r, led);
  const email = capOf(r, 'email');
  assert.equal(email.found, null, 'not measured is not zero');
  assert.equal(email.calls, null);
  assert.equal(email.basis, 'unmeasured');
  assert.equal(email.cost_per_found_floor, null);
  assert.match(costPerFoundPhrase(email), /unknown, which is not the same as low/);
});

// ---------------------------------------------------------------------------
// 3. estimates stay estimates
// ---------------------------------------------------------------------------

test('CPF.7 — an estimate-derived per-found figure is labelled, never called measured', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  // No credits_charged in the body. A flat catalog price is a deterministic ESTIMATE,
  // not a charge read back, so every line here is estimated_unverifiable — which is
  // the ordinary state for 11 of the 21 metered endpoints.
  for (let i = 0; i < 6; i += 1) call(led, audit, 'email_finder', liveEmailFinder({ result: { email: `a${i}@b.example` } }));
  for (let i = 0; i < 4; i += 1) call(led, audit, 'email_finder', liveEmailFinder({ result: null }));

  const r = buildReceipt({ ledger: led, mapping: audit.summary() });
  assertNeverOverstates(r, led);
  const email = capOf(r, 'email');

  assert.equal(email.exact, false);
  assert.equal(email.basis, 'estimated');
  assert.equal(email.unverifiable_lines, 10);
  assert.equal(email.credits_floor, 0, 'nothing is verified, so the verified floor is zero');
  assert.equal(email.cost_per_found_floor, 0);

  const phrase = costPerFoundPhrase(email);
  assert.match(phrase, /up to /, 'an unverified figure degrades to the receipt\'s own range language');
  assert.match(phrase, /estimate/);
  assert.ok(!/\bmeasured\b/.test(phrase), 'an estimate must never be worded as a measurement');
  // The ceiling is the honest upper bound and it is the 60%-hit-rate number.
  assert.equal(email.cost_per_found_ceiling,
    Math.round(((CATALOG.endpoints.email_finder.pricing.credits_per_call * 10) / 6) * 1000) / 1000);

  // ... and the guard fires the moment anyone relabels it.
  const lying = { ...r, cost_per_found: r.cost_per_found.map(c => ({ ...c, basis: 'measured' })) };
  assert.throws(() => assertNeverOverstates(lying, led), ReceiptOverstatement);
  const alsoLying = { ...r, cost_per_found: r.cost_per_found.map(c => ({ ...c, exact: true })) };
  assert.throws(() => assertNeverOverstates(alsoLying, led), ReceiptOverstatement);
});

test('CPF.8 — the guard is not tautological: an inflated per-found claim fails', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  for (let i = 0; i < 2; i += 1) call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: { email: 'a@b.example' } })));
  const honest = buildReceipt({ ledger: led, mapping: audit.summary() });
  assertNeverOverstates(honest, led);

  const bump = (patch) => ({
    ...honest,
    cost_per_found: honest.cost_per_found.map(c => ({ ...c, ...patch })),
  });
  const c0 = honest.cost_per_found[0];
  assert.throws(() => assertNeverOverstates(bump({ credits_ceiling: c0.credits_ceiling + 10 }), led),
    ReceiptOverstatement);
  assert.throws(() => assertNeverOverstates(bump({ credits_floor: c0.credits_floor + 10 }), led),
    ReceiptOverstatement);
  assert.throws(() => assertNeverOverstates(bump({ cost_per_found_ceiling: c0.cost_per_found_ceiling + 10 }), led),
    ReceiptOverstatement);
  assert.throws(() => assertNeverOverstates(bump({ hit_rate_pct: 250 }), led),
    ReceiptOverstatement, 'a hit rate above the calls made is an overstatement of coverage');
  assert.throws(() => assertNeverOverstates(bump({ cost_per_found_floor: null, cost_per_found_ceiling: null }), led),
    ReceiptOverstatement, 'dropping the operator\'s unit while finds exist is not an option either');
});

test('CPF.9 — an unreadable paid response is a miss, not a find (the empty-column failure stays loud)', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  call(led, audit, 'email_finder', charged('email_finder', liveEmailFinder({ result: { email: 'a@b.example' } })));
  // A 2xx carrying data the field map cannot read. Billed; not a found record.
  call(led, audit, 'email_finder', charged('email_finder', { emailAddress: 'a@b.example' }));

  const mapping = audit.summary();
  const r = buildReceipt({ ledger: led, mapping });
  assertNeverOverstates(r, led);
  const email = capOf(r, 'email');
  assert.equal(email.found, 1);
  assert.equal(email.unreadable, 1);
  assert.equal(email.hit_rate_pct, 50);
  assert.equal(email.cost_per_found_ceiling, CATALOG.endpoints.email_finder.pricing.credits_per_call * 2);
});

// ---------------------------------------------------------------------------
// 4. the plan says it BEFORE the money
// ---------------------------------------------------------------------------

const descriptors = (n) => Array.from({ length: n }, (_, i) => ({ row_id: `r${i}` }));

test('CPF.10 — the plan names the hops that bill on a miss and forecasts no hit rate', () => {
  const plan = buildPlan({
    runId: 'cpf-plan', rows: descriptors(4),
    waterfall: buildWaterfall({ phone: true }), catalog: CATALOG,
  });
  const ce = plan.conditional_economics;
  assert.equal(ce.hit_rate_is_forecast, false);
  assert.equal(ce.hit_rate_available_before_run, false);
  assert.equal(ce.observed, null);
  assert.ok(ce.bills_on_miss.some(h => h.endpoint === 'email_finder' && h.conditional));
  assert.ok(ce.bills_on_miss.some(h => h.endpoint === 'phone_finder' && h.conditional));
  // THE FLOOR is the bill for a run that finds nothing at all — not the ceiling.
  //
  // A `conditional` hop fires only because an EARLIER hop found something, so in the
  // run where every call misses it is never reached. Equating the miss-cost with the
  // ceiling put two numbers on one screen that contradicted each other: "floor 0 if no
  // conditional hop fires", and three lines later "if every one of those calls misses
  // you still pay 14". Live, 2026-09-17.
  assert.equal(ce.credits_if_every_call_misses, plan.totals.credits_estimated_floor);
  assert.ok(ce.credits_if_every_call_misses < plan.totals.credits_estimated,
    'this waterfall has conditional hops, so the floor must be below the ceiling');
  // And the gap between them is exactly what the conditional hops add.
  assert.equal(
    ce.credits_if_every_call_misses + ce.credits_conditional_if_fired_and_missed,
    plan.totals.credits_estimated,
  );

  const text = renderPlanText(plan);
  assert.match(text, /Billed on a miss:/);
  assert.match(text, /a 2xx that found nothing is a successful call/);
  assert.match(text, /still pay \d+ credits and get 0 records/);
  assert.match(text, /does not forecast one/);
  assert.match(text, /Cost per found record is reported by the receipt, after the run/);
  assert.ok(!/hit rate.*\d+%/.test(text), 'a plan with no prior runs must state no percentage');
});

test('CPF.11 — an observed rate is labelled as a record of prior runs, never as a forecast', () => {
  const priorObservations = [
    { run_id: 'a', endpoint: 'email_finder', calls: 10, found: 6 },
    { run_id: 'b', endpoint: 'email_finder', calls: 20, found: 12 },
  ];
  const plan = buildPlan({
    runId: 'cpf-plan2', rows: descriptors(2),
    waterfall: buildWaterfall({ phone: false }), catalog: CATALOG, priorObservations,
  });
  const obs = plan.conditional_economics.observed;
  assert.equal(obs.basis, 'observed_from_prior_runs');
  assert.equal(obs.is_forecast, false);
  assert.equal(obs.runs_observed, 2);
  assert.equal(obs.by_endpoint.email_finder.hit_rate_pct, 60);

  const text = renderPlanText(plan);
  assert.match(text, /Observed over 2 prior run\(s\) — a record, NOT a forecast/);
  assert.match(text, /email_finder 18\/30 = 60%/);
});

test('CPF.12 — nothing real to observe yields null, never a plausible default', () => {
  assert.equal(observedHitRates(null), null);
  assert.equal(observedHitRates([]), null);
  assert.equal(observedHitRates([{ endpoint: 'email_finder', calls: 0, found: 0 }]), null);
  assert.equal(observedHitRates([{ endpoint: 'email_finder' }]), null);
  // A find count above the calls made is a bad input, not a rate above full.
  const clamped = observedHitRates([{ endpoint: 'email_finder', calls: 4, found: 99 }]);
  assert.equal(clamped.by_endpoint.email_finder.hit_rate_pct, 100);
});

test('CPF.13 — an all-cached plan grows no miss-billing section', () => {
  const plan = buildPlan({
    runId: 'cpf-plan3',
    rows: [{ row_id: 'r0', cached: ['enrich_profile', 'email_finder', 'phone_finder', 'email_verifier'] }],
    waterfall: buildWaterfall({ phone: true }), catalog: CATALOG,
  });
  assert.equal(plan.conditional_economics.bills_on_miss.length, 0);
  assert.ok(!renderPlanText(plan).includes('Billed on a miss'));
});

// ---------------------------------------------------------------------------
// 5. the honesty machinery is reused, not forked
// ---------------------------------------------------------------------------

test('CPF.14 — cost per found reuses the ledger lines the spend total is built from', (t) => {
  const led = ledgerIn(t);
  const audit = createMappingAudit();
  for (let i = 0; i < 3; i += 1) call(led, audit, 'email_finder', { email: `a${i}@b.example` });
  const mapping = audit.summary();

  const r = buildReceipt({ ledger: led, mapping });
  // Same lines in, same per-endpoint credits out. A fork would drift here.
  const direct = costPerFound({ lines: led.lines, mapping });
  assert.deepEqual(direct, r.cost_per_found);
  assert.equal(r.cost_per_found[0].credits_ceiling, r.by_endpoint.email_finder.unverifiable);
  assert.ok(r.cost_per_found[0].credits_ceiling <= r.credits_ceiling,
    'a capability can never claim more than the whole run');
});
