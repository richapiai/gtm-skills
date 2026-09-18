// The session receipt.
//
// Verify: it reuses the ledger's cost math (no fork), a claim greater than ledger
// actuals fails, and an unknown balance degrades to estimate language.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree } from '../helpers/index.mjs';
import { Ledger } from '../../_lib/ledger.mjs';
import { loadGates } from '../../_lib/gates.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import {
  buildReceipt, renderReceipt, assertNeverOverstates, spendPhrase, planFit, ReceiptOverstatement,
} from '../../_lib/receipt.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);
const GATES = loadGates();

function ledgerIn (t) {
  const tree = makeGtmTree({ prefix: 't29-' });
  t.after(() => tree.cleanup());
  return new Ledger({ dir: path.join(tree.root, 'gtm'), runId: 'r1' });
}

// enrich_profile is flat and verifiable; profile_activities bills on totalElements
// but returns only `elements`, so its charge can never be read back.
const VERIFIABLE = 'enrich_profile';
const UNVERIFIABLE = 'profile_activities';

// ---------------------------------------------------------------------------

test('a fully verifiable run reports an exact figure', (t) => {
  const led = ledgerIn(t);
  for (let i = 0; i < 3; i += 1) {
    // credits_charged in the response is now the ONLY thing that promotes a line to
    // `actual`. A flat catalog price is a deterministic estimate, not a
    // charge read back, so it no longer fabricates an actual.
    led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { title: 'x', credits_charged: 1 }, httpStatus: 200 });
  }
  const r = buildReceipt({ ledger: led, gates: GATES });

  assert.equal(r.exact, true);
  assert.equal(r.credits_floor, r.credits_ceiling);
  assert.equal(r.unverifiable_lines, 0);
  assert.match(spendPhrase(r), /^Spent 3 credits\.$/);
  assertNeverOverstates(r, led);
});

test('an unverifiable charge is reported as a RANGE, never as a fact', (t) => {
  const led = ledgerIn(t);
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  led.record({ endpoint: UNVERIFIABLE, catalogEntry: CATALOG.endpoints[UNVERIFIABLE], estimatedCredits: 20, responseBody: { elements: [] }, httpStatus: 200 });

  const r = buildReceipt({ ledger: led, gates: GATES });
  assert.equal(r.exact, false);
  assert.ok(r.credits_ceiling > r.credits_floor, 'the range must actually be a range');
  assert.equal(r.unverifiable_lines, 1);

  const phrase = spendPhrase(r);
  assert.match(phrase, /at least/i);
  assert.match(phrase, /up to/i);
  assert.ok(!/^Spent \d+ credits\.$/.test(phrase), 'must not collapse an estimate into a fact');
  assertNeverOverstates(r, led);
});

test('a receipt that claims more than the ledger supports is REFUSED', (t) => {
  const led = ledgerIn(t);
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: {}, httpStatus: 200 });
  const good = buildReceipt({ ledger: led, gates: GATES });
  assertNeverOverstates(good, led);

  // Inflate the floor: claiming as PROVEN more than the ledger verified.
  assert.throws(
    () => assertNeverOverstates({ ...good, credits_floor: good.credits_floor + 5 }, led),
    (e) => e instanceof ReceiptOverstatement && /exceeds verified ledger actuals/.test(e.message),
  );
  // Inflate the ceiling beyond what even the estimates support.
  assert.throws(
    () => assertNeverOverstates({ ...good, credits_ceiling: good.credits_ceiling + 5 }, led),
    (e) => /exceeds what the ledger can support/.test(e.message),
  );
});

test('claiming an EXACT figure while any line is unverifiable is refused', (t) => {
  const led = ledgerIn(t);
  led.record({ endpoint: UNVERIFIABLE, catalogEntry: CATALOG.endpoints[UNVERIFIABLE], estimatedCredits: 9, responseBody: { elements: [] }, httpStatus: 200 });
  const r = buildReceipt({ ledger: led, gates: GATES });
  assert.equal(r.exact, false);

  assert.throws(
    () => assertNeverOverstates({ ...r, exact: true }, led),
    (e) => /claims an exact figure while 1 ledger line/.test(e.message),
  );
});

