// Defects found by the live post-engagers run (real API, 2026-09-17).
//
// Each test replays the recorded shape (tests/fixtures/live/*.json) through the real
// runtime over a fake transport, and each one fails against the pre-fix code:
//
//   1. a flat, paged endpoint priced per RESULT: post_activities is 3 credits a page,
//      the runtime cap forecast 75 and refused --budget 39, the ledger booked 30/page;
//   2. post_details had no response map — the paid call returned {};
//   3. a 503 was terminal on the first try, exited 0 with no error text, and the
//      counters read "attempted 7, ok 8";
//   4. preflight ignored --dir;
//   5. an absolute state dir built a broken suppression path;
//   6. enrich --batch needed linkedin_url beside urn, and the dry run hid the bulk call;
//   7. overlapping pages were written twice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { okJson, underMaintenance, makeGtmTree, trackedTmp } from '../helpers/index.mjs';
import { CATALOG, REPO, fixture, apiOver, fakeHttp, readJsonl } from './helpers.mjs';
import { runSearch, runCall, dedupePageRows } from '../../_lib/run.mjs';
import { estimate } from '../../_lib/ledger.mjs';
import { runWaterfall, isRetryableStatus } from '../../_lib/journal.mjs';
import { runBatchedHop } from '../../_lib/batch.mjs';
import { runEnrich } from '../../_lib/enrich.mjs';
import { RichApiClient } from '../../_lib/client.mjs';
import { ensureSuppressionStore, addSuppressionEntry, filterOutputList } from '../../_lib/suppression.mjs';
import { exitCodeFor } from '../../bin/richapi.mjs';

const live = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'live', `${name}.json`), 'utf8')).body;
const noSleep = async () => {};

// ---------------------------------------------------------------------------
// 1. flat + paged
// ---------------------------------------------------------------------------

test('a flat price is never multiplied by a result count', () => {
  for (const name of ['post_activities', 'search_bing']) {
    const entry = CATALOG.endpoints[name];
    assert.equal(entry.pricing.model, 'flat');
    const per = entry.pricing.credits_per_call;
    assert.equal(estimate(entry, { resultCount: 10 }).credits, per, `${name}: 10 rows is still one call`);
    assert.equal(estimate(entry, { resultCount: 25 }).credits, per);
  }
  // An explicit number of CALLS still scales it.
  assert.equal(estimate(CATALOG.endpoints.post_activities, { batchSize: 2 }).credits, 6);
});

test('post_activities: --budget 39 runs, and the ledger books 3 per page, not 30', async (t) => {
  const { tree } = fixture(t);
  const body = live('post_activities');
  assert.ok(body.content.length > 1, "the recording carries several rows, so a per-row price would show");
  const fake = fakeHttp({ fallback: () => okJson(body) });

  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 1, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 39, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });

  assert.equal(res.plan.totals.credits_estimated, 3);
  assert.equal(res.budget_stop, null, 'the runtime cap forecast 75 for a 3-credit page');
  assert.equal(fake.callCount, 1);
  const lines = readJsonl(res.ledger_path);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].credits_estimated, 3, `booked ${lines[0].credits_estimated} (${lines[0].estimate_basis})`);
});

test('search_bing: a 1-credit page is not priced as 10 results', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson(live('search_bing')) });
  const res = await runSearch({
    endpoint: 'search_bing', params: { query: 'x', limit: 10 }, pages: 1,
    root: tree.root, catalog: CATALOG, budget: 5, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });
  assert.equal(res.budget_stop, null);
  assert.equal(fake.callCount, 1);
  assert.equal(readJsonl(res.ledger_path)[0].credits_estimated, 1);
});

// ---------------------------------------------------------------------------
// 2. post_details delivers columns
// ---------------------------------------------------------------------------

test('post_details: the paid call delivers columns, not {}', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson(live('post_details')) });
  const res = await runCall({
    endpoint: 'post_details', params: { urn: 'urn:li:activity:1' }, output: 'post.jsonl',
    root: tree.root, catalog: CATALOG, budget: 10, api: apiOver(fake), confirm: async () => true,
  });
  const [row] = readJsonl(path.join(tree.root, 'post.jsonl'));
  assert.equal(row.post_urn, live('post_details').urn);
  assert.equal(row.post_comment_count, 17);
  assert.equal(row.post_reaction_count, 150);
  assert.equal(res.mapping.total_blackout ?? false, false);
});

// ---------------------------------------------------------------------------
// 3. 5xx
// ---------------------------------------------------------------------------

test('5xx is retryable like 429; 4xx other than 429 is not', () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, String(s));
  for (const s of [0, 400, 401, 402, 404, 422, null]) assert.equal(isRetryableStatus(s), false, String(s));
});

