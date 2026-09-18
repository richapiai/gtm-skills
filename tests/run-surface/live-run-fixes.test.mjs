// Defects found by eleven live recipe runs on the real API (2026-09-17).
//
// Each test replays a RECORDED response shape (tests/fixtures/live/*.json) through the
// real runtime over a fake transport, and each one fails against the pre-fix code:
//
//   1. the page walk ended early, because "exhausted" was decided against an ASSUMED
//      page size while the response carried `totalPages` / `last` / `pagination.*`;
//   2. the dry run priced a page at the gates.yaml assumption and never said it was one;
//   3. `--start-page N` had to confirm on the ABSOLUTE page number, not just position;
//   4. search rows came out in the API's nested camelCase and `enrich` could not read them;
//   5. the pack's own `not_found` marker was read as a value and bought a paid call;
//   6. a non-2xx kept its pre-call estimate in the reconciliation;
//   7. `richapi call --batch` was inert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson } from '../helpers/index.mjs';
import { CATALOG, REPO, fixture, apiOver, fakeHttp, personWithUrn, profileBody, gatesWithBatching } from './helpers.mjs';
import {
  runSearch, runCall, readPageMeta, pageExhausted, normalisePageRow,
} from '../../_lib/run.mjs';
import { reconcile } from '../../_lib/dryrun.mjs';
import { toDescriptor, present } from '../../_lib/enrich.mjs';
import { loadSuppressionStore } from '../../_lib/suppression.mjs';
import { nullCache } from '../../_lib/cache.mjs';

const live = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'live', `${name}.json`), 'utf8')).body;
const noSleep = async () => {};
const rowsOf = (body) => body.content ?? body.elements;

// ---------------------------------------------------------------------------
// 1. the page walk reads the response, not an assumption
// ---------------------------------------------------------------------------

test('readPageMeta reads both recorded paging shapes, and neither one of the other', () => {
  const spring = readPageMeta(live('post_activities'));
  assert.equal(spring.source, 'spring_page');
  assert.equal(spring.zero_based, true);
  assert.equal(spring.page_number, 0);
  assert.equal(spring.page_size, 10);
  assert.equal(spring.total_pages, 2);
  assert.equal(spring.last, false);

  const paged = readPageMeta(live('linkedin_company_search'));
  assert.equal(paged.source, 'pagination');
  assert.equal(paged.zero_based, false);
  assert.equal(paged.page_number, 1);
  assert.equal(paged.page_size, 50, 'the live page held 50, against an assumed 25');
  assert.equal(paged.total_pages, 20);

  // linkedin_ad_search answers every paging field as null. "Says nothing" must degrade
  // to nothing, never to a number.
  const nothing = readPageMeta(live('linkedin_ad_search'));
  assert.equal(nothing.total_pages, null);
  assert.equal(nothing.page_number, null);

  assert.equal(readPageMeta(null), null);
  assert.equal(readPageMeta([1, 2]), null);
});

test('a short page the API says is NOT the last one does not end the walk', () => {
  // The exact live shape: post_activities page 0, 10 rows, totalPages 2, last false.
  const meta = readPageMeta(live('post_activities'));
  const v = pageExhausted({ meta, rows: rowsOf(live('post_activities')), pageSize: 25 });
  assert.equal(v.exhausted, false, 'the old short-page heuristic declared this exhausted');
  assert.equal(v.basis, 'response.total_pages');

  // And the LAST page is over, on the same evidence.
  const last = pageExhausted({ meta: { ...meta, page_number: 1 }, rows: [1], pageSize: 25 });
  assert.equal(last.exhausted, true);
  assert.equal(last.basis, 'response.total_pages');
});

test('the short-page heuristic still applies, but only when the response says nothing', () => {
  const blind = pageExhausted({ meta: null, rows: [1, 2], pageSize: 25 });
  assert.equal(blind.exhausted, true);
  assert.equal(blind.basis, 'short_page_heuristic');
  assert.match(blind.reason, /ASSUMPTION/);

  assert.equal(pageExhausted({ meta: null, rows: [], pageSize: 25 }).basis, 'empty_page');
  assert.equal(pageExhausted({ meta: null, rows: new Array(25).fill(1), pageSize: 25 }).exhausted, false);
});