test('an unknown balance degrades to estimate language, never a guess', (t) => {
  const led = ledgerIn(t);
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });

  const unknown = buildReceipt({ ledger: led, balance: null, gates: GATES });
  assert.equal(unknown.balance_known, false);
  const fit = planFit(unknown).join(' ');
  assert.match(fit, /Balance unknown/);
  assert.ok(!/more runs like this one/.test(fit), 'no remaining-runs figure without a balance');

  const known = buildReceipt({ ledger: led, balance: 250, balanceSource: '402_body', gates: GATES });
  assert.equal(known.balance_known, true);
  assert.match(planFit(known).join(' '), /roughly 250 more runs/);
});

test('the upgrade pointer needs a KNOWN low balance; it is never a guess', (t) => {
  const led = ledgerIn(t);
  for (let i = 0; i < 10; i += 1) {
    led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  }
  const URL = 'https://richapi.ai/upgrade';

  // Unknown balance: no upsell.
  assert.ok(!renderReceipt(buildReceipt({ ledger: led, balance: null, gates: GATES }), { upgradeUrl: URL }).includes(URL));
  // Healthy balance: no upsell.
  assert.ok(!renderReceipt(buildReceipt({ ledger: led, balance: 5000, gates: GATES }), { upgradeUrl: URL }).includes(URL));
  // Known and below the run's cost: shown, and LAST.
  const low = renderReceipt(buildReceipt({ ledger: led, balance: 2, gates: GATES }), { upgradeUrl: URL });
  assert.ok(low.includes(URL));
  assert.ok(low.trim().endsWith(URL), 'receipt first, upsell last');
  assert.ok(low.indexOf('Spent') < low.indexOf(URL));
});

test('a non-2xx is reported as costing nothing, not as a charge', (t) => {
  const led = ledgerIn(t);
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { error: 'x' }, httpStatus: 429 });
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { error: 'x' }, httpStatus: 500 });

  const r = buildReceipt({ ledger: led, gates: GATES });
  assert.equal(r.known_zero_lines, 2);
  assert.equal(r.credits_floor, 1, 'two failures must not be billed');
  assertNeverOverstates(r, led);
  assert.match(renderReceipt(r), /2 call\(s\) cost nothing/);
});

