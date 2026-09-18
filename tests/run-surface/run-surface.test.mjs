// The guarantees of the general gated call surface (`_lib/run.mjs`).
//
// The pack tells every skill: "Do not improvise a workflow out of raw endpoint calls:
// the whole value of this pack is the gates, the journal and the cost accounting."
// Before this module only `richapi enrich` could obey that. These tests prove the same
// guarantees now hold for ANY catalog endpoint — and each one is written to fail if the
// guarantee is quietly dropped, not merely to walk the happy path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson, okWithoutBillingField, insufficientCredits, createThrowingHttp } from '../helpers/index.mjs';
import {
  CATALOG, fixture, cannotCall, apiOver, fakeHttp, gatesWithBatching,
  person, personWithUrn, profileBody, readJsonl,
} from './helpers.mjs';
import {
  runCall, runSearch, buildRequestFor, batchPolicy, createPayloadCache, renderBatch,
} from '../../_lib/run.mjs';
import { loadGates } from '../../_lib/gates.mjs';
import { readJournal } from '../../_lib/journal.mjs';

// ---------------------------------------------------------------------------
// 1. Reach — a skill can get to every catalog endpoint through this surface
// ---------------------------------------------------------------------------

test('every catalog endpoint is reachable, and none can be reached by an empty POST', () => {
  const names = Object.keys(CATALOG.endpoints);
  assert.ok(names.length > 60, `expected the full catalog, got ${names.length}`);

  const unreachable = [];
  const emptyPostAllowed = [];
  for (const name of names) {
    const def = CATALOG.endpoints[name];
    // Feed every declared required field, plus one extra param so the ten endpoints
    // that declare nothing required still have something to send.
    const params = Object.fromEntries((def.required_request_fields ?? []).map((f) => [f, 'x']));
    if (Object.keys(params).length === 0) params.query = 'x';
    // The eight hand-written contracts in client.mjs are stricter than the catalog and
    // name their own satisfying sets; feed those too.
    Object.assign(params, {
      url: 'https://linkedin.com/in/x', email: 'a@b.example', urns: ['urn:li:x'],
      first_name: 'A', last_name: 'B', company_domain: 'b.example', domain: 'b.example',
      linkedin_url: 'https://linkedin.com/in/x', prompt: 'x', provider: 'x',
    });
    // `url` means different things to different endpoints, so one value cannot serve
    // them all: enrich_profile wants a /in/ person, enrich_company a /company/ — and
    // feeding the company endpoint a person URL is exactly the mistake its contract
    // now refuses. Reachability is tested with input the endpoint can actually answer.
    if (name === 'enrich_company') params.url = 'https://linkedin.com/company/x';
    const req = buildRequestFor(name, {}, CATALOG, { params });
    if (!req.ok) unreachable.push(`${name}: ${req.reason}`);

    // The other half of the guarantee: nothing is reachable with NO input at all.
    const bare = buildRequestFor(name, {}, CATALOG, {});
    if (bare.ok) emptyPostAllowed.push(name);
  }

  assert.deepEqual(unreachable, [], 'every catalog endpoint must be reachable through buildRequestFor');

  // The other half of the guarantee, with one deliberate exemption.
  //
  // The rule is that an empty POST must never be built, because it is spec-valid
  // on ten endpoints and every one of them still bills. The exemption is an
  // endpoint that is BOTH free and genuinely fieldless: search_reference_data has
  // `properties: {}` in the spec, so an empty body is not merely valid, it is the
  // only valid body, and the catalog prices it at zero. Refusing it made the
  // endpoint unreachable — three skills depend on it — and the only workaround was
  // to invent an undeclared --param, which teaches callers to smuggle fields no
  // endpoint asked for.
  //
  // Pinned as an explicit list rather than a predicate, so that a repricing which
  // makes this endpoint cost money fails HERE, loudly, instead of quietly
  // permitting a billable empty POST. A catalog regen that adds a free fieldless
  // endpoint should have to come and edit this line.
  assert.deepEqual(emptyPostAllowed, ['search_reference_data'],
    'an empty POST is spec-valid on ten endpoints and still billable — it must never be '
    + 'built, except where the endpoint is free AND declares no request fields at all');

  // And prove the exemption is narrow in the direction that costs money.
  assert.equal(CATALOG.endpoints.search_reference_data.pricing.credits_per_call, 0,
    'the exemption is justified by the price being zero — if that changes, remove it');
  assert.equal(buildRequestFor('lead_search', {}, CATALOG, {}).ok, false,
    'lead_search is fieldless too, but costs 10 credits base — it must still be refused');
});