test('post_activities: page 0 returns 10 of totalPages 2 and page 1 is still bought', async (t) => {
  const { tree } = fixture(t);
  const body = live('post_activities');
  const pages = [];
  const fake = fakeHttp({
    fallback: (call) => {
      pages.push(call.body.page);
      // page 0: last false, page 1: last true — the recording's own metadata.
      return okJson({ ...body, number: call.body.page, last: call.body.page >= 1 });
    },
  });

  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 2, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 100, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });

  assert.deepEqual(pages, [0, 1], 'the walk stopped at page 0 before the fix');
  assert.equal(res.search.exhausted, true);
  assert.equal(res.search.exhausted_at, 1);
  assert.equal(res.search.exhausted_basis, 'response.last');
  // The last total the API gave is reported, never invented.
  assert.equal(res.search.last_reported_total, body.totalElements);
});

test('a run never claims exhausted while the response says otherwise', async (t) => {
  const { tree } = fixture(t);
  const body = live('post_activities');
  const fake = fakeHttp({ fallback: (call) => okJson({ ...body, number: call.body.page, last: false, totalPages: 9 }) });
  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 3, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 100, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });
  assert.equal(res.search.exhausted, false);
  assert.equal(fake.callCount, 3, 'all three planned pages were bought');
  assert.ok(res.notes.some((n) => /the walk continues/.test(n)),
    'a short page that is not the end must SAY the walk continues');
});

// ---------------------------------------------------------------------------
// 2. a page is priced from the request, then from what a page reported
// ---------------------------------------------------------------------------

test('an explicit page-size field in the request prices the plan, not the gate assumption', async (t) => {
  const { tree } = fixture(t);
  const dry = await runSearch({
    endpoint: 'linkedin_company_search', params: { keyword: 'crm', limit: 50 }, pages: 1,
    root: tree.root, catalog: CATALOG, dryRun: true, api: null, confirm: async () => false,
  });
  assert.equal(dry.plan.totals.page_size, 50);
  assert.equal(dry.plan.totals.page_size_basis, 'request');

  // With no hint at all, the plan still prices — and SAYS the number is an assumption.
  const blind = await runSearch({
    endpoint: 'linkedin_company_search', params: { keyword: 'crm' }, pages: 1,
    root: tree.root, catalog: CATALOG, dryRun: true, api: null, confirm: async () => false,
  });
  assert.equal(blind.plan.totals.page_size_basis, 'assumption');
  assert.ok(blind.plan.totals.page_size < 50, 'the assumption was HALF the live page');
});

test('once a page reports its size, that size prices every page after it', async (t) => {
  const { tree } = fixture(t);
  const body = live('linkedin_company_search');
  const fake = fakeHttp({ fallback: () => okJson(body) });
  const res = await runSearch({
    endpoint: 'linkedin_company_search', params: { keyword: 'crm' }, pages: 1,
    root: tree.root, catalog: CATALOG, budget: 500, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });
  assert.equal(res.search.page_size, 50, 'the API reported 50; the plan had assumed 25');
  assert.equal(res.search.page_size_basis, 'response');
  assert.equal(res.search.planned_page_size_basis, 'assumption');
});

// ---------------------------------------------------------------------------
// 3. --start-page is gated on the ABSOLUTE page number
// ---------------------------------------------------------------------------

test('a fresh run that starts deep into a walk must confirm', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson(live('post_activities')) });
  let asked = 0;
  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 1, startPage: 4,
    root: tree.root, catalog: CATALOG, budget: 100, api: apiOver(fake),
    confirm: async () => { asked += 1; return false; },
  });
  assert.equal(asked, 1, '--start-page 4 is page four, whatever its position in the run');
  assert.equal(res.mode, 'declined');
  assert.equal(fake.callCount, 0);
  assert.ok(res.gate.confirms.some((c) => c.gate.startsWith('unbounded_endpoints')));
});

test('and position in the run still gates a zero-based walk', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson(live('post_activities')) });
  let asked = 0;
  await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 3, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 100, api: apiOver(fake),
    confirm: async () => { asked += 1; return false; },
  });
  assert.equal(asked, 1, 'pages 0,1,2 — the second and third must be confirmed');
});

// ---------------------------------------------------------------------------
// 4. search output feeds `enrich`
// ---------------------------------------------------------------------------

