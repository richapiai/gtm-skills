// tests/contracts/page-gate-reachability.test.mjs
//
// Two invariants about who is allowed to page, and one about batching.
//
// `enrich.gatePlan` passes `page: 1` for every hop. That is correct today — an
// enrichment waterfall does not page, each hop is one call about one row — and
// it is also, exactly, the one value that can never trigger a page gate, since
// `pages_before_confirm` is 1 ("page 1 runs, every page after asks").
//
// So the correctness of that line depends entirely on a fact nothing enforced:
// that no page-gated endpoint is ever added to the waterfall. If one were, it
// would be waved through silently, on an endpoint whose only real ceiling is a
// human between pages. profile_activities is 2 credits a result on an unbounded
// total with no charge in the response — that is the shape being waved through.
//
// gatePlan now throws instead. These tests pin both halves: the normal
// waterfall still gates fine, and a page-gated hop is refused rather than
// permitted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gatePlan } from '../../_lib/enrich.mjs';
import { loadGates, createSession, gateValue, isUnbounded } from '../../_lib/gates.mjs';

const gates = loadGates();
const catalog = JSON.parse(
  await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../_lib/api-catalog.json', import.meta.url), 'utf8')));

/** The hops buildWaterfall can produce, in every flag combination. */
const WATERFALL_ENDPOINTS = ['enrich_profile', 'email_finder', 'phone_finder', 'email_verifier'];

function planWith (endpoint) {
  return {
    per_hop: [{ endpoint, calls_planned: 3, credits_estimated: 6 }],
    totals: { credits_estimated: 6 },
  };
}

test('no endpoint the enrich waterfall can reach is page-gated', () => {
  // The premise the `page: 1` line rests on, asserted rather than assumed.
  for (const ep of WATERFALL_ENDPOINTS) {
    assert.equal(isUnbounded(gates, ep), false,
      `${ep} is in the enrich waterfall AND page-gated. An enrichment waterfall `
      + 'has no page to gate, so this endpoint cannot be safely called from it.');
  }
});

test('the ordinary waterfall gates without throwing', () => {
  const session = createSession({ gates, budgetCredits: 500 });
  for (const ep of WATERFALL_ENDPOINTS) {
    const out = gatePlan({ plan: planWith(ep), catalog, session });
    assert.ok(Array.isArray(out.decisions) && out.decisions.length > 0,
      `${ep} should produce a gate decision`);
  }
});

test('a page-gated hop in a waterfall is REFUSED, not waved through', () => {
  const session = createSession({ gates, budgetCredits: 500 });
  const gated = gateValue(gates, 'unbounded_endpoints.endpoints');

  // profile_activities is the worst case and the reason this guard exists:
  // per_result, billed on totalElements, charge absent from the response.
  assert.ok(gated.includes('profile_activities'));

  assert.throws(
    () => gatePlan({ plan: planWith('profile_activities'), catalog, session }),
    /cannot gate profile_activities|page-gated/,
    'a page-gated endpoint in a waterfall must throw, because page: 1 would permit it');
});

test('every page-gated endpoint is refused, not just the one we thought of', () => {
  const session = createSession({ gates, budgetCredits: 500 });
  for (const ep of gateValue(gates, 'unbounded_endpoints.endpoints')) {
    if (!catalog.endpoints[ep]) continue;
    assert.throws(() => gatePlan({ plan: planWith(ep), catalog, session }), /page-gated/,
      `${ep} is page-gated and must not be gateable as a waterfall hop`);
  }
});

// --- batching is off, and that is a decision, not an oversight -------------

test('auto-batching is OFF, pending a verified bulk response shape', () => {
  // Batching is credit-neutral, so this is not a cost switch. Bulk attribution
  // is POSITIONAL, and a recorded defect was exactly that failure: right count, wrong
  // order, one contact given another contact's data. The live capture — the thing that
  // would verify the response shape — is blocked on an API key, and both bulk
  // enrich endpoints have no usable example in the spec.
  //
  // If this assertion fails because someone set it true, the question to answer
  // is not "is batching faster" (it is) but "has the bulk response shape been
  // verified against a live capture, or does the response carry a joinable
  // identifier so position stops mattering".
  assert.equal(gateValue(gates, 'runtime.batch.auto'), false,
    'auto-batching must stay off until the bulk response shape is verified');
});

test('the batch switch is read strictly, so a missing key is not "on"', () => {
  // Law 5 applied to a switch rather than a threshold: absent must resolve to
  // the safer path, which for batching is single calls.
  const stripped = JSON.parse(JSON.stringify({ ...gates }));
  delete stripped.runtime;
  assert.throws(() => gateValue(stripped, 'runtime.batch.auto'), /missing/i,
    'a missing switch must throw so the caller fails closed, never default to true');
});