test('a row is never poured wholesale into a request body', () => {
  const row = { url: 'https://linkedin.com/in/x', email: 'ada@acme.example', phone: '+1', notes: 'internal' };
  // web_scrape declares only `url`. The contact columns must not travel with it.
  const req = buildRequestFor('web_scrape', row, CATALOG, {});
  assert.equal(req.ok, true);
  assert.deepEqual(Object.keys(req.payload), ['url']);

  // ...unless the caller opts a column in by name.
  const opted = buildRequestFor('web_scrape', row, CATALOG, { fields: ['email'] });
  assert.deepEqual(Object.keys(opted.payload).sort(), ['email', 'url']);
});

// ---------------------------------------------------------------------------
// 2. A dry run makes ZERO calls
// ---------------------------------------------------------------------------

test('`call --dry-run` makes ZERO calls and produces a per-hop costed plan', async (t) => {
  const { tree, input } = fixture(t, { rows: Array.from({ length: 12 }, (_, i) => person(i)) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    dryRun: true, budget: 500, api: cannotCall(),   // any touch throws
  });

  assert.equal(res.mode, 'dry-run');
  assert.equal(res.calls_made, 0);
  assert.equal(res.plan.totals.calls_planned, 12, 'a plan with no calls proves nothing');
  assert.equal(res.plan.totals.credits_estimated, 12, 'cost comes from the catalog, per hop');
  assert.match(res.text, /TOTAL:\s+12 credits/);

  // Every planned unit is journalled `pending` at attempt 0 = planned, never attempted.
  const { lines } = readJournal(res.journal_path);
  assert.equal(lines.length, res.plan.units.length);
  assert.ok(lines.every((l) => l.attempt === 0));
  assert.ok(lines.every((l) => l.dry_run === true || l.status !== 'pending'));

  // Nothing was spent, so there is nothing to account for.
  assert.equal(fs.existsSync(path.join(tree.root, 'gtm', 'api-calls.jsonl')), false,
    'a dry run must not write a ledger');
});

test('`search --dry-run` makes ZERO calls and prices every page', async (t) => {
  const { tree } = fixture(t);

  const res = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO', limit: 25 }, pages: 4,
    root: tree.root, catalog: CATALOG, dryRun: true, budget: 500, api: cannotCall(),
  });

  assert.equal(res.calls_made, 0);
  assert.equal(res.plan.totals.calls_planned, 4, 'one unit per page');
  assert.ok(res.plan.totals.credits_estimated > 0, 'a per-result page must be priced, not "unknown"');
  assert.equal(res.plan.totals.estimate_is_ceiling, true,
    'a search may exhaust early — the total is a ceiling and must say so');
  assert.ok(res.plan.totals.credits_estimated_floor < res.plan.totals.credits_estimated);
});

// ---------------------------------------------------------------------------
// 3. The gates fire on the PLAN, before spend
// ---------------------------------------------------------------------------

test('the page gate fires once per planned page, not once for page 1', async (t) => {
  const { tree } = fixture(t);

  const res = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO' }, pages: 5,
    root: tree.root, catalog: CATALOG, dryRun: true, budget: 500, api: cannotCall(),
  });

  const pageConfirms = res.gate.confirms.filter((c) => String(c.gate).startsWith('unbounded_endpoints'));
  assert.equal(pageConfirms.length, 4,
    'gates.yaml:unbounded_endpoints.pages_before_confirm is 1, so pages 2..5 each confirm');
  assert.deepEqual(pageConfirms.map((c) => c.page), [2, 3, 4, 5]);
});

test('a zero-based search asks before its SECOND page, not its third', async (t) => {
  const { tree } = fixture(t);

  const res = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO' }, pages: 3, startPage: 0,
    root: tree.root, catalog: CATALOG, dryRun: true, budget: 500, api: cannotCall(),
  });

  const pageConfirms = res.gate.confirms.filter((c) => String(c.gate).startsWith('unbounded_endpoints'));
  assert.deepEqual(pageConfirms.map((c) => c.page), [1, 2],
    'pages 0, 1, 2: only page 0 runs free — reading page 0 as page 1 let page 1 through unasked');
});

test('the hard page ceiling STOPS the plan before page one is bought', async (t) => {
  const { tree } = fixture(t);

  const res = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO' }, pages: 40,
    root: tree.root, catalog: CATALOG, budget: 100000, api: cannotCall(),
    confirm: async () => { throw new Error('a blocked plan must never reach approval'); },
  });

  assert.equal(res.mode, 'blocked');
  assert.equal(res.calls_made, 0);
  assert.ok(res.reasons.some((r) => /hard ceiling/.test(r)),
    `expected the hard page ceiling in ${JSON.stringify(res.reasons)}`);
});

