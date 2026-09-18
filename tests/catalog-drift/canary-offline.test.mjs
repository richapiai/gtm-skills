// The weekly live-API canary, proved entirely OFFLINE and with NO API key.
//
// THE REQUIREMENT THIS FILE EXISTS FOR
//
//   The canary is the only thing in the pack that spends real credits against the
//   real API on a schedule. Two consequences:
//
//     1. Nothing about it may be discovered in production. Every branch — selection,
//        the budget ceiling, both assertions, the issue payload, every way a call can
//        fail — is driven here by a local `node:http` server and a fixture catalog
//        written to a temp dir, so the whole contract is executable on a plane.
//     2. It must be impossible for this suite to reach api.richapi.ai or to need a
//        key. `--base-url` points at 127.0.0.1 (which `assertSafeOrigin` allows over
//        http precisely so local mock servers work), and the key is a literal
//        `test-key` this file asserts never leaves for anywhere else.
//
//   The two verify criteria are named in the tests below:
//     * "a deliberate field-map mismatch opens an issue"
//         -> 'a deliberate field-map mismatch produces an issue payload'
//     * "<50cr/week"
//         -> 'the credit ceiling fails closed — over budget makes ZERO calls'
//
// The canary ships DISABLED (see .github/workflows/canary.yml). The tests that pin
// that — the refusal against spec-derived key sets, and the exact enable condition —
// are the ones that keep it disabled until the live field-map capture lands, so they are asserted on the REAL
// catalog, not on a fixture.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  CANARY_BLOCKING,
  CANARY_SEVERITY,
  DEFAULT_BUDGET_CREDITS,
  DEFAULT_ENDPOINT_COUNT,
  REQUIRED_FIELD_MAP_STATUS,
  assertBudget,
  billedResultCount,
  chargeObservable,
  compareCharge,
  compareKeys,
  issuePayload,
  selectEndpoints,
  unverifiedFieldMaps,
} from '../../bin/richapi-canary.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'bin', 'richapi-canary.mjs');
const REAL_CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));

/** Run the CLI and return {code, stdout, stderr} without throwing on a non-zero exit. */
async function run(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      timeout: 60_000,
      ...opts,
      env: { ...process.env, richapi_API_KEY: '', RICHAPI_API_KEY: '', ...(opts.env ?? {}) },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/**
 * A local API. `routes` maps an endpoint path to a handler or a literal body; every
 * request is recorded so "zero calls were made" is a measurement, not a hope.
 */
async function serve(routes) {
  const seen = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: raw });
      const route = routes[req.url.replace(/^\/api\/v1/, '')] ?? routes['*'];
      const answer = typeof route === 'function' ? route(req) : route;
      const { status = 200, body = {} } = answer ?? {};
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    seen,
    baseUrl: `http://127.0.0.1:${port}/api/v1`,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// --- the fixture catalog ----------------------------------------------------------
//
// Written to a temp dir rather than committed, so this file adds nothing to the repo
// that a future reader has to keep in sync with the real catalog by hand.

const pricing = (over = {}) => ({
  model: 'flat',
  credits_per_call: 1,
  credits_base: null,
  credits_per_result: null,
  result_count_field: null,
  billing_field_present_in_response: true,
  bounded: true,
  page_gated: false,
  disabled_by_default: false,
  disabled_reason: null,
  ...over,
});

const endpoint = (name, over = {}) => ({
  name,
  path: `/${name}`,
  capability_group: 'test',
  spec_tag: 'Test',
  pricing: pricing(over.pricing),
  required_request_fields: ['q'],
  request_body_required: true,
  bulk_variant: null,
  max_batch: null,
  field_map: null,
  field_map_keys: ['a', 'b'],
  field_map_keys_source: 'spec_200_example_top_level_keys',
  field_map_status: REQUIRED_FIELD_MAP_STATUS,
  deprecated: false,
  ...over,
  pricing: pricing(over.pricing),
});

