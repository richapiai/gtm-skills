// REGRESSION: `request_page_multipliers` was declared, tested, and enforced by nothing.
//
// gates.yaml carried thirty lines of reasoning, a `clamp: 1` on two endpoints, and a
// comment calling it "the ceiling the RUNTIME enforces on that field". No runtime file
// read it. `tests/contracts/page-multiplier.test.mjs` only ever asserted it was
// DECLARED, and `tests/contracts/skill-gate-keys.test.mjs` (its every-declared-key-is-read check) shipped a dated,
// self-deleting allowance saying so out loud.
//
// MEASURED: `richapi call google_search_scraper_sync --param limit=100` planned at 25
// credits and the ledger recorded 1000 after a response carrying 1000 elements. The
// endpoint has `billing_field_present_in_response: false`, so that 1000 is
// `estimated_unverifiable` and the receipt can never correct it. With the declared
// clamp the same command costs 10.
//
// The trap that makes this a user error rather than a user choice: `limit` means "max
// RESULTS to return" on all five sibling scrapers and "max result PAGES" on this one
// alone, so someone who learned the field elsewhere asks for ten times what they think.
//
// These tests fail if the clamp stops firing, if it fires silently, or if it stops
// failing closed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { okWithoutBillingField } from '../helpers/index.mjs';
import { CATALOG, GATES, fixture, apiOver, fakeHttp } from './helpers.mjs';
import {
  runCall, buildRequestFor, clampPageMultiplier, pageMultiplierFor,
} from '../../_lib/run.mjs';
import { MissingGateKey } from '../../_lib/gates.mjs';

/** gates.yaml with one surgical change, so the fail-closed branches are reachable. */
function gatesWith (mutate) {
  const g = JSON.parse(JSON.stringify({ ...GATES }));
  mutate(g);
  return g;
}

// Ten elements per requested page, which is what makes the measured numbers line up:
// limit=100 returns 1000, limit=1 returns 10.
const TEN_PER_PAGE = (call) => {
  const pages = Number(call.body?.limit ?? 1);
  return okWithoutBillingField({ elements: Array.from({ length: pages * 10 }, (_, i) => ({ title: `r${i}` })) });
};

test('the clamp fires: limit=100 leaves as limit=1, and 1000 credits become 10', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: TEN_PER_PAGE });

  const res = await runCall({
    endpoint: 'google_search_scraper_sync',
    params: { search_query: 'crm for dentists', limit: 100 },
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 100000, confirm: async () => true,
  });

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].body.limit, 1,
    'the clamp must rewrite the field BEFORE the payload is sent — 100 on the wire is '
    + 'up to 100 pages of results charged at 1 credit each, unverifiably');

  assert.equal(res.ledger_totals.ledger_total, 10,
    'the measured before/after: 1000 credits unclamped, 10 clamped');
  assert.equal(res.ledger_totals.credits_estimated_unverifiable, 10,
    'this endpoint carries no billing field, so the charge stays estimated_unverifiable — '
    + 'which is exactly why the clamp has to be a before-the-fact control');
});

test('the clamp TELLS the user, rather than silently rewriting their parameter', async (t) => {
  const { tree } = fixture(t);
  const res = await runCall({
    endpoint: 'google_search_scraper_sync',
    params: { search_query: 'x', limit: 100 },
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: TEN_PER_PAGE })), budget: 100000, confirm: async () => true,
  });

  assert.equal(res.clamped.length, 1, 'a fired clamp must be reported structurally');
  const c = res.clamped[0];
  assert.equal(c.endpoint, 'google_search_scraper_sync');
  assert.equal(c.field, 'limit');
  assert.equal(c.requested, 100);
  assert.equal(c.clamp, 1);
  assert.equal(c.gate, 'request_page_multipliers.endpoints.google_search_scraper_sync.clamp');

  const note = res.notes.find((n) => n.includes('CLAMPED'));
  assert.ok(note, `the run must carry a human-readable note; got: ${JSON.stringify(res.notes)}`);
  assert.match(note, /100 was CLAMPED to 1/);
  assert.match(note, /PAGES one request walks, not how many results/,
    'the note must name the reason the user got this wrong, not merely state the new value');
  assert.match(note, /gates\.yaml:request_page_multipliers\.endpoints\.google_search_scraper_sync\.clamp/,
    'law 1: the note cites the key that set the ceiling, so raising it is findable');
});

test('a --dry-run says the clamp fired too, before a credit moves', async (t) => {
  const { tree } = fixture(t);
  const res = await runCall({
    endpoint: 'directory_yellowpages',
    params: { location: 'Austin, TX', search_query: 'dentist', max_pages: 30 },
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    dryRun: true, api: { post: () => { throw new Error('ZERO-CALL VIOLATION'); } },
  });
  assert.equal(res.calls_made, 0);
  assert.equal(res.clamped.length, 1);
  assert.equal(res.clamped[0].field, 'max_pages');
  assert.equal(res.clamped[0].requested, 30);
  assert.ok(res.notes.some((n) => n.includes('CLAMPED')),
    'the plan the user approves must already show the clamp — telling them afterwards is '
    + 'telling them after they approved something else');
});