test('the whole plan is approved once, not once per call', async (t) => {
  const { tree, input } = fixture(t, { rows: Array.from({ length: 30 }, (_, i) => person(i)) });
  const fake = fakeHttp({ fallback: okJson(profileBody(0)) });
  let prompts = 0;

  await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    // A budget small enough that the plan crosses the confirm fraction.
    budget: 30, api: apiOver(fake),
    confirm: async () => { prompts += 1; return true; },
  });

  assert.equal(prompts, 1, `30 rows must ask once, not ${prompts} times — gate fatigue kills the only control there is`);
  assert.equal(fake.callCount, 30);
});

// ---------------------------------------------------------------------------
// 4. A missing gate key reads as STOP, not as "no gate"
// ---------------------------------------------------------------------------

test('a missing gates.yaml key is a STOP, and nothing is called', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0), person(1)] });

  // An unloadable gates file: every key lookup throws MissingGateKey.
  const gates = loadGates(path.join(tree.root, 'no-such-gates.yaml'));
  assert.ok(gates.__unloadable, 'the fixture must actually be unloadable');

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    gates, api: cannotCall(),                       // proves nothing was called
    confirm: async () => { throw new Error('a STOP must never reach approval'); },
  });

  assert.equal(res.mode, 'blocked');
  assert.equal(res.calls_made, 0);
  assert.ok(res.gate.stops.length > 0);
  assert.ok(res.gate.stops.some((s) => s.failed_closed === true),
    'the STOP must be marked failed_closed, so nobody reads it as "no gate applied"');
  assert.ok(res.reasons.some((r) => /failing closed/i.test(r)));
});

test('batching is off, whether the key is absent or explicitly false', () => {
  // The key now EXISTS in gates.yaml and is false. Both paths must land on
  // single calls, and they must be distinguishable in the reason, because
  // "nobody has decided yet" and "the operator decided no" are different facts
  // to a user reading a run report.
  const shipped = loadGates();
  assert.equal(batchPolicy(shipped).auto, false,
    'runtime.batch.auto ships false until the bulk response shape is verified');

  const stripped = JSON.parse(JSON.stringify({ ...shipped }));
  delete stripped.runtime;
  assert.equal(batchPolicy(stripped).auto, false,
    'and with the key absent entirely, the closed position is still NOT to batch');
  assert.match(batchPolicy(stripped).reason, /failing closed/);

  // Explicitly set, it is simply read.
  assert.equal(batchPolicy(gatesWithBatching(true)).auto, true);
  assert.equal(batchPolicy(gatesWithBatching(false)).auto, false);
});

test('a disabled endpoint cannot be called at all', async (t) => {
  // Nothing ships disabled today (post_keyword_search was, until the 2026-09-17 re-pin
  // priced it per result on the page). The gate is the catalog's flag, so it is
  // exercised by setting that flag.
  const { tree } = fixture(t);
  const disabled = structuredClone(CATALOG);
  disabled.endpoints.post_keyword_search.pricing.disabled_by_default = true;
  disabled.endpoints.post_keyword_search.pricing.disabled_reason = 'test: disabled in the catalog';
  await assert.rejects(
    () => runSearch({
      endpoint: 'post_keyword_search', params: { keyword: 'x' }, pages: 1,
      root: tree.root, catalog: disabled, dryRun: true, api: cannotCall(),
    }),
    /disabled_by_default \(test: disabled in the catalog\)/,
    'a disabled endpoint fails closed at plan time, and says why',
  );

  // The shipped catalog enables it, and a dry run plans one page without calling.
  assert.equal(CATALOG.endpoints.post_keyword_search.pricing.disabled_by_default, false);
  const res = await runSearch({
    endpoint: 'post_keyword_search', params: { keyword: 'x' }, pages: 1,
    root: tree.root, catalog: CATALOG, dryRun: true, api: cannotCall(),
  });
  assert.notEqual(res.mode, 'blocked');
});

// ---------------------------------------------------------------------------
// 5. A real run writes a journal line and a ledger line per call
// ---------------------------------------------------------------------------