const FIXTURE_ENDPOINTS = {
  // 1 credit flat, key set {a, b}. The cheap, always-selected one.
  canary_flat: endpoint('canary_flat', { pricing: { credits_per_call: 1 } }),
  // 2 credits per result, bills on a numeric `total`. Selected second (2 > 1).
  canary_metered: endpoint('canary_metered', {
    field_map_keys: ['elements', 'total'],
    pricing: {
      model: 'per_result',
      credits_per_call: null,
      credits_per_result: 2,
      result_count_field: 'total',
      billing_field_present_in_response: true,
    },
  }),
  // Never selectable: the three exclusion rules, one endpoint each.
  canary_unbounded: endpoint('canary_unbounded', {
    pricing: {
      model: 'per_result',
      credits_per_call: null,
      credits_per_result: 0.01,
      result_count_field: 'elements',
      billing_field_present_in_response: true,
      bounded: false,
    },
  }),
  canary_disabled: endpoint('canary_disabled', {
    pricing: { credits_per_call: 0, disabled_by_default: true, disabled_reason: 'billing semantics unresolved' },
  }),
  canary_deprecated: endpoint('canary_deprecated', { deprecated: true, pricing: { credits_per_call: 0 } }),
};

function fixtureCatalog(over = {}) {
  return {
    schema_version: 2,
    generated_at: '2026-08-31T00:00:00.000Z',
    spec_sha256: null,
    spec_version: 'canary-fixture',
    endpoints: { ...FIXTURE_ENDPOINTS, ...over },
  };
}

const FIXTURE_PROBES = {
  inputs: {
    canary_flat: { q: 'x' },
    canary_metered: { q: 'x', limit: 1 },
    canary_unbounded: { q: 'x' },
    canary_disabled: { q: 'x' },
    canary_deprecated: { q: 'x' },
    canary_spec_keys: { q: 'x' },
  },
};

/** Materialise a catalog + probes pair in a temp dir; removed when the test ends. */
function fixtureFiles(t, catalog = fixtureCatalog()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const catalogFile = path.join(dir, 'catalog.json');
  const probesFile = path.join(dir, 'probes.json');
  const issueFile = path.join(dir, 'issue.json');
  fs.writeFileSync(catalogFile, JSON.stringify(catalog));
  fs.writeFileSync(probesFile, JSON.stringify(FIXTURE_PROBES));
  return { dir, catalogFile, probesFile, issueFile };
}

const FIXTURE_ARGS = (f) => ['--catalog', f.catalogFile, '--probes', f.probesFile];
const RUN_ARGS = (f, srv) => [...FIXTURE_ARGS(f), '--run', '--base-url', srv.baseUrl, '--issue-file', f.issueFile, '--json'];
const KEYED = { env: { richapi_API_KEY: 'test-key' } };

/** A server that answers every fixture endpoint exactly as its field_map_keys say. */
const CLEAN_ROUTES = {
  '/canary_flat': { status: 200, body: { a: 1, b: 2 } },
  '/canary_metered': { status: 200, body: { elements: [1], total: 1 } },
  '/canary_spec_keys': { status: 200, body: { a: 1, b: 2 } },
};

// =================================================================================
// selection is DERIVED, not a list in the source
// =================================================================================

test('the endpoint set is derived from the catalog, cheapest first', () => {
  const sel = selectEndpoints(fixtureCatalog(), { limit: 8, probes: { canary_flat: { body: {} }, canary_metered: { body: {} } } });
  assert.deepEqual(
    sel.selected.map((c) => c.name),
    ['canary_flat', 'canary_metered'],
    'selection must be ordered by the catalog price, not by declaration order'
  );
  assert.equal(sel.total, 3);
});

test('disabled_by_default, deprecated and unbounded endpoints are excluded WITH a reason', () => {
  const probes = Object.fromEntries(Object.keys(FIXTURE_ENDPOINTS).map((n) => [n, { body: {} }]));
  const sel = selectEndpoints(fixtureCatalog(), { limit: 99, probes });
  const names = sel.selected.map((c) => c.name);
  const reasonFor = (n) => sel.excluded.find((e) => e.name === n)?.reason ?? '';

  // canary_disabled and canary_deprecated are both 0 credits, so a rule that only
  // sorted by price would have put them FIRST. They are excluded on their own merits.
  for (const n of ['canary_disabled', 'canary_deprecated', 'canary_unbounded']) {
    assert.ok(!names.includes(n), `${n} must never be probed`);
    assert.ok(reasonFor(n).length > 10, `${n} was dropped with no legible reason`);
  }
  assert.match(reasonFor('canary_disabled'), /disabled_by_default — billing semantics unresolved/);
  assert.match(reasonFor('canary_deprecated'), /deprecated/);
  assert.match(reasonFor('canary_unbounded'), /bounded:false/);
});

