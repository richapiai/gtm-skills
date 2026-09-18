// The read-through cache.
//
// Verify: a second identical run spends ~0 credits, and hits show in the dry-run plan.
//
// The cache is PII. Every test here also checks it stays inside the rules that makes
// it legal to keep: provenance on every row, TTL enforced at read time, erasable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp, okJson } from '../helpers/index.mjs';
import { runEnrich, loadCatalog } from '../../_lib/enrich.mjs';
import { RichApiClient } from '../../_lib/client.mjs';
import { createCache, cacheKey, cacheFile } from '../../_lib/cache.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';
import { readPiiJsonl, erase, sweepEnrichmentCache, assertPiiProvenance } from '../../_lib/pii.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

function fixture (t, rows) {
  const tree = makeGtmTree({ prefix: 't15-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const header = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const csv = [header.join(','), ...rows.map(r => header.map(h => r[h] ?? '').join(','))].join('\n') + '\n';
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, csv);
  return { tree, input };
}

const person = (i) => ({
  first_name: `First${i}`, last_name: `Last${i}`,
  linkedin_url: `https://linkedin.com/in/p${i}`,
  email: `p${i}@acme.example`,
});

const runOnce = (tree, input, api, extra = {}) => runEnrich({
  input, root: tree.root, catalog: CATALOG, budget: 5000, api,
  verify: false, confirm: async () => true, ...extra,
});

// ---------------------------------------------------------------------------

test('a second identical run spends ~0 credits', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 20 }, (_, i) => person(i)));

  const http1 = createFakeHttp({ fallback: okJson({ title: 'VP', company_name: 'Acme' }) });
  const api1 = new RichApiClient({ apiKey: 'k', fetchImpl: http1.fetch });
  const first = await runOnce(tree, input, api1);

  assert.equal(first.http_calls, 20, 'the first run must actually pay');
  assert.ok(first.ledger_totals.ledger_total > 0);
  assert.equal(first.cache.writes, 20, 'every successful call must be written through');

  // Second run, same list, a client that would throw if it were used at all.
  const http2 = createFakeHttp({ throwOnCall: true });
  const api2 = new RichApiClient({ apiKey: 'k', fetchImpl: http2.fetch });
  const second = await runOnce(tree, input, api2);

  assert.equal(second.http_calls, 0, `the second run made ${second.http_calls} calls; it must make none`);
  assert.equal(second.exec.skipped_cache, 20);
  assert.equal(second.ledger_totals.ledger_total, 0, 'a fully cached run costs nothing');
});

test('cache hits appear in the DRY-RUN plan as skipped-not-charged', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 10 }, (_, i) => person(i)));

  const http = createFakeHttp({ fallback: okJson({ title: 'VP' }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });
  await runOnce(tree, input, api);

  // A plan built afterwards must SHOW the hits, so the user approves a real number.
  const plan = await runEnrich({
    input, root: tree.root, catalog: CATALOG, dryRun: true, verify: false,
    api: new Proxy({}, { get () { throw new Error('dry run touched the client'); } }),
  });

  assert.equal(plan.plan.totals.skipped_cache, 10);
  assert.equal(plan.plan.totals.calls_planned, 0, 'nothing left to buy');
  assert.equal(plan.plan.totals.credits_estimated, 0);
  assert.match(plan.text, /cache/i);
});

test('--no-cache bypasses it entirely', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 5 }, (_, i) => person(i)));
  const http = createFakeHttp({ fallback: okJson({ title: 'VP' }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });
  await runOnce(tree, input, api);

  const http2 = createFakeHttp({ fallback: okJson({ title: 'VP' }) });
  const api2 = new RichApiClient({ apiKey: 'k', fetchImpl: http2.fetch });
  const again = await runOnce(tree, input, api2, { noCache: true });

  assert.equal(again.http_calls, 5, '--no-cache must re-pay, that is the point of it');
  assert.equal(again.cache.enabled, false);
});

// ---------------------------------------------------------------------------
// the rules that make keeping this data legal
// ---------------------------------------------------------------------------