test('the receipt does NOT fork the cost math', (t) => {
  const led = ledgerIn(t);
  led.record({ endpoint: VERIFIABLE, catalogEntry: CATALOG.endpoints[VERIFIABLE], estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  led.record({ endpoint: UNVERIFIABLE, catalogEntry: CATALOG.endpoints[UNVERIFIABLE], estimatedCredits: 7, responseBody: { elements: [] }, httpStatus: 200 });

  const t0 = led.totals();
  const r = buildReceipt({ ledger: led, gates: GATES });
  assert.equal(r.credits_floor, t0.credits_actual);
  assert.equal(r.credits_ceiling, t0.credits_actual + t0.credits_estimated_unverifiable);
  assert.equal(r.verified_lines, t0.verified_lines);
  assert.equal(r.unverifiable_lines, t0.unverifiable_lines);
});

test('an empty run says nothing was spent, and offers nothing', (t) => {
  const led = ledgerIn(t);
  const r = buildReceipt({ ledger: led, gates: GATES });
  assert.equal(r.calls, 0);
  assert.equal(spendPhrase(r), 'Nothing was spent.');
  assert.equal(planFit(r), null);
  assert.equal(renderReceipt(r, { upgradeUrl: 'https://x' }), 'Nothing was spent.');
});

test('the plan-fit tier comes from gates.yaml, not a number typed here', () => {
  const src = fs.readFileSync(path.join(REPO, '_lib', 'receipt.mjs'), 'utf8');
  assert.ok(!/\b500\b/.test(src), 'the free-tier size must come from gates.yaml (law 1)');
  assert.match(src, /session_budget\.suggestion_credits/);
});

// ---------------------------------------------------------------------------
// A provider error is not a not-found, and the receipt has to say so.
//
// Live 2026-09-17: email_finder returned HTTP 200 with
// {ok:false, billed:false, why:"2/5 providers returned an error — retry later"}.
// The pack booked ~20 credits at full price and reported those rows as genuine
// not-founds — the worst of both, since the operator pays for nothing AND stops
// asking.
// ---------------------------------------------------------------------------

const PROVIDER_ERROR = Object.freeze({
  ok: false, result: null, billed: false,
  why: '2/5 providers returned an error — retry later',
});

test('the receipt separates a provider error from a non-2xx and from a not-found', (t) => {
  const led = ledgerIn(t);
  const entry = CATALOG.endpoints.email_finder;
  // 2 real, billed calls...
  for (let i = 0; i < 2; i += 1) {
    led.record({ endpoint: 'email_finder', catalogEntry: entry, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: { success: true, result: { email: null } }, httpStatus: 200 });
  }
  // ...4 that the API answered 200 and told us it did not bill...
  for (let i = 0; i < 4; i += 1) {
    led.record({ endpoint: 'email_finder', catalogEntry: entry, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: PROVIDER_ERROR, httpStatus: 200 });
  }
  // ...and 1 non-2xx, which is free for a different reason.
  led.record({ endpoint: 'email_finder', catalogEntry: entry, estimatedCredits: 5, responseBody: { error: 'bad' }, httpStatus: 422 });

  const r = buildReceipt({ ledger: led, gates: GATES });
  assert.equal(r.calls, 7);
  assert.equal(r.provider_error_lines, 4);
  assert.equal(r.known_zero_lines, 5, '4 provider errors + 1 non-2xx');
  assert.equal(r.credits_ceiling, 10, 'only the 2 billed calls may cost anything');
  assert.equal(r.by_endpoint.email_finder.provider_error, 4);
  assertNeverOverstates(r, led);

  const text = renderReceipt(r);
  assert.match(text, /1 call\(s\) cost nothing \(a non-2xx is not billed\)/);
  assert.match(text, /4 call\(s\) cost nothing: the provider errored/);
  assert.match(text, /not not-founds/);
  assert.ok(!text.includes('Spent 25 credits'), 'the unbilled calls must not reach the spend');
});

test('cost per found does not count a provider error as a miss', (t) => {
  const led = ledgerIn(t);
  const entry = CATALOG.endpoints.email_finder;
  led.record({ endpoint: 'email_finder', catalogEntry: entry, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: { success: true, result: { email: 'a@b.example' } }, httpStatus: 200 });
  led.record({ endpoint: 'email_finder', catalogEntry: entry, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: { success: true, result: { email: null } }, httpStatus: 200 });
  for (let i = 0; i < 3; i += 1) {
    led.record({ endpoint: 'email_finder', catalogEntry: entry, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: PROVIDER_ERROR, httpStatus: 200 });
  }

  // The mapping audit cannot tell an empty body from a provider-error body, so it
  // reports all four non-finds as `empty`. The receipt must correct that.
  const mapping = {
    by_endpoint: { email_finder: { calls: 5, mapped: 1, empty: 4, failures: 0, unmapped: 0, columns: ['email'] } },
    mapping_failures: 0, unmapped_responses: 0, unmapped_endpoints: [],
    columns_delivered: 1, mapped_responses: 1, empty_responses: 4, total_blackout: false,
  };
  const r = buildReceipt({ ledger: led, gates: GATES, mapping });
  const cpf = r.cost_per_found.find(c => c.capability === 'email');
  assert.equal(cpf.provider_errors, 3);
  assert.equal(cpf.not_found, 1, '4 empty responses minus 3 that were never actually looked up');
  assert.equal(cpf.billed_calls, 2, 'the 3 provider errors were free');
  assert.equal(cpf.credits_ceiling, 10);
  assertNeverOverstates(r, led);
  assert.match(renderReceipt(r), /3 of those call\(s\) returned a provider error and were not billed/);
});