test('an endpoint with no safe probe body is excluded rather than called blind', () => {
  const sel = selectEndpoints(fixtureCatalog(), { limit: 8, probes: { canary_flat: { body: {} } } });
  assert.deepEqual(sel.selected.map((c) => c.name), ['canary_flat']);
  assert.ok(sel.excluded.some((e) => e.name === 'canary_metered' && /probe body/.test(e.reason)));
});

test('the tie-break prefers endpoints whose charge can be read back', () => {
  // Two endpoints at the same price; only one can ever observe a charge. A canary
  // that cannot observe a charge asserts half its contract, so that one goes first.
  const catalog = fixtureCatalog({
    canary_flat: endpoint('canary_flat', { pricing: { credits_per_call: 2 } }),
    canary_metered: endpoint('canary_metered', {
      pricing: { model: 'per_result', credits_per_call: null, credits_per_result: 2, result_count_field: 'total', billing_field_present_in_response: true },
    }),
  });
  const sel = selectEndpoints(catalog, { limit: 1, probes: { canary_flat: { body: {} }, canary_metered: { body: {} } } });
  assert.deepEqual(sel.selected.map((c) => c.name), ['canary_metered']);
  assert.equal(chargeObservable(FIXTURE_ENDPOINTS.canary_flat), false, 'a flat price is not a charge read from a response');
  assert.equal(chargeObservable(FIXTURE_ENDPOINTS.canary_metered), true);
});

test('the real catalog yields a selection that is cheap, bounded and under the ceiling', async () => {
  const r = await run(['--json']);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.calls_made, 0);
  assert.equal(plan.selected.length, DEFAULT_ENDPOINT_COUNT);
  assert.ok(plan.credits_planned < DEFAULT_BUDGET_CREDITS,
    `the weekly run costs ${plan.credits_planned} credits; the ceiling is <${DEFAULT_BUDGET_CREDITS}`);
  // Derived, so it must not include anything the catalog says is off or unbounded.
  for (const s of plan.selected) {
    const e = REAL_CATALOG.endpoints[s.name];
    assert.ok(e, `${s.name} is not in the real catalog — the selection is not derived from it`);
    assert.equal(e.pricing.disabled_by_default, false);
    assert.equal(e.deprecated, false);
  }
});

// =================================================================================
// the ceiling — verify criterion #2
// =================================================================================

test('the credit ceiling fails closed — over budget makes ZERO calls', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());

  // The fixture selection costs 3 credits. A ceiling of 3 is not "< 3", so it is
  // refused: the ceiling is exclusive.
  const r = await run([...RUN_ARGS(f, srv), '--budget', '3'], KEYED);
  assert.equal(r.code, 2, 'over budget must refuse, not warn');
  assert.equal(srv.seen.length, 0, 'the budget must be enforced BEFORE anything is called');
  const out = JSON.parse(r.stdout);
  assert.equal(out.refused, true);
  assert.match(out.reason, /costs 3 credits and the ceiling is 3/);
  assert.match(out.reason, /Nothing was called and nothing was charged/);

  const ok = await run([...RUN_ARGS(f, srv), '--budget', '3.01'], KEYED);
  assert.equal(ok.code, 0, `just under the ceiling must run: ${ok.stderr}`);
  assert.equal(srv.seen.length, 2, 'both selected endpoints should have been probed');
});

test('assertBudget is exclusive and names what would have been spent', () => {
  const sel = { total: 50, selected: [] };
  assert.throws(() => assertBudget(sel, DEFAULT_BUDGET_CREDITS), /costs 50 credits and the ceiling is 50/);
  assert.equal(assertBudget({ total: 49.99, selected: [] }, DEFAULT_BUDGET_CREDITS), 49.99);
});