test('every cached row carries PII provenance, so erase and sweep can find it', async (t) => {
  const { tree, input } = fixture(t, [person(1)]);
  const http = createFakeHttp({ fallback: okJson({ title: 'VP', email: 'p1@acme.example' }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });
  await runOnce(tree, input, api);

  const file = cacheFile(tree.root, 'gtm', 'enrich_profile');
  const { rows, unprovenanced } = readPiiJsonl(file, { strict: false });
  assert.ok(rows.length > 0);
  assert.equal(unprovenanced.length, 0, 'an unattributed cache row must never be written');
  for (const r of rows) {
    assertPiiProvenance(r, 'cache row');       // throws if provenance is missing
    assert.equal(r.source_endpoint, 'enrich_profile');
  }

  // `/comply erase` (_lib/pii.mjs) reaches into the cache.
  const res = erase('p1@acme.example', { root: tree.root });
  assert.ok(res.files_changed > 0 || res.rows_removed > 0, `erase did not touch the cache: ${JSON.stringify(res).slice(0, 200)}`);
  const after = fs.readFileSync(file, 'utf8');
  assert.ok(!after.includes('p1@acme.example'), 'erase must purge the cached copy too');
});

test('TTL is enforced at READ time, not only by the sweep', async (t) => {
  const tree = makeGtmTree({ prefix: 't15-ttl-' });
  t.after(() => tree.cleanup());
  const cache = createCache({ root: tree.root, dir: 'gtm' });
  const rec = { linkedin_url: 'https://linkedin.com/in/x' };

  cache.put('enrich_profile', rec, { title: 'VP' });
  assert.equal(cache.has('enrich_profile', rec), true);

  // Same row, stamped 200 days ago. enrich_profile sits in the 90d class.
  const file = cacheFile(tree.root, 'gtm', 'enrich_profile');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  fs.writeFileSync(file, rows.map(r => JSON.stringify({ ...r, fetched_at: old })).join('\n') + '\n');

  const stale = createCache({ root: tree.root, dir: 'gtm' });
  assert.equal(stale.has('enrich_profile', rec), false, 'an expired row must read as a miss');
  assert.equal(stale.get('enrich_profile', rec), null);
});

test('ai_enrich is never cached, because its output is non-deterministic', (t) => {
  const tree = makeGtmTree({ prefix: 't15-ai-' });
  t.after(() => tree.cleanup());
  const cache = createCache({ root: tree.root, dir: 'gtm' });
  assert.equal(cache.ttlMs('ai_enrich'), 0, 'gates.yaml pins ai_enrich to 0d');
  assert.equal(cache.put('ai_enrich', { email: 'a@b.example' }, { answer: 'x' }), null);
  assert.equal(cache.has('ai_enrich', { email: 'a@b.example' }), false);
  assert.equal(fs.existsSync(cacheFile(tree.root, 'gtm', 'ai_enrich')), false);
});

test('a corrupt cache degrades to a MISS, never a wedge and never bad data', (t) => {
  const tree = makeGtmTree({ prefix: 't15-corrupt-' });
  t.after(() => tree.cleanup());
  const file = cacheFile(tree.root, 'gtm', 'enrich_profile');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{"not json\n{"key":"k","response":{}}\n'); // truncated + unprovenanced

  const cache = createCache({ root: tree.root, dir: 'gtm' });
  assert.equal(cache.has('enrich_profile', { linkedin_url: 'https://x' }), false);
  // A miss costs credits. Serving an unprovenanced row would be the worse failure.
  assert.doesNotThrow(() => cache.get('enrich_profile', { linkedin_url: 'https://x' }));
});

test('the key IS the request, so a different question is a different entry', () => {
  assert.equal(cacheKey({ a: 1, b: 2 }), cacheKey({ b: 2, a: 1 }), 'key order is not a new question');
  assert.notEqual(cacheKey({ url: 'https://a' }), cacheKey({ url: 'https://b' }));
  assert.notEqual(cacheKey({ url: 'https://a' }), cacheKey({ url: 'https://a', extra: 1 }));
  assert.match(cacheKey({ url: 'https://a' }), /^[a-f0-9]{32}$/);
  // The key carries no contact data.
  assert.ok(!cacheKey({ email: 'ada@example.com' }).includes('ada'));
});

test('the TTL sweep and the cache agree on what is expired', async (t) => {
  const tree = makeGtmTree({ prefix: 't15-sweep-' });
  t.after(() => tree.cleanup());
  const cache = createCache({ root: tree.root, dir: 'gtm' });
  cache.put('enrich_profile', { linkedin_url: 'https://a' }, { title: 'A' });

  const file = cacheFile(tree.root, 'gtm', 'enrich_profile');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const old = new Date(Date.now() - 200 * 86400000).toISOString();
  fs.writeFileSync(file, rows.map(r => JSON.stringify({ ...r, fetched_at: old })).join('\n') + '\n');

  const report = sweepEnrichmentCache({ root: tree.root });
  assert.equal(report.rows_expired, 1, 'the sweep must drop what the cache already treats as a miss');
  assert.equal(report.rows_kept, 0);
});

// ---------------------------------------------------------------------------
// A response the API did not bill is a "retry later", never a cached answer.
//
// Live 2026-09-17 (post-call-follow-up rerun): email_finder answered HTTP 200 with
// {ok:false, result:null, billed:false, why:"2/5 providers returned an error — retry
// later"}. That body went into gtm/enrichment-cache/email_finder.jsonl, and the next
// dry run served it as `skipped_cache` — so a transient provider outage became a
// permanent hole in the list, and the run then planned PAID email_verifier calls
// against rows that carry no email.
// ---------------------------------------------------------------------------

const PROVIDER_ERROR = Object.freeze({
  ok: false, result: null, billed: false,
  why: '2/5 providers returned an error — retry later',
});

test('a NOT-BILLED provider error is never written to the cache, so the row can be retried', (t) => {
  const tree = makeGtmTree({ prefix: 't15-unbilled-' });
  t.after(() => tree.cleanup());
  const cache = createCache({ root: tree.root, dir: 'gtm' });
  const rec = { first_name: 'Ada', last_name: 'L', company_domain: 'acme.example' };

  assert.equal(cache.put('email_finder', rec, PROVIDER_ERROR), null,
    'a body that says billed:false must not be stored');
  assert.equal(cache.stats.not_billed, 1);
  assert.equal(fs.existsSync(cacheFile(tree.root, 'gtm', 'email_finder')), false);

  // The whole point: the next run plans a real, paid retry rather than a cache skip.
  assert.equal(cache.has('email_finder', rec), false, 'a retry must be planned, not skipped_cache');
  assert.equal(cache.get('email_finder', rec), null);

  // A genuine not-found on the same endpoint still caches — it WAS billed.
  assert.notEqual(cache.put('email_finder', rec, { success: true, result: { email: null } }), null);
  assert.equal(cache.has('email_finder', rec), true);
});

test('a cache already POISONED by a provider error reads as a miss, not a hit', (t) => {
  const tree = makeGtmTree({ prefix: 't15-poisoned-' });
  t.after(() => tree.cleanup());
  const rec = { first_name: 'Ada', last_name: 'L', company_domain: 'acme.example' };

  // Reproduce the row the old code left on disk: store a billed body so the real
  // request-derived key and PII provenance are correct, then rewrite the response
  // in place to the provider error.
  const cache = createCache({ root: tree.root, dir: 'gtm' });
  cache.put('email_finder', rec, { success: true, result: { email: 'x@y.example' } });
  const file = cacheFile(tree.root, 'gtm', 'email_finder');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  fs.writeFileSync(file, rows.map(r => JSON.stringify({ ...r, response: PROVIDER_ERROR })).join('\n') + '\n');

  const fresh = createCache({ root: tree.root, dir: 'gtm' });
  assert.equal(fresh.has('email_finder', rec), false,
    'a cache poisoned by an earlier version must still expire the unbilled row');
  assert.equal(fresh.get('email_finder', rec), null);
  assert.equal(fresh.stats.not_billed, 1);
});
