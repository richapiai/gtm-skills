// Auto-batching.
//
// Verify: a 500-row enrich issues 10 calls, not 500.
//
// The catch this task exists for: enrich_profile is 1 credit per CALL and
// enrich_profiles_bulk is 1 credit per RESULT, so the loop and the batch cost the
// SAME credits. A cost gate can never detect the difference. Only the executor can.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp, okJson, insufficientCredits, tooManyRequests } from '../helpers/index.mjs';
import { runEnrich, loadCatalog } from '../../_lib/enrich.mjs';
import { RichApiClient } from '../../_lib/client.mjs';
import { bulkVariantFor, chunk, byHop } from '../../_lib/batch.mjs';
import { readJournal, summarize } from '../../_lib/journal.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

function fixture (t, rows) {
  const tree = makeGtmTree({ prefix: 't14-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const header = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const csv = [header.join(','), ...rows.map(r => header.map(h => r[h] ?? '').join(','))].join('\n') + '\n';
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, csv);
  return { tree, input };
}

/** A row that CAN be batched: it carries the URN the bulk endpoint actually takes. */
const withUrn = (i) => ({
  first_name: `First${i}`, last_name: `Last${i}`,
  linkedin_url: `https://linkedin.com/in/p${i}`,
  urn: `urn:li:fsd_profile:${100000 + i}`,
  email: `p${i}@acme.example`, // so email_finder is not applicable: one hop, 500 units
});

/** The same row without a URN — the realistic shape of a prospect list. */
const noUrn = (i) => { const r = withUrn(i); delete r.urn; return r; };

// ---------------------------------------------------------------------------

test('500 rows with URNs issue 10 bulk calls, not 500', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 500 }, (_, i) => withUrn(i)));

  const http = createFakeHttp({
    fallback: (call) => {
      const urns = call.body?.urns ?? [];
      return okJson(urns.map((u, i) => ({ urn: u, title: `T${i}`, company_name: 'Acme' })));
    },
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api,
    verify: false, batch: true, confirm: async () => true,
  });

  assert.equal(res.http_calls, 10, `expected 10 bulk calls, got ${res.http_calls}`);
  assert.equal(res.exec.batched_calls, 10);
  assert.equal(res.exec.batched_rows, 500);
  assert.equal(res.exec.ok, 500, 'every row must still be accounted for individually');

  // Every call went to the BULK endpoint, at the catalog's max_batch.
  assert.ok(http.calls.every(c => c.endpoint === 'enrich_profiles_bulk'));
  assert.ok(http.calls.every(c => c.body.urns.length <= CATALOG.endpoints.enrich_profile.max_batch));
});

test('batching keeps PER-ROW journalling, so resume still works', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 120 }, (_, i) => withUrn(i)));
  const http = createFakeHttp({
    fallback: (call) => okJson((call.body?.urns ?? []).map(u => ({ urn: u, title: 'VP' }))),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api,
    verify: false, batch: true, confirm: async () => true,
  });

  assert.equal(res.http_calls, 3); // 120 rows / 50 = 3 calls
  const { lines } = readJournal(res.journal_path);
  const units = summarize(lines);
  assert.equal(units.size, 120, 'one journal unit per ROW, not per batch');
  assert.equal([...units.values()].filter(u => u.status === 'ok').length, 120);
  // Before AND after per row, exactly as for single calls.
  assert.equal(lines.filter(l => l.status === 'pending').length, 120);
});

test('ONE ledger line per bulk call, with the result count', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 100 }, (_, i) => withUrn(i)));
  const http = createFakeHttp({
    fallback: (call) => okJson((call.body?.urns ?? []).map(u => ({ urn: u }))),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api,
    verify: false, batch: true, confirm: async () => true,
  });

  const ledger = fs.readFileSync(path.join(tree.root, 'gtm', 'api-calls.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 2, 'the ledger records CALLS, and there were two');
  assert.equal(res.http_calls, 2);
  for (const l of ledger) {
    assert.equal(l.endpoint, 'enrich_profiles_bulk');
    assert.equal(l.result_count, 50, 'a per-result charge needs the count, or it is unaccountable');
  }
});

// ---------------------------------------------------------------------------
// the finding that shapes this task
// ---------------------------------------------------------------------------

test('rows without a URN fall back to single calls, and SAY WHY', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 60 }, (_, i) => noUrn(i)));
  const http = createFakeHttp({ fallback: okJson({ title: 'VP', company_name: 'Acme' }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api,
    verify: false, batch: true, confirm: async () => true,
  });

  // enrich_profiles_bulk takes `urns`; enrich_profile takes `url`. A profile URL is
  // not a URN and nothing in the API converts one, so batching cannot fire here.
  assert.equal(res.http_calls, 60, 'must not silently batch rows it cannot batch');
  assert.equal(res.exec.batched_calls, 0);
  assert.ok(http.calls.every(c => c.endpoint === 'enrich_profile'));

  // Silence here is the failure mode: 60 single calls with no explanation is how a
  // 50x latency penalty goes unnoticed.
  assert.ok(res.batch_notes.length > 0, 'a fallback to single calls must be explained');
  assert.match(res.batch_notes.join(' '), /urns/i);
  assert.match(res.batch_notes.join(' '), /60 of 60/);
});