test('a 503 is retried with backoff and the page is bought on the retry', async (t) => {
  const { tree } = fixture(t);
  const body = live('post_activities');
  const fake = fakeHttp({ queue: [underMaintenance(), okJson(body)] });
  const slept = [];
  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 1, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 39, api: apiOver(fake),
    confirm: async () => true, sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(fake.callCount, 2);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] > 0, 'backoff, not an immediate re-hammer');
  assert.equal(res.exec.ok, 1);
  assert.equal(res.exec.failed, 0);
  assert.deepEqual(res.failures, {});
  assert.equal(exitCodeFor(res), 0);
});

test('a 503 that persists fails the unit as http_503, exits non-zero, and counts add up', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => underMaintenance() });
  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 1, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 39, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep, maxAttempts: 3,
  });
  assert.equal(fake.callCount, 3, 'bounded: maxAttempts, then stop');
  assert.deepEqual(res.failures, { http_503: 1 });
  assert.equal(exitCodeFor(res), 8);
  const e = res.exec;
  assert.ok(e.attempted >= e.ok + e.failed, `attempted ${e.attempted}, ok ${e.ok}, failed ${e.failed}`);
  assert.equal(e.attempted, 1, 'one unit, however many retries');
  assert.ok(readJsonl(res.ledger_path).every((l) => l.credits_actual === 0), 'a non-2xx is not billed');
});

test('an exhausted search is not reported as a failure', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: () => okJson({ content: [{ id: 'a' }] }) });
  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 2, startPage: 0,
    root: tree.root, catalog: CATALOG, budget: 39, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });
  assert.equal(res.search.exhausted, true);
  assert.deepEqual(res.failures, {});
  assert.equal(exitCodeFor(res), 0);
});

test('the batched executor retries a 503 too, and counts rows attempted once', async () => {
  const units = [0, 1].map((i) => ({ row_id: `r${i}`, hop: 0, endpoint: 'enrich_profile', credits_estimated: 1 }));
  let n = 0;
  const client = {
    callBulk: async ({ units: g }) => {
      n += 1;
      if (n === 1) { const e = new Error('http_503'); e.status = 503; throw e; }
      return { results: g.map(() => ({ ok: 1 })), returned: g.length };
    },
  };
  const res = await runBatchedHop({
    journal: { appendPending () {}, appendResult () {} }, units, client,
    bulk: { endpoint: 'enrich_profiles_bulk', maxBatch: 50 }, sleep: noSleep,
  });
  assert.equal(n, 2);
  assert.equal(res.ok, 2);
  assert.equal(res.attempted, 2);
  assert.equal(res.calls_made, 2);
});

test('runWaterfall: attempted counts units, calls_made counts calls', async () => {
  let n = 0;
  const res = await runWaterfall({
    journal: { appendPending () {}, appendResult () {} },
    units: [{ row_id: 'a', hop: 0, endpoint: 'x' }],
    client: { call: async () => { n += 1; if (n < 3) { const { HttpError } = await import('../../_lib/journal.mjs'); throw new HttpError(502); } return { body: {} }; } },
    sleep: noSleep,
  });
  assert.equal(res.ok, 1);
  assert.equal(res.calls_made, 3);
  assert.equal(res.attempted, 1);
});

// ---------------------------------------------------------------------------
// 4. preflight --dir / --root
// ---------------------------------------------------------------------------

function preflight (args, cwd) {
  const out = execFileSync('bash', [path.join(REPO, 'bin', 'richapi-skills-preflight'), ...args], {
    encoding: 'utf8', timeout: 30000, cwd,
    env: { ...process.env, richapi_SKILLS_HOME: trackedTmp('pf-home-'), richapi_MCP_ORIGIN: 'http://127.0.0.1:9' },
  });
  return /^SUPPRESSION: (\w+)$/m.exec(out)?.[1];
}

test('preflight honours --dir and --root, and answers the same every time', () => {
  const project = trackedTmp('pf-project-');
  ensureSuppressionStore(project, 'state');                   // <project>/state/suppression.jsonl
  const elsewhere = trackedTmp('pf-elsewhere-');              // no store here

  assert.equal(preflight([], elsewhere), 'STOP', 'no --dir: ./gtm, which does not exist');
  const abs = path.join(project, 'state');
  for (let i = 0; i < 3; i++) {
    assert.equal(preflight(['--dir', abs], elsewhere), 'OK', `absolute --dir, run ${i + 1}`);
  }
  assert.equal(preflight([`--dir=${abs}`], elsewhere), 'OK');
  assert.equal(preflight(['--root', project, '--dir', 'state'], elsewhere), 'OK');
  assert.equal(preflight(['--dir', 'state'], project), 'OK', 'relative --dir resolves against cwd');
  assert.equal(preflight(['--dir', 'nope'], project), 'STOP');
});

// ---------------------------------------------------------------------------
// 5. absolute dir
// ---------------------------------------------------------------------------