test('normalisePageRow derives the pack\'s identifier columns from the RECORDED shapes', () => {
  const people = normalisePageRow(rowsOf(live('people_search'))[0]);
  assert.equal(people.linkedin_url, rowsOf(live('people_search'))[0].url);
  assert.equal(people.urn, rowsOf(live('people_search'))[0].entityUrn);
  assert.equal(people.first_name, rowsOf(live('people_search'))[0].firstname);
  assert.equal(people.last_name, rowsOf(live('people_search'))[0].lastname);
  assert.equal(people.title, rowsOf(live('people_search'))[0].headline);

  const lead = normalisePageRow(rowsOf(live('lead_search'))[0]);
  const rawLead = rowsOf(live('lead_search'))[0];
  assert.equal(lead.linkedin_url, rawLead.linkedinUrl);
  assert.equal(lead.urn, rawLead.id);
  assert.equal(lead.first_name, rawLead.firstName);
  assert.equal(lead.title, rawLead.currentPositions[0].title);
  assert.equal(lead.company_name, rawLead.currentPositions[0].companyName);

  const emp = normalisePageRow(rowsOf(live('linkedin_company_employees_search'))[0]);
  const rawEmp = rowsOf(live('linkedin_company_employees_search'))[0];
  assert.equal(emp.urn, rawEmp.id);
  assert.equal(emp.title, rawEmp.position);

  // post_activities nests the person one level down, in `commenter`.
  const act = normalisePageRow(rowsOf(live('post_activities'))[0]);
  const rawAct = rowsOf(live('post_activities'))[0];
  assert.equal(act.first_name, rawAct.commenter.firstName);
  assert.equal(act.last_name, rawAct.commenter.lastName);
  // The PERSON's urn, which is what the bulk enrichment endpoints take — not the
  // comment's own id, which is the row identity.
  assert.equal(act.urn, rawAct.commenter.entityUrn);
  assert.equal(act.linkedin_url, rawAct.url);

  // The raw body is kept exactly as it was.
  for (const [k, v] of Object.entries(rawAct)) assert.deepEqual(act[k], v, k);
});

test('normalisePageRow never invents a key, and never overwrites the API\'s own', () => {
  // No recording carries a company domain on a search row, so none is derived.
  for (const name of ['people_search', 'lead_search', 'linkedin_company_employees_search', 'post_activities']) {
    for (const row of rowsOf(live(name))) {
      assert.ok(!('company_domain' in normalisePageRow(row)), `${name}: company_domain was invented`);
    }
  }
  const IN = 'https://www.linkedin.com/in/someone/';
  const kept = normalisePageRow({ linkedinUrl: IN, linkedin_url: 'https://mine' });
  assert.equal(kept.linkedin_url, 'https://mine');
  // An explicit empty marker is NOT a value, so it is filled in.
  assert.equal(normalisePageRow({ linkedinUrl: IN, linkedin_url: 'not_found' }).linkedin_url, IN);
});

test('a written search page carries the columns enrich reads', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson(live('lead_search')) });
  await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 1, output: 'leads.jsonl',
    root: tree.root, catalog: CATALOG, budget: 500, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });
  const written = fs.readFileSync(path.join(tree.root, 'leads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(written.length > 0);
  assert.ok(written.every((r) => typeof r.linkedin_url === 'string'), 'every row must carry linkedin_url');
  assert.ok(written.every((r) => typeof r.urn === 'string'));
});

// ---------------------------------------------------------------------------
// 5. the pack's explicit empty markers are ABSENT
// ---------------------------------------------------------------------------

test('`not_found` in a request parameter buys nothing', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson({ email: 'a@b.com', status: 'valid' }) });
  const res = await runCall({
    endpoint: 'email_verifier', params: { email: 'not_found' },
    root: tree.root, catalog: CATALOG, budget: 50, api: apiOver(fake), confirm: async () => true,
  });
  assert.equal(fake.callCount, 0, 'a paid verification of the string "not_found" was billed before the fix');
  assert.equal(res.plan.totals.calls_planned, 0);
  assert.equal(res.ledger_totals.ledger_total, 0);
});

// ---------------------------------------------------------------------------
// 6a. a call that was never billed contributes no estimate
// ---------------------------------------------------------------------------

test('reconcile ignores the pre-call estimate of a non-2xx', () => {
  const plan = { run_id: 'r', totals: { credits_estimated: 10 } };
  const lines = [
    { run_id: 'r', cost_status: 'known_zero', credits_estimated: 5, credits_actual: 0 },
    { run_id: 'r', cost_status: 'estimated_unverifiable', credits_estimated: 5, credits_actual: null },
  ];
  const rec = reconcile({ plan, ledgerLines: lines });
  assert.equal(rec.actual, 5, 'the failed call used to add its 5-credit estimate to the bill');
  assert.equal(rec.not_billed_lines, 1);
  assert.match(rec.not_billed_rule, /deduct no credits/);
  assert.equal(rec.unverifiable_lines, 1, 'a non-2xx is not an unverifiable estimate either');
});