test('a real run writes a journal pair and a ledger line per call', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0), person(1), person(2)] });
  const fake = fakeHttp({ fallback: (call) => okJson(profileBody(call.body?.url ?? 0)) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, output: 'out.csv', root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true,
  });

  assert.equal(res.mode, 'run');
  assert.equal(res.http_calls, 3);

  const { lines } = readJournal(res.journal_path);
  const pending = lines.filter((l) => l.status === 'pending');
  const ok = lines.filter((l) => l.status === 'ok');
  assert.equal(pending.length, 3, 'a BEFORE line per call — this is what makes a resume free');
  assert.equal(ok.length, 3, 'an AFTER line per call');

  const ledger = readJsonl(res.ledger_path);
  assert.equal(ledger.length, 3, 'one ledger line per call');
  for (const l of ledger) {
    assert.equal(l.run_id, res.run_id);
    assert.equal(l.endpoint, 'enrich_profile');
    assert.equal(l.credits_estimated, 1, 'a real estimate, never 0 and never null');
    assert.ok(l.estimate_basis, 'the estimate carries its basis');
    assert.equal(l.http_status, 200);
  }

  // The output list was written through the suppression filter.
  assert.equal(res.output.written, 3);
  assert.match(fs.readFileSync(path.join(tree.root, 'out.csv'), 'utf8'), /title/);
});

test('an actual is never fabricated: only a response-carried charge promotes a line', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0), person(1), person(2)] });

  const fake = fakeHttp({
    routes: [
      // 1. a 2xx with no billing field at all -> estimated_unverifiable
      [(c) => c.body?.url?.endsWith('person-0'), okWithoutBillingField(profileBody(0))],
      // 2. a 2xx that DOES carry credits_charged -> actual
      [(c) => c.body?.url?.endsWith('person-1'), okJson({ ...profileBody(1), credits_charged: 1 })],
      // 3. a non-2xx -> known_zero (the billing rule, not a reading)
      [(c) => c.body?.url?.endsWith('person-2'), okJson({ error: 'nope' }, { status: 422 })],
    ],
  });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });

  const byStatus = {};
  for (const l of readJsonl(res.ledger_path)) byStatus[l.cost_status] = (byStatus[l.cost_status] ?? 0) + 1;
  assert.equal(byStatus.estimated_unverifiable, 1, 'no billing field -> estimate, never an actual');
  assert.equal(byStatus.actual, 1, 'only credits_charged promotes a line to actual');
  assert.equal(byStatus.known_zero, 1, 'a non-2xx deducts no credits — known, not verified');

  // The receipt reports a RANGE, because one line can never be verified.
  assert.equal(res.receipt.exact, false);
  assert.ok(res.receipt.credits_ceiling > res.receipt.credits_floor);
});

test('a timeout is unverifiable, not free', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0)] });
  const fake = fakeHttp({ fallback: () => { throw new Error('socket hang up'); } });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });

  const ledger = readJsonl(res.ledger_path);
  assert.equal(ledger.length, 1, 'a call we never saw the answer to still reaches the ledger');
  assert.equal(ledger[0].http_status, 0);
  assert.equal(ledger[0].cost_status, 'estimated_unverifiable',
    'the API may well have billed it — recording 0 here is how a resume re-pays for it');
  assert.equal(ledger[0].credits_actual, null);
});

// ---------------------------------------------------------------------------
// 6. A killed run resumes without re-paying
// ---------------------------------------------------------------------------

test('a killed run resumes and pays only for the units it never finished', async (t) => {
  const rows = Array.from({ length: 20 }, (_, i) => person(i));
  const { tree, input } = fixture(t, { rows });

  // First run: die after 12 calls.
  let n = 0;
  const dying = fakeHttp({
    fallback: () => {
      n += 1;
      if (n > 12) { const e = new Error('killed'); e.killed = true; throw e; }
      return okJson(profileBody(n));
    },
  });

  const runId = 'S8resume';
  const first = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(dying), confirm: async () => true, runId, maxAttempts: 1,
  });
  assert.equal(first.exec.ok, 12);
  assert.equal(first.exec.failed, 8, 'the rest failed, so they are replannable');

  const paidFirst = readJsonl(first.ledger_path).filter((l) => l.http_status === 200).length;
  assert.equal(paidFirst, 12);

  // Resume: only the 8 unfinished units may reach the wire.
  const second = fakeHttp({ fallback: okJson(profileBody(99)) });
  const res = await runCall({
    endpoint: 'enrich_profile', input, output: 'out.jsonl', root: tree.root, catalog: CATALOG,
    // maxAttempts 3, not 1: a unit that already failed once is `exhausted` under a
    // ceiling of one attempt, and would be dropped rather than retried.
    budget: 500, api: apiOver(second), confirm: async () => true, resume: runId, maxAttempts: 3,
  });

  assert.equal(res.mode, 'resume');
  assert.equal(second.callCount, 8,
    `a resume must re-buy only what it never finished, not ${second.callCount} of 20`);
  assert.equal(res.resume.stats.units_done, 12);
  assert.equal(res.resume.stats.units_todo, 8);

  // And the 12 rows the FIRST run paid for are still in the output — the failure that
  // makes a resume worse than useless is spending the credits and losing the data.
  const out = readJsonl(path.join(tree.root, 'out.jsonl'));
  assert.equal(out.length, 20);
  assert.equal(out.filter((r) => r.title).length, 20,
    'rows enriched by the first run must survive into the resumed output');
});