test('asking for the whole catalog blows the ceiling instead of quietly spending it', async () => {
  const r = await run(['--endpoints', '60', '--json']);
  assert.equal(r.code, 2);
  const out = JSON.parse(r.stdout);
  assert.match(out.reason, /ceiling is 50 credits\/week/);
  assert.ok(out.credits_planned > DEFAULT_BUDGET_CREDITS);
});

// =================================================================================
// it stays OFF until the live field-map capture lands
// =================================================================================

test('--run REFUSES against the real catalog today, because no field map is live-verified', async () => {
  const r = await run(['--run', '--json'], { env: { richapi_API_KEY: 'test-key' } });
  assert.equal(r.code, 2, 'the canary must not assert against spec-derived key sets');
  const out = JSON.parse(r.stdout);
  assert.ok(out.unverified_field_maps.length > 0);
  assert.equal(
    out.enable_condition,
    `live fixture capture landed and every selected endpoint reads field_map_status: ${REQUIRED_FIELD_MAP_STATUS}`
  );
  assert.match(out.reason, /Nothing was called and nothing was charged/);
});

test('the refusal names the endpoints and the enable condition, not just "no"', async () => {
  const r = await run(['--run'], { env: { richapi_API_KEY: 'test-key' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /ENABLE CONDITION: run the live fixture capture/);
  assert.match(r.stderr, /field_map_status: live_fixture/);
  assert.match(r.stderr, /keys_from_spec_example/);
  assert.match(r.stderr, /--force-unverified-field-map/);
});

test('the refusal is about field_map_status, and lifts the moment it says live_fixture', async (t) => {
  const spec = endpoint('canary_spec_keys', { field_map_status: 'keys_from_spec_example', pricing: { credits_per_call: 0.5 } });
  const f = fixtureFiles(t, fixtureCatalog({ canary_spec_keys: spec }));
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());

  const refused = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(refused.code, 2);
  assert.equal(srv.seen.length, 0);
  assert.deepEqual(JSON.parse(refused.stdout).unverified_field_maps, [{ name: 'canary_spec_keys', status: 'keys_from_spec_example' }]);

  const forced = await run([...RUN_ARGS(f, srv), '--force-unverified-field-map'], KEYED);
  assert.equal(forced.code, 0, `--force must override the refusal: ${forced.stderr}`);
  assert.ok(srv.seen.length > 0, '--force must actually run');
  assert.equal(JSON.parse(forced.stdout).forced, true);
});

test('unverifiedFieldMaps reports every non-live_fixture status, including the TODO one', () => {
  const catalog = fixtureCatalog({
    canary_todo: endpoint('canary_todo', { field_map_status: 'TODO_no_usable_example', pricing: { credits_per_call: 0 } }),
  });
  const probes = Object.fromEntries(Object.keys(catalog.endpoints).map((n) => [n, { body: {} }]));
  const sel = selectEndpoints(catalog, { limit: 9, probes });
  assert.deepEqual(unverifiedFieldMaps(sel), [{ name: 'canary_todo', status: 'TODO_no_usable_example' }]);
});

// =================================================================================
// assertion 1 — the field map. Verify criterion #1.
// =================================================================================

test('compareKeys is an exact top-level set comparison, both directions', () => {
  const e = FIXTURE_ENDPOINTS.canary_flat;
  assert.equal(compareKeys(e, { b: 1, a: 2 }).status, 'match', 'key ORDER is not a change');
  assert.deepEqual(compareKeys(e, { a: 1 }).missing, ['b']);
  assert.deepEqual(compareKeys(e, { a: 1, b: 2, c: 3 }).unexpected, ['c']);
  assert.equal(compareKeys(e, [1, 2]).status, 'not_an_object');
  assert.equal(compareKeys({ field_map_keys: null }, { a: 1 }).status, 'no_expectation');
});

test('a deliberate field-map mismatch produces an issue payload', async (t) => {
  // Verify criterion #1, end to end through the CLI.
  const f = fixtureFiles(t);
  const srv = await serve({
    // canary_flat's field_map_keys are ["a","b"]. The server drops `b` and adds `c`.
    '/canary_flat': { status: 200, body: { a: 1, c: 3 } },
    '/canary_metered': { status: 200, body: { elements: [1], total: 1 } },
  });
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 1, 'a field-map mismatch must be a blocking failure');

  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.blocking, [{ class: 'FIELD_MAP_MISMATCH', endpoint: 'canary_flat' }]);

  // The issue itself, on disk, where the workflow reads it.
  assert.ok(fs.existsSync(f.issueFile), 'no issue payload was written');
  const issue = JSON.parse(fs.readFileSync(f.issueFile, 'utf8'));
  assert.match(issue.title, /^Live-API canary: FIELD_MAP_MISMATCH \(\d{4}-\d{2}-\d{2}\)$/);
  assert.match(issue.body, /\*\*FIELD_MAP_MISMATCH\*\* `canary_flat`/);
  assert.match(issue.body, /missing: b/);
  assert.match(issue.body, /unexpected: c/);
  assert.match(issue.body, /richapi-capture-fixtures\.mjs --run --only <endpoint>/,
    'the issue must say what to DO, not only what broke');
});