// ---------------------------------------------------------------------------
// 7. `richapi call --batch`
// ---------------------------------------------------------------------------

test('batching decides over the CALLABLE rows, so a cached row cannot switch it off', async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => personWithUrn(i));
  const { tree, input } = fixture(t, { rows });
  // A second list holding the first three rows, run first, so the big list arrives with
  // three cache hits and two callable rows.
  const { input: warm } = { input: 'warm.csv' };
  const header = Object.keys(rows[0]);
  fs.writeFileSync(path.join(tree.root, warm),
    [header.join(','), ...rows.slice(0, 3).map((r) => header.map((h) => r[h]).join(','))].join('\n') + '\n');

  const http = fakeHttp({
    fallback: (call) => okJson((call.body?.urns ?? []).map((u) => ({
      ...profileBody(0), entityUrn: String(u).split(':').pop(),
    }))),
  });
  const base = {
    endpoint: 'enrich_profile', root: tree.root, catalog: CATALOG,
    gates: gatesWithBatching(true), budget: 500, api: apiOver(http), confirm: async () => true,
  };
  const first = await runCall({ ...base, input: warm });
  assert.equal(first.batch.batched, true);

  const again = await runCall({ ...base, input });
  assert.equal(again.exec.skipped_cache, 3, 'three rows answer from cache');
  assert.equal(again.batch.batched, true, 'the two callable rows still batch');
  assert.equal(again.batch.rows_callable, 2);
});

test('--no-batch / gates.runtime.batch.auto=false still means single calls', async (t) => {
  const rows = Array.from({ length: 4 }, (_, i) => personWithUrn(i));
  const { tree, input } = fixture(t, { rows });
  const http = fakeHttp({ fallback: () => okJson(profileBody(0)) });
  const res = await runCall({
    endpoint: 'enrich_profile', input, root: tree.root, catalog: CATALOG,
    gates: gatesWithBatching(false), budget: 500, api: apiOver(http), confirm: async () => true,
  });
  assert.equal(res.batch.batched, false);
  assert.match(res.batch.reason, /single calls/);
});

test('`not_found` in a LIST column plans no hop and buys nothing', async (t) => {
  const rows = [{
    linkedin_url: 'https://linkedin.com/in/a',
    title: 'VP Sales',
    company_name: 'Acme',
    // The explicit empty markers the skills write. Every one of these used to read as a
    // value: `email` made the row "already has an email" AND became the address the
    // 2-credit email_verifier hop was asked to verify.
    email: 'not_found',
    phone: 'not_verifiable',
  }];
  const { tree, input } = fixture(t, { rows });
  const http = fakeHttp({ fallback: () => okJson({ result: { email: 'real@acme.example' } }) });
  const res = await runCall({
    endpoint: 'email_verifier', input, root: tree.root, catalog: CATALOG,
    budget: 50, api: apiOver(http), confirm: async () => true,
  });
  assert.equal(http.callCount, 0, 'a paid verification of the string "not_found"');
  assert.equal(res.plan.totals.calls_planned, 0);
});

test('the enrichment waterfall treats an explicit empty marker as absent', (t) => {
  const { tree } = fixture(t);
  const store = loadSuppressionStore({ root: tree.root, path: path.join(tree.root, 'gtm', 'suppression.jsonl') });
  const cache = nullCache('test');

  for (const marker of ['not_found', 'not_verifiable', 'not_applicable', '', '  ']) {
    const { descriptor, skipReasons } = toDescriptor(
      { linkedin_url: 'https://linkedin.com/in/a', first_name: 'A', last_name: 'B', company_domain: 'acme.example', email: marker },
      0, { store, cache },
    );
    // "row already has an email" was the old verdict, which both skipped the finder AND
    // planned a paid email_verifier call on the literal string.
    assert.notEqual(skipReasons.email_finder, 'row already has an email', marker);
    assert.ok(!descriptor.has.includes('email'), `${marker}: planned as if it were an address`);
  }

  // A real address is still an address.
  const real = toDescriptor({ linkedin_url: 'https://linkedin.com/in/a', email: 'a@b.com' }, 0, { store, cache });
  assert.equal(real.skipReasons.email_finder, 'row already has an email');
  assert.equal(present('a@b.com'), true);
  assert.equal(present('not_found'), false);
});