test('an unaligned bulk response never gives one contact another row data', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 10 }, (_, i) => withUrn(i)));
  // 10 sent, 7 returned. Positional alignment is impossible.
  const http = createFakeHttp({
    fallback: () => okJson(Array.from({ length: 7 }, (_, i) => ({ urn: `x${i}`, title: 'WRONG' }))),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, api,
    verify: false, batch: true, confirm: async () => true, output: 'out.csv',
  });

  assert.equal(res.exec.unaligned_batches, 1);
  assert.equal(res.exec.ok, 0, 'an unattributable batch must not be reported as success');
  assert.equal(res.exec.failed, 10);

  const { lines } = readJournal(res.journal_path);
  assert.ok(lines.some(l => l.error === 'bulk_unaligned'));

  // The charge is still recorded: we did pay for the call.
  const ledger = fs.readFileSync(path.join(tree.root, 'gtm', 'api-calls.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.equal(ledger.length, 1, 'a paid call is recorded even when its result is unusable');

  // And no row picked up the wrong title.
  const out = fs.readFileSync(path.join(tree.root, 'out.csv'), 'utf8');
  assert.ok(!out.includes('WRONG'), 'unaligned results must never reach the output list');
});

test('a 402 mid-batch aborts and journals the rest as skipped_budget', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 200 }, (_, i) => withUrn(i)));
  let n = 0;
  const http = createFakeHttp({
    fallback: (call) => (n++ < 2
      ? okJson((call.body?.urns ?? []).map(u => ({ urn: u })))
      : insufficientCredits({ balance: '0', reserved: '50' })),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 5000, api,
    verify: false, batch: true, confirm: async () => true,
  });

  assert.ok(res.exec.aborted);
  assert.equal(res.exec.abort_reason, 'insufficient_credits');
  assert.equal(res.exec.ok, 100, 'the two batches that succeeded stay done');
  assert.equal(res.exec.skipped_budget, 50, 'the untouched final batch is replannable');
  assert.equal(res.exec.failed, 50, 'the batch that hit the 402 is the failed one');
  assert.equal(res.exec.ok + res.exec.failed + res.exec.skipped_budget, 200, 'every row accounted for');
});

test('a 429 retries the whole batch and charges it once', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 30 }, (_, i) => withUrn(i)));
  let n = 0;
  const http = createFakeHttp({
    fallback: (call) => (n++ < 1
      ? tooManyRequests({ retryAfter: 0 })
      : okJson((call.body?.urns ?? []).map(u => ({ urn: u })))),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, api,
    verify: false, batch: true, confirm: async () => true, sleep: async () => {},
  });

  assert.equal(res.exec.retries, 1);
  assert.equal(res.exec.ok, 30);
  const ledger = fs.readFileSync(path.join(tree.root, 'gtm', 'api-calls.jsonl'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  const charged = ledger.filter(l => (l.credits_actual ?? l.credits_estimated ?? 0) > 0);
  assert.equal(charged.length, 1, '2 HTTP attempts must charge the batch once');
});

// ---------------------------------------------------------------------------
// unit level
// ---------------------------------------------------------------------------

test('bulk eligibility is read from the catalog, never hard-coded', () => {
  const b = bulkVariantFor(CATALOG, 'enrich_profile');
  assert.equal(b.endpoint, 'enrich_profiles_bulk');
  assert.equal(b.maxBatch, CATALOG.endpoints.enrich_profile.max_batch);

  assert.equal(bulkVariantFor(CATALOG, 'email_finder'), null, 'email_finder has no bulk form');
  assert.equal(bulkVariantFor(CATALOG, 'phone_finder'), null);

  // A catalog that names a bulk variant which does not exist must fail SAFE to singles.
  const broken = { endpoints: { a: { bulk_variant: 'ghost', max_batch: 50 } } };
  assert.equal(bulkVariantFor(broken, 'a'), null);
  // max_batch of 1 or 0 is not a batch.
  const trivial = { endpoints: { a: { bulk_variant: 'b', max_batch: 1 }, b: {} } };
  assert.equal(bulkVariantFor(trivial, 'a'), null);
});

test('chunk and byHop', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 50), []);
  const hops = byHop([{ hop: 1 }, { hop: 0 }, { hop: 1 }, { hop: 0 }]);
  assert.deepEqual(hops.map(([h, u]) => [h, u.length]), [[0, 2], [1, 2]],
    'hops must run in order, or a waterfall reads a value before it is written');
});

test('the same credits either way, which is why a cost gate cannot catch this', () => {
  const single = CATALOG.endpoints.enrich_profile.pricing;
  const bulk = CATALOG.endpoints.enrich_profiles_bulk.pricing;
  assert.equal(single.credits_per_call, 1);
  assert.equal(bulk.credits_per_result, 1);
  // 500 rows: 500 x 1 credit/call === 10 calls x 50 results x 1 credit/result.
  assert.equal(500 * single.credits_per_call, 10 * 50 * bulk.credits_per_result);
});