// ---------------------------------------------------------------------------
// 7. The cache: a hit spends nothing and shows in the plan
// ---------------------------------------------------------------------------

test('a cache hit shows as skipped-not-charged in the plan and spends nothing', async (t) => {
  const rows = [person(0), person(1), person(2)];
  const { tree, input } = fixture(t, { rows });

  // Warm the cache with a first, paid run.
  const warm = fakeHttp({ fallback: okJson(profileBody(1)) });
  const first = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(warm), confirm: async () => true,
  });
  assert.equal(warm.callCount, 3);
  assert.equal(first.cache.writes, 3);

  // Now the plan must show three cache hits and a zero total, with ZERO calls.
  const planned = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    dryRun: true, budget: 500, api: cannotCall(),
  });
  assert.equal(planned.plan.totals.skipped_cache, 3, 'the plan must SHOW the hits');
  assert.equal(planned.plan.totals.calls_planned, 0);
  assert.equal(planned.plan.totals.credits_estimated, 0);
  assert.match(planned.text, /3 cached \(not charged\)/);

  // And the real run spends nothing, proven with a transport that throws on any call.
  const forbidden = createThrowingHttp('a fully cached run must make zero HTTP calls');
  const rerun = await runCall({
    endpoint: 'enrich_profile', input, output: 'out.jsonl', root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(forbidden), confirm: async () => true,
  });
  assert.equal(forbidden.callCount, 0);
  assert.equal(rerun.exec.skipped_cache, 3);
  assert.equal(rerun.ledger_totals.ledger_total, 0);

  // A cached unit still contributes its columns to the output, or the "free" run
  // silently delivers an empty list.
  const out = readJsonl(path.join(tree.root, 'out.jsonl'));
  assert.equal(out.filter((r) => r.title).length, 3);
});

test('the cache is hit-compatible with the one `richapi enrich` writes', async (t) => {
  const { tree } = fixture(t);
  const payload = { url: 'https://linkedin.com/in/shared' };

  // Written through _lib/cache.mjs (the enrich path)...
  const { createCache } = await import('../../_lib/cache.mjs');
  const enrichCache = createCache({ root: tree.root, dir: 'gtm' });
  enrichCache.put('enrich_profile', { linkedin_url: payload.url }, profileBody(7));

  // ...read back through this module's payload-keyed cache.
  const mine = createPayloadCache({ root: tree.root, dir: 'gtm' });
  assert.equal(mine.has('enrich_profile', payload), true,
    'the same question must hash to the same key in both caches, or every skill re-pays');
  assert.equal(mine.get('enrich_profile', payload).positionGroups[0].profilePositions[0].title, 'CTO');
});

test('--no-cache re-pays for everything', async (t) => {
  const rows = [person(0)];
  const { tree, input } = fixture(t, { rows });
  const a = fakeHttp({ fallback: okJson(profileBody(0)) });
  await runCall({ endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG, budget: 500, api: apiOver(a), confirm: async () => true });

  const b = fakeHttp({ fallback: okJson(profileBody(0)) });
  const res = await runCall({ endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG, budget: 500, noCache: true, api: apiOver(b), confirm: async () => true });
  assert.equal(b.callCount, 1, '--no-cache must actually re-pay');
  assert.equal(res.cache.enabled, false);
});

test('a per-result call is priced from the list in the request, not from an assumption', async (t) => {
  const { tree } = fixture(t);

  // enrich_profiles_bulk is 1 credit per RESULT. Three URNs is three credits; pricing
  // it at gates.yaml:unbounded_endpoints.assumed_results_per_page would overstate the
  // plan by 8x, and a plan nobody believes is a plan nobody reads.
  const res = await runCall({
    endpoint: 'enrich_profiles_bulk', params: { urns: ['urn:li:a', 'urn:li:b', 'urn:li:c'] },
    root: tree.root, catalog: CATALOG, dryRun: true, budget: 500, api: cannotCall(),
  });
  assert.equal(res.plan.totals.credits_estimated, 3);

  // A flat endpoint is priced per CALL, and must not be multiplied by anything.
  const flat = await runCall({
    endpoint: 'enrich_profile', params: { url: 'https://linkedin.com/in/x' },
    expectedResults: 40, root: tree.root, catalog: CATALOG, dryRun: true, budget: 500, api: cannotCall(),
  });
  assert.equal(flat.plan.totals.credits_estimated, 1);
});