test('a matching response opens nothing and exits 0', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.issue, null);
  assert.equal(out.blocking.length, 0);
  assert.ok(!fs.existsSync(f.issueFile), 'a clean run must not leave an issue payload behind');
});

test('a clean run DELETES a stale payload, so last week does not open this week an issue', async (t) => {
  const f = fixtureFiles(t);
  fs.writeFileSync(f.issueFile, JSON.stringify({ title: 'last week', body: 'stale' }));
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(f.issueFile));
});

// =================================================================================
// assertion 2 — the charge
// =================================================================================

test('the charge check compares the REQUESTED bound against the BILLED count', () => {
  // The non-tautology: planned is priced at 1 requested result, observed at what the
  // server says it billed. Same x-pricing, two different counts.
  const e = FIXTURE_ENDPOINTS.canary_metered; // 2 credits/result, bills on `total`
  const honoured = compareCharge(e, { elements: [1], total: 1 }, 200);
  assert.equal(honoured.status, 'match');
  assert.equal(honoured.planned, 2);
  assert.equal(honoured.actual, 2);

  const ignored = compareCharge(e, { elements: [], total: 25 }, 200);
  assert.equal(ignored.status, 'mismatch', 'billing 25 results for a limit-1 request is the failure this exists to catch');
  assert.equal(ignored.planned, 2);
  assert.equal(ignored.actual, 50);
  assert.equal(ignored.billed_results, 25);
  assert.equal(ignored.requested_results, 1);
});

test('a charge mismatch blocks and opens an issue', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve({
    '/canary_flat': { status: 200, body: { a: 1, b: 2 } },
    '/canary_metered': { status: 200, body: { elements: ['x'], total: 25 } },
  });
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.blocking, [{ class: 'CHARGE_MISMATCH', endpoint: 'canary_metered' }]);
  const issue = JSON.parse(fs.readFileSync(f.issueFile, 'utf8'));
  assert.match(issue.body, /planned 2 credits at 1 requested result\(s\), billed 50 at 25/);
});

test('`credits_charged` on the wire wins over the arithmetic, and can itself mismatch', () => {
  const e = FIXTURE_ENDPOINTS.canary_metered;
  const r = compareCharge(e, { elements: [1], total: 1, credits_charged: 9 }, 200);
  assert.equal(r.status, 'mismatch');
  assert.equal(r.actual, 9);
  assert.equal(r.source, 'credits_charged');
});

test('a promised billing field that is absent is a contract break, not a pass', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve({
    '/canary_flat': { status: 200, body: { a: 1, b: 2 } },
    // `total` is what the catalog says it bills on. The key set still matches.
    '/canary_metered': { status: 200, body: { elements: [1], total: null } },
  });
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.blocking, [{ class: 'BILLING_FIELD_MISSING', endpoint: 'canary_metered' }]);
});