test('a value at or under the clamp passes through untouched, and says nothing', () => {
  const under = buildRequestFor('google_search_scraper_sync', {}, CATALOG,
    { params: { search_query: 'x', limit: 1 }, gates: GATES });
  assert.equal(under.ok, true);
  assert.equal(under.payload.limit, 1);
  assert.equal(under.clamped, undefined, 'a clamp that did not fire must not report that it did');

  const absent = buildRequestFor('google_search_scraper_sync', {}, CATALOG,
    { params: { search_query: 'x' }, gates: GATES });
  assert.equal(absent.ok, true);
  assert.equal('limit' in absent.payload, false,
    'the clamp is a ceiling, not a default — it must not invent a field the caller omitted');
});

test('an endpoint with no declared multiplier is untouched', () => {
  const req = buildRequestFor('google_maps_places_scraper_keyword', {}, CATALOG,
    { params: { search_query: 'x', limit: 100 }, gates: GATES });
  assert.equal(req.ok, true);
  assert.equal(req.payload.limit, 100,
    'on the five sibling scrapers `limit` really does mean results — clamping it there '
    + 'would break the endpoints the trap is defined against');
});

// ---------------------------------------------------------------------------
// Failing closed. A control that degrades to "no control" is the failure this
// whole finding is about, so each degradation has a test.
// ---------------------------------------------------------------------------

test('a LISTED endpoint missing its clamp REFUSES the call, it does not send it bare', () => {
  const g = gatesWith((x) => { delete x.request_page_multipliers.endpoints.google_search_scraper_sync.clamp; });
  const req = buildRequestFor('google_search_scraper_sync', {}, CATALOG,
    { params: { search_query: 'x', limit: 100 }, gates: g });
  assert.equal(req.ok, false, 'law 5: a missing key is a STOP, never "no gate"');
  assert.match(req.reason, /request_page_multipliers\.endpoints\.google_search_scraper_sync\.clamp/);
  assert.match(req.reason, /failing closed/i);
});

test('a listed endpoint missing its FIELD name refuses too', () => {
  const g = gatesWith((x) => { delete x.request_page_multipliers.endpoints.directory_yellowpages.field; });
  const req = buildRequestFor('directory_yellowpages', {}, CATALOG,
    { params: { location: 'x', search_query: 'y' }, gates: g });
  assert.equal(req.ok, false);
  assert.match(req.reason, /directory_yellowpages\.field/);
});

test('an unreadable policy block refuses, rather than defaulting to unclamped', () => {
  const g = gatesWith((x) => { delete x.request_page_multipliers; });
  const req = buildRequestFor('google_search_scraper_sync', {}, CATALOG,
    { params: { search_query: 'x', limit: 100 }, gates: g });
  assert.equal(req.ok, false);
  assert.match(req.reason, /request_page_multipliers\.policy/);
});

test('a policy this runtime does not implement refuses rather than guessing', () => {
  const g = gatesWith((x) => { x.request_page_multipliers.policy = 'warn'; });
  const req = buildRequestFor('google_search_scraper_sync', {}, CATALOG,
    { params: { search_query: 'x', limit: 100 }, gates: g });
  assert.equal(req.ok, false);
  assert.match(req.reason, /policy is "warn"/);
});

test('pageMultiplierFor reads the declared config, and nothing else', () => {
  assert.deepEqual(pageMultiplierFor(GATES, 'google_search_scraper_sync'),
    { policy: 'clamp', field: 'limit', clamp: 1 });
  assert.deepEqual(pageMultiplierFor(GATES, 'directory_yellowpages'),
    { policy: 'clamp', field: 'max_pages', clamp: 1 });
  assert.equal(pageMultiplierFor(GATES, 'people_search'), null);

  // Prototype keys are not declarations. Same class as the `__proto__` hardening in
  // _lib/batch.mjs and _lib/gates.mjs.
  assert.equal(pageMultiplierFor(GATES, 'constructor'), null);
  assert.equal(pageMultiplierFor(GATES, '__proto__'), null);

  assert.throws(() => pageMultiplierFor({ __unloadable: 'boom' }, 'google_search_scraper_sync'),
    MissingGateKey, 'an unloadable gates.yaml must throw, not answer "nothing declared"');
});

test('clampPageMultiplier is a pure function of the payload and the gates', () => {
  const before = { search_query: 'x', limit: 100 };
  const after = clampPageMultiplier('google_search_scraper_sync', before, GATES);
  assert.equal(after.ok, true);
  assert.equal(after.payload.limit, 1);
  assert.equal(before.limit, 100, 'the caller\'s object must not be mutated under them');
});

test('every endpoint gates.yaml declares is one the clamp can actually reach', () => {
  // The other half of "a control that does nothing". A declared clamp on an endpoint no
  // caller can build a request for would look like protection and provide none.
  const declared = GATES.request_page_multipliers.endpoints;
  for (const [ep, cfg] of Object.entries(declared)) {
    assert.ok(CATALOG.endpoints[ep], `${ep} is clamped but is not in the catalog`);
    const params = Object.fromEntries(
      (CATALOG.endpoints[ep].required_request_fields ?? []).map((f) => [f, 'x']));
    params[cfg.field] = cfg.clamp + 9;
    const req = buildRequestFor(ep, {}, CATALOG, { params, gates: GATES });
    assert.equal(req.ok, true, `${ep} is clamped but unreachable: ${req.reason}`);
    assert.equal(req.payload[cfg.field], cfg.clamp,
      `${ep}.${cfg.field} was declared with a clamp of ${cfg.clamp} and did not get clamped`);
    assert.ok(req.clamped, `${ep} clamped silently`);
  }
});