// ---------------------------------------------------------------------------
// 8. Batching, and the recorded reason when it cannot happen
// ---------------------------------------------------------------------------

test('batching fires when every row carries a URN', async (t) => {
  const rows = Array.from({ length: 6 }, (_, i) => personWithUrn(i));
  const { tree, input } = fixture(t, { rows });
  const fake = fakeHttp({ fallback: () => okJson(rows.map((_, i) => profileBody(i))) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    gates: gatesWithBatching(true), budget: 500, api: apiOver(fake), confirm: async () => true,
  });

  assert.equal(res.batch.batched, true);
  assert.equal(res.batch.split, 'all');
  assert.equal(res.batch.bulk_variant, 'enrich_profiles_bulk');
  assert.equal(fake.callCount, 1, '6 rows, max_batch 50 -> ONE http call');
  assert.deepEqual(fake.calledEndpoints(), ['enrich_profiles_bulk']);
  assert.equal(res.exec.ok, 6, 'journalling stays per row even though the call is shared');

  // Per row in the journal, one line in the ledger for the shared call.
  const journal = readJournal(res.journal_path).lines;
  assert.equal(journal.filter((l) => l.status === 'ok').length, 6);
  assert.equal(readJsonl(res.ledger_path).length, 1, 'one ledger line per bulk CALL, with a result_count');
  assert.equal(readJsonl(res.ledger_path)[0].result_count, 6);

  // The positional-attribution risk is never silent.
  assert.equal(res.batch.attribution, 'by_identity');
  assert.match(res.batch.reason, /IDENTITY/);
});

test('batching falls back PER ROW on identifier mismatch, and records why', async (t) => {
  // Four rows carry a URN, two do not. `enrich_profile` takes a URL and
  // `enrich_profiles_bulk` takes URNs, and nothing converts between them.
  const rows = [
    personWithUrn(0), personWithUrn(1), person(2), personWithUrn(3), person(4), personWithUrn(5),
  ];
  const { tree, input } = fixture(t, { rows });
  const fake = fakeHttp({
    routes: [
      ['enrich_profiles_bulk', (c) => okJson(c.body.urns.map((u) => profileBody(Number(String(u).split(':').pop()) - 1000)))],
      ['enrich_profile', okJson(profileBody(9))],
    ],
  });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    gates: gatesWithBatching(true), budget: 500, api: apiOver(fake), confirm: async () => true,
  });

  assert.equal(res.batch.split, 'partial');
  assert.equal(res.batch.rows_with_identifier, 4);
  assert.equal(res.batch.rows_without_identifier, 2);

  // THE POINT: the fallback is recorded, not silent. N unexplained single calls is how
  // a 50x latency penalty goes unnoticed.
  assert.match(res.batch.reason, /urn/i);
  const reasons = Object.keys(res.batch.fallback_reasons);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /profile URL is not a URN/);
  assert.equal(res.batch.fallback_reasons[reasons[0]], 2, 'the count of affected rows is recorded');
  assert.match(renderBatch(res.batch), /fall back to single calls/);

  // 1 bulk call for the four, 2 single calls for the rest — not 6 singles.
  // Exact endpoint match: `callsTo` also matches on URL substring, and the URL
  // .../enrich_profiles_bulk contains the string "enrich_profile".
  const at = (name) => fake.calls.filter((c) => c.endpoint === name).length;
  assert.equal(at('enrich_profiles_bulk'), 1);
  assert.equal(at('enrich_profile'), 2);
  assert.equal(res.exec.ok, 6, 'both groups journal identically');
});

test('with batching off in the shipped gates, four rows are four single calls', async (t) => {
  const rows = Array.from({ length: 4 }, (_, i) => personWithUrn(i));
  const { tree, input } = fixture(t, { rows });
  const fake = fakeHttp({ fallback: okJson(profileBody(0)) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true,   // real gates.yaml: runtime.batch.auto false
  });

  assert.equal(res.batch.batched, false);
  // The reason must be present and must name the switch, so a user asking "why
  // did this take 50x longer than it needed to" gets an answer rather than
  // silence. Not pinned to the exact wording of either the absent or the
  // explicitly-false path — 'batching is off, whether the key is absent or
  // explicitly false' covers that distinction.
  assert.match(res.batch.reason, /runtime\.batch\.auto/);
  assert.equal(fake.callCount, 4, 'four single calls, and the report names the reason');
  assert.deepEqual([...new Set(fake.calledEndpoints())], ['enrich_profile']);
});