test('an ARRAY at the billing field counts as its length, not as a missing field', () => {
  // 7 metered endpoints in the pinned catalog bill on `elements`, which is a list.
  // Reading Number([...]) as NaN would report every one of them as broken.
  const listBilled = endpoint('list_billed', {
    pricing: {
      model: 'per_result',
      credits_per_call: null,
      credits_per_result: 1,
      result_count_field: 'elements',
      billing_field_present_in_response: true,
    },
  });
  assert.equal(billedResultCount(listBilled, { elements: ['a', 'b', 'c'] }), 3);
  assert.equal(billedResultCount(listBilled, {}), null);
  assert.equal(compareCharge(listBilled, { elements: ['a'] }, 200).status, 'match');
  assert.equal(compareCharge(listBilled, { elements: ['a', 'b'] }, 200).status, 'mismatch');
});

test('an unreadable charge is reported unobservable, never as a fabricated pass (law 4)', () => {
  // A flat price is decided before the call, so there is nothing to read back.
  const flat = compareCharge(FIXTURE_ENDPOINTS.canary_flat, { a: 1, b: 2 }, 200);
  assert.equal(flat.status, 'unobservable');
  assert.equal(flat.actual, null);
  assert.match(flat.reason, /credits_charged/);
  assert.ok(!CANARY_BLOCKING.includes('UNOBSERVABLE'), 'unobservable must not be a finding class at all');

  // A metered endpoint the catalog already says cannot verify its own charge.
  const unverifiable = endpoint('unverifiable', {
    pricing: {
      model: 'per_result',
      credits_per_call: null,
      credits_per_result: 1,
      result_count_field: '_list_count',
      billing_field_present_in_response: false,
      bounded: true,
    },
  });
  const r = compareCharge(unverifiable, { elements: [1, 2, 3] }, 200);
  assert.equal(r.status, 'unobservable');
  assert.match(r.reason, /billing_field_present_in_response: false/);
});

// =================================================================================
// nothing here may wedge the weekly job
// =================================================================================

test('--help works with no API key, touches no network, and exits 0', async () => {
  const t0 = Date.now();
  const r = await run(['--help', '--base-url', 'https://canary.invalid.richapi-test/']);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 20_000);
  assert.match(r.stdout, /richapi-canary — the weekly live-API contract canary/);
  assert.match(r.stdout, /ENABLE CONDITION/);
});

test('plan mode is the default and makes ZERO HTTP calls', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());
  const r = await run([...FIXTURE_ARGS(f), '--base-url', srv.baseUrl, '--json']);
  assert.equal(r.code, 0);
  assert.equal(srv.seen.length, 0, 'plan mode called the API');
  assert.equal(JSON.parse(r.stdout).calls_made, 0);
});

test('--run without a key refuses and calls nothing', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());
  const r = await run(RUN_ARGS(f, srv));
  assert.equal(r.code, 2);
  assert.equal(srv.seen.length, 0);
  assert.match(JSON.parse(r.stdout).reason, /needs a live key/);
});

test('a non-default origin is refused before the key is read', async () => {
  const r = await run(['--run', '--base-url', 'https://evil.tld/api/v1', '--json'], { env: { richapi_API_KEY: 'test-key' } });
  assert.equal(r.code, 2);
  assert.match(JSON.parse(r.stdout).reason, /REFUSED/);
  assert.match(JSON.parse(r.stdout).reason, /Nothing was sent/);
});

test('an unreachable endpoint is a WARNING, not a weekly issue', async (t) => {
  // A third-party outage on a Monday must not open an issue every Monday. Same rule
  // the drift check uses when the network is gone.
  const f = fixtureFiles(t);
  const dead = await serve({});
  const url = dead.baseUrl;
  await dead.stop();

  const r = await run([...FIXTURE_ARGS(f), '--run', '--base-url', url, '--issue-file', f.issueFile, '--json', '--timeout', '2000'], KEYED);
  assert.equal(r.code, 0, 'an outage must not fail the weekly job');
  const out = JSON.parse(r.stdout);
  assert.equal(out.blocking.length, 0);
  assert.equal(out.findings.length, 2);
  for (const fnd of out.findings) assert.equal(fnd.class, 'TRANSPORT');
  assert.ok(!fs.existsSync(f.issueFile));
  assert.equal(CANARY_SEVERITY.TRANSPORT, 'warn');
});