test('filterOutputList resolves an absolute dir instead of gluing it under root', () => {
  const project = trackedTmp('abs-dir-');
  const abs = path.join(project, 'client-a', 'gtm');
  ensureSuppressionStore(path.join(project, 'client-a'), 'gtm');
  addSuppressionEntry('gone@acme.example', { dir: abs, root: '/unrelated' });
  const { kept, dropped } = filterOutputList(
    [{ email: 'gone@acme.example' }, { email: 'ok@acme.example' }],
    { root: trackedTmp('other-root-'), dir: abs },
  );
  assert.equal(dropped.length, 1);
  assert.deepEqual(kept, [{ email: 'ok@acme.example' }]);
});

// ---------------------------------------------------------------------------
// 6. enrich --batch with a urn column only
// ---------------------------------------------------------------------------

function urnList (t, n) {
  const tree = makeGtmTree({ prefix: 'urn-batch-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const input = path.join(tree.root, 'urns.csv');
  fs.writeFileSync(input, ['urn', ...Array.from({ length: n }, (_, i) => `urn:li:fsd_profile:${900 + i}`)].join('\n') + '\n');
  return { tree, input };
}

test('enrich --batch --dry-run on a urn-only list names and prices the bulk endpoint', async (t) => {
  const { tree, input } = urnList(t, 3);
  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, dryRun: true, batch: true, verify: false,
    api: new Proxy({}, { get () { throw new Error('dry run touched the client'); } }),
  });
  const profile = res.plan.per_hop.find((h) => h.endpoint === 'enrich_profile');
  assert.equal(profile.calls_planned, 3, 'a urn is enough input when batching');
  const b = res.batch.find((x) => x.endpoint === 'enrich_profile');
  assert.equal(b.bulk_variant, 'enrich_profiles_bulk');
  assert.equal(b.batched, true);
  assert.equal(b.calls, 1);
  assert.equal(b.credits_estimated, estimate(CATALOG.endpoints.enrich_profiles_bulk, { resultCount: 3 }).credits);
  assert.match(res.text, /enrich_profiles_bulk/);
});

test('enrich --batch on a urn-only list actually takes the bulk path', async (t) => {
  const { tree, input } = urnList(t, 3);
  const http = fakeHttp({
    fallback: (call) => okJson((call.body?.urns ?? []).map((u) => ({ entityUrn: u, firstname: 'A' }))),
  });
  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 100, batch: true, verify: false,
    api: new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch }), confirm: async () => true, sleep: noSleep,
  });
  const bulk = http.calls.filter((c) => c.endpoint === 'enrich_profiles_bulk');
  assert.equal(bulk.length, 1);
  assert.equal(bulk[0].body.urns.length, 3);
  assert.equal(res.exec.batched_rows, 3);
});

test('without --batch a urn-only list still plans no profile call (the single form needs a URL)', async (t) => {
  const { tree, input } = urnList(t, 2);
  const res = await runEnrich({ input, root: tree.root, catalog: CATALOG, dryRun: true, verify: false });
  assert.equal(res.plan.per_hop.find((h) => h.endpoint === 'enrich_profile').calls_planned, 0);
  assert.deepEqual(res.batch, []);
});

// ---------------------------------------------------------------------------
// 7. overlapping pages
// ---------------------------------------------------------------------------

test('rows repeated across pages are written once, the drop is reported, the last total is kept', async (t) => {
  const { tree } = fixture(t);
  const row = (id, who) => ({ id, comment: 'x', commenter: { entityUrn: who } });
  const page0 = Array.from({ length: 10 }, (_, i) => row(`c${i}`, `u${i}`));
  const page1 = [...page0.slice(7), ...Array.from({ length: 7 }, (_, i) => row(`c${10 + i}`, `u${10 + i}`))];
  const fake = fakeHttp({
    queue: [okJson({ content: page0, totalElements: 16 }), okJson({ content: page1, totalElements: 17 })],
  });
  const res = await runSearch({
    endpoint: 'post_activities', params: { urn: 'urn:li:activity:1' }, pages: 2, startPage: 0, pageSize: 10,
    output: 'engagers.jsonl', root: tree.root, catalog: CATALOG, budget: 39, api: apiOver(fake),
    confirm: async () => true, sleep: noSleep,
  });
  assert.equal(fake.callCount, 2);
  assert.equal(res.results.length, 17);
  assert.equal(res.search.duplicates_dropped, 3);
  assert.equal(res.search.last_reported_total, 17, 'the total moves; report the last one seen');
  assert.equal(readJsonl(path.join(tree.root, 'engagers.jsonl')).length, 17);
  assert.ok(res.notes.some((n) => /3 row\(s\) appeared on more than one page/.test(n)));
});

test('dedupe keys: id, urn, entityUrn, commenter.entityUrn; unidentifiable rows are kept', () => {
  const { rows, duplicates } = dedupePageRows([
    { id: 1 }, { id: 1 }, { urn: 'u' }, { urn: 'u' }, { entityUrn: 'e' }, { entityUrn: 'e' },
    { commenter: { entityUrn: 'c' } }, { commenter: { entityUrn: 'c' } }, { name: 'x' }, { name: 'x' },
  ]);
  assert.equal(duplicates, 4);
  assert.equal(rows.length, 6);
});