test('a bulk response of the wrong length attributes only what it names', async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => personWithUrn(i));
  const { tree, input } = fixture(t, { rows });
  // Four results for five rows. Each result names its row by entityUrn, so those four
  // are attributable; the fifth has nothing and fails. Nobody takes another row's data.
  const fake = fakeHttp({ fallback: okJson([profileBody(0), profileBody(1), profileBody(2), profileBody(3)]) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, output: 'out.jsonl', root: tree.root, catalog: CATALOG,
    gates: gatesWithBatching(true), budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });

  assert.equal(res.exec.unaligned_batches, 1, 'a miscounted response is still reported');
  assert.equal(res.exec.ok, 4);
  assert.equal(res.exec.failed, 1);
  const errors = new Set(readJournal(res.journal_path).lines.filter((l) => l.error).map((l) => l.error));
  assert.ok(errors.has('bulk_unaligned'), `expected bulk_unaligned in ${[...errors]}`);
  // The charge is still real and still recorded — we did pay for it.
  assert.equal(readJsonl(res.ledger_path).length, 1);
});

test('a bulk response in a different order still gives each row its own data', async (t) => {
  // Recorded 2026-09-17: the live bulk endpoint answered A,B,C with B,C,A.
  const rows = Array.from({ length: 3 }, (_, i) => personWithUrn(i));
  const { tree, input } = fixture(t, { rows });
  const fake = fakeHttp({ fallback: okJson([profileBody(1), profileBody(2), profileBody(0)]) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, output: 'out.jsonl', root: tree.root, catalog: CATALOG,
    gates: gatesWithBatching(true), budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });

  assert.equal(res.exec.ok, 3);
  assert.equal(res.exec.unaligned_batches, 0);
  const out = readJsonl(path.join(tree.root, 'out.jsonl'));
  for (const row of out) {
    const i = Number(String(row.urn).split(':').pop()) - 1000;
    const got = JSON.stringify(row);
    assert.ok(got.includes(`First${i}`), `row ${i} carries its own profile: ${got}`);
    for (const j of [0, 1, 2].filter((k) => k !== i)) {
      assert.ok(!got.includes(`First${j}`), `row ${i} must not carry row ${j}'s data`);
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Fail closed on suppression, and never write a suppressed contact out
// ---------------------------------------------------------------------------

test('an unreadable suppression store stops the run before any call', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0)] });
  fs.rmSync(path.join(tree.root, 'gtm', 'suppression.jsonl'));

  await assert.rejects(
    () => runCall({
      endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
      dryRun: true, api: cannotCall(),
    }),
    (e) => e.name === 'SuppressionUnavailableError',
  );
});

test('a suppressed row is dropped before the call and never reaches the output', async (t) => {
  const rows = [
    { ...person(0), email: 'keep@acme.example' },
    { ...person(1), email: 'drop@acme.example' },
  ];
  const { tree, input } = fixture(t, { rows, suppress: ['drop@acme.example'] });
  const fake = fakeHttp({ fallback: okJson(profileBody(0)) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, output: 'out.jsonl', root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true,
  });

  assert.equal(res.plan.totals.skipped_suppressed, 1, 'dropped at PLAN time, before any call');
  assert.equal(fake.callCount, 1, 'a suppressed contact is never enriched');
  const out = readJsonl(path.join(tree.root, 'out.jsonl'));
  assert.equal(out.length, 1);
  assert.ok(!JSON.stringify(out).includes('drop@acme.example'));
});

// ---------------------------------------------------------------------------
// 10. A 402 aborts, and the rest is replannable
// ---------------------------------------------------------------------------

test('a 402 aborts the run and journals the rest as replannable', async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => person(i));
  const { tree, input } = fixture(t, { rows });
  let n = 0;
  const fake = fakeHttp({ fallback: () => (++n <= 2 ? okJson(profileBody(n)) : insufficientCredits({ balance: '2.5' })) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });

  assert.equal(res.exec.aborted, true);
  assert.equal(res.exec.abort_reason, 'insufficient_credits');
  assert.equal(res.exec.skipped_budget, 2, 'units after the 402 are skipped_budget, which resumes after a top-up');
  // The 402 is a free balance refresh, and it still gets a ledger line.
  const l402 = readJsonl(res.ledger_path).find((l) => l.http_status === 402);
  assert.ok(l402, 'a 402 must be accounted, not dropped');
  assert.equal(l402.cost_status, 'known_zero');
});