test('a 5xx and a 429 are warnings; any other 4xx is a blocking contract break', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve({
    '/canary_flat': { status: 503, body: { error: 'upstream' } },
    '/canary_metered': { status: 400, body: { error: 'unknown field' } },
  });
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.findings.map((x) => [x.class, x.endpoint]), [
    ['TRANSPORT', 'canary_flat'],
    ['REQUEST_REJECTED', 'canary_metered'],
  ]);
  assert.match(JSON.parse(fs.readFileSync(f.issueFile, 'utf8')).body, /REQUEST_REJECTED/);
});

test('a 402 stops the run rather than walking the rest of the list', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve({ '*': { status: 402, body: { reserved: '1', balance: '0' } } });
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 1);
  assert.equal(srv.seen.length, 1, 'out of credits means stop, not keep trying');
  assert.deepEqual(JSON.parse(r.stdout).blocking, [{ class: 'INSUFFICIENT_CREDITS', endpoint: 'canary_flat' }]);
});

test('a hung server is bounded by --timeout, not by the CI job', async (t) => {
  const f = fixtureFiles(t);
  const sockets = new Set();
  const server = http.createServer(() => {
    /* accept, answer never */
  });
  server.on('connection', (s) => sockets.add(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });

  const t0 = Date.now();
  const r = await run(
    [...FIXTURE_ARGS(f), '--run', '--base-url', `http://127.0.0.1:${server.address().port}/api/v1`, '--json', '--timeout', '400'],
    KEYED
  );
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 30_000, 'the per-call deadline did not fire');
  assert.match(r.stdout, /timed out after 400ms/);
});

test('an unreadable catalog refuses; it is a repo bug, not an outage', async () => {
  const r = await run(['--catalog', path.join(HERE, 'fixtures', 'does-not-exist.json')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read catalog/);
});

// =================================================================================
// the key, and what reaches the issue
// =================================================================================

test('the key goes to the configured origin as x-api-key and nowhere else', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve(CLEAN_ROUTES);
  t.after(() => srv.stop());

  await run(RUN_ARGS(f, srv), KEYED);
  assert.ok(srv.seen.length > 0);
  for (const req of srv.seen) {
    assert.equal(req.headers['x-api-key'], 'test-key');
    assert.equal(req.headers.authorization, undefined);
    assert.ok(!String(req.body).includes('test-key'), 'the key must never end up in a request body');
  }
});

test('the issue payload carries names and numbers, never a response body (law 7)', async (t) => {
  const f = fixtureFiles(t);
  const srv = await serve({
    // A response shaped like a real one: the key set drifted AND it carries PII.
    '/canary_flat': { status: 200, body: { a: 'x', email: 'ada@lovelace.example', phone: '+14155552671' } },
    '/canary_metered': { status: 200, body: { elements: [1], total: 1 } },
  });
  t.after(() => srv.stop());

  const r = await run(RUN_ARGS(f, srv), KEYED);
  assert.equal(r.code, 1);
  const issue = JSON.parse(fs.readFileSync(f.issueFile, 'utf8'));
  // The key NAME is the finding and must be reported; the VALUE never is.
  assert.match(issue.body, /unexpected: email, phone/);
  assert.ok(!issue.body.includes('ada@lovelace.example'), 'a response value reached the issue body');
  assert.ok(!issue.body.includes('4155552671'), 'a response value reached the issue body');
  assert.match(issue.body, /No response bodies are included/);
});

test('issuePayload returns null when nothing blocks, and flags a forced run', () => {
  assert.equal(issuePayload({ blocking: [], warnings: [], runs: [], credits_planned: 0, credits_observed: null }), null);

  const result = {
    blocking: [{ class: 'FIELD_MAP_MISMATCH', endpoint: 'x', detail: 'd' }],
    warnings: [],
    runs: [{}],
    credits_planned: 1,
    credits_observed: null,
  };
  assert.match(issuePayload(result, { date: '2026-08-31' }).title, /\(2026-08-31\)$/);
  assert.match(
    issuePayload(result, { forced: true }).body,
    /spec-derived, not live-verified/,
    'a forced run must say so in the issue, or the reader trusts a bad expectation'
  );
  assert.match(issuePayload(result).body, /not fabricated/, 'an unreadable cost must say so rather than print 0');
});