// ---------------------------------------------------------------------------
// 11. Search: pages, exhaustion, and the results the plan promised
// ---------------------------------------------------------------------------

test('a paged search journals per page and stops when a page comes back short', async (t) => {
  const { tree } = fixture(t);
  // Distinct ids per page: identical ids across pages are now deduplicated (see the
  // overlapping-pages test in tests/run-surface/live-run-defects.test.mjs).
  const full = (p) => Array.from({ length: 10 }, (_, i) => ({ id: p * 100 + i, name: `P${i}` }));
  let page = 0;
  const fake = fakeHttp({
    fallback: () => { page += 1; return okJson({ elements: page < 3 ? full(page) : full(page).slice(0, 2) }); },
  });

  const res = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO', limit: 10 }, pages: 6, pageSize: 10,
    output: 'found.jsonl', root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });

  assert.equal(fake.callCount, 3, 'page 3 came back short — pages 4..6 were never bought');
  assert.equal(res.search.exhausted, true);
  assert.equal(res.search.exhausted_at, 3);
  assert.equal(readJsonl(res.ledger_path).length, 3, 'a ledger line per page actually called');
  assert.equal(res.results.length, 22);
  assert.equal(readJsonl(path.join(tree.root, 'found.jsonl')).length, 22);

  // The pages that were never bought are journalled with a named reason, not silence.
  const errors = readJournal(res.journal_path).lines.filter((l) => l.error === 'search_exhausted');
  assert.equal(errors.length, 3);
});

test('a resumed search does not re-buy a page an earlier run proved empty', async (t) => {
  const { tree } = fixture(t);
  const runId = 'S8srch';
  const fake = fakeHttp({ fallback: okJson({ elements: [{ id: 1 }] }) });   // always short

  const first = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO', limit: 10 }, pages: 5, pageSize: 10, runId,
    root: tree.root, catalog: CATALOG, budget: 500, api: apiOver(fake), confirm: async () => true, maxAttempts: 1,
  });
  assert.equal(fake.callCount, 1);
  assert.equal(first.search.exhausted, true);

  const again = fakeHttp({ fallback: okJson({ elements: [{ id: 1 }] }) });
  const res = await runSearch({
    endpoint: 'people_search', params: { title: 'CTO', limit: 10 }, pages: 5, pageSize: 10, runId, resume: runId,
    root: tree.root, catalog: CATALOG, budget: 500, api: apiOver(again), confirm: async () => true, maxAttempts: 3,
  });
  assert.equal(again.callCount, 0, 'the search already proved itself exhausted; re-buying those pages is a pure loss');
  assert.equal(res.resume_exhausted_skipped, 4);
});

// ---------------------------------------------------------------------------
// 12. The mapping tripwire still fires on this path
// ---------------------------------------------------------------------------

test('a paid 2xx that maps to nothing is a recorded mapping failure, not a blank column', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0), person(1)] });
  // Data-bearing keys that RESPONSE_MAPS does not know: the empty-column shape exactly.
  const fake = fakeHttp({ fallback: okJson({ given_name: 'Ada', job: 'CTO', employer: 'Acme' }) });

  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true,
  });

  assert.equal(res.mapping.mapping_failures, 2);
  assert.equal(res.mapping.total_blackout, true, 'paid for calls, delivered zero columns');
  assert.equal(res.receipt.mapping_blackout, true, 'and the receipt says so');
  // The evidence is the KEY NAMES only, never a value (law 7).
  const keys = res.mapping_issues[0].raw_keys;
  assert.deepEqual(keys.sort(), ['employer', 'given_name', 'job']);
  assert.ok(!JSON.stringify(res.mapping_issues).includes('Ada'));
});

// ---------------------------------------------------------------------------
// 13. Concurrency
// ---------------------------------------------------------------------------

test('a second concurrent run over the same list is refused, not double-charged', async (t) => {
  const { tree, input } = fixture(t, { rows: [person(0)] });
  const fake = fakeHttp({
    fallback: async () => {
      // While the first run holds the lock, a second must be refused.
      await assert.rejects(
        () => runCall({
          endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
          budget: 500, api: cannotCall(), confirm: async () => true,
        }),
        (e) => e.name === 'ConcurrentRunError',
      );
      return okJson(profileBody(0));
    },
  });

  await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    budget: 500, api: apiOver(fake), confirm: async () => true,
  });
});
