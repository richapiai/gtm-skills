// REGRESSION: the waterfall cache never hit after the first hop. 3,500 credits per rerun.
//
// THE BUG, in two lines that lived 200 apart.
//
//   _lib/enrich.mjs, toDescriptor — the READ:
//     for (const ep of [...four hops]) if (!cache.has(ep, record)) continue;
//
//   _lib/enrich.mjs, createExecClient.call — the WRITE:
//     if (cache?.enabled) cache.put(endpoint, merged(row_id), res.body);
//     // merged = { ...records.get(row_id), ...results.get(row_id) }
//
// The cache key IS the request payload (`_lib/cache.mjs`), so `email_finder`'s stored
// key carried `first_name`, `last_name`, `company_name` and the rest of hop 1's answer
// while its lookup key carried none of it. A different key is a permanent miss.
//
// MEASURED on an identical rerun of one contact: `enrich_profile` hit; `email_finder`
// (5cr) and `email_verifier` (2cr) re-paid. 7 of 8 credits per contact, so 3,500 of
// 4,000 on a 500-contact list — 12.5% cache effectiveness — and
// gates.yaml:quality_stops.max_waterfall_reruns permits two reruns, so up to 7,000.
//
// It also made `skills/enrich-waterfall/SKILL.md`'s "a repeat run costs close to
// nothing" false, and fired a `cache_ttl_unused` finding on every rerun with the wrong
// diagnosis: the TTLs were fine, the key was wrong.
//
// These tests are written to fail if the read reverts to the raw record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson, liveEnrichProfile, liveEmailFinder, liveEmailVerifier } from '../helpers/index.mjs';
import { CATALOG, GATES, fixture, apiOver, fakeHttp } from './helpers.mjs';
import { runEnrich, toDescriptor, loadCache } from '../../_lib/enrich.mjs';
import { createCache } from '../../_lib/cache.mjs';
import { buildRequest, mapResponse } from '../../_lib/client.mjs';
import { loadSuppressionStore } from '../../_lib/suppression.mjs';
import { cacheKey } from '../../_lib/cache.mjs';

// A row that carries ONLY a profile URL, which is the shape the waterfall exists for.
// Every later hop's request is then built out of hop 1's answer, which is exactly the
// condition the old read key could not reproduce.
const ROW = { linkedin_url: 'https://linkedin.com/in/ada' };

// The RECORDED shapes, from tests/helpers/responses.mjs. Hand-rolling these is what
// let the map read `body.email` for a week while the server answered `body.result.email`
// — the suite and the bug agreed with each other and both were wrong.
const PROFILE = liveEnrichProfile();
const FOUND = liveEmailFinder();
const VERIFIED = liveEmailVerifier();

function routes () {
  return [
    ['enrich_profile', () => okJson(PROFILE)],
    ['email_finder', () => okJson(FOUND)],
    ['email_verifier', () => okJson(VERIFIED)],
  ];
}

async function enrichOnce (tree, input, label) {
  const fake = fakeHttp({ routes: routes() });
  const res = await runEnrich({
    input, root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 1000, confirm: async () => true, runId: `f3-${label}`,
  });
  return { res, endpoints: fake.calls.map((c) => c.endpoint) };
}

test('an identical rerun of the waterfall makes ZERO calls and spends ZERO credits', async (t) => {
  const { tree, input } = fixture(t, { rows: [ROW] });

  const first = await enrichOnce(tree, input, 'a');
  assert.deepEqual(first.endpoints, ['enrich_profile', 'email_finder', 'email_verifier'],
    'the first run must buy all three hops');
  assert.equal(first.res.cache.writes, 3, 'every hop writes through');
  assert.equal(first.res.cache.hits, 0);

  const second = await enrichOnce(tree, input, 'b');

  // The load-bearing assertion. Before the fix this was ['email_finder','email_verifier']:
  // two of three hops re-bought on an identical rerun.
  assert.deepEqual(second.endpoints, [],
    'an identical rerun must issue no HTTP call at all — a later hop that re-pays means '
    + 'the plan-time read key is no longer built the way the executor built the write key');
  assert.equal(second.res.http_calls, 0);
  assert.equal(second.res.cache.hits, 3, 'all three hops must hit, not just the first');
  assert.equal(second.res.cache.writes, 0);
  assert.equal(second.res.plan.totals.skipped_cache, 3);
  assert.equal(second.res.ledger_totals.ledger_total, 0,
    'zero calls is zero credits; anything else is the rerun re-paying');
});

test('the measured shape: 7 of every 8 credits used to be re-paid', async (t) => {
  // Pins the arithmetic in the finding, from the catalog rather than from prose, so a
  // repricing moves the number here instead of silently invalidating the report.
  const price = (ep) => {
    const p = CATALOG.endpoints[ep].pricing;
    return p.credits_per_call ?? p.credits_base ?? 0;
  };
  const profile = price('enrich_profile');
  const finder = price('email_finder');
  const verifier = price('email_verifier');
  const perContact = profile + finder + verifier;
  assert.equal(perContact, 8, 'the waterfall is 8 credits a contact in the pinned catalog');
  assert.equal(finder + verifier, 7, 'the two hops that used to re-pay are 7 of those 8');
  assert.equal((finder + verifier) * 500, 3500, '3,500 of 4,000 credits on a 500-contact list');

  // And the fix delivers the other 7: a rerun costs nothing.
  const { tree, input } = fixture(t, { rows: [ROW] });
  await enrichOnce(tree, input, 'c');
  const second = await enrichOnce(tree, input, 'd');
  assert.equal(second.res.ledger_totals.ledger_total, 0);
});

test('the plan-time read key is byte-for-byte the executor\'s write key', async (t) => {
  // The direct statement of the invariant, independent of any run. It reproduces the
  // executor's fold by hand and asserts the cache was populated under exactly those
  // keys — so a read that walks the hops out of order, or against the raw record,
  // fails here even if some future plumbing hides it end to end.
  const { tree, input } = fixture(t, { rows: [ROW] });
  await enrichOnce(tree, input, 'e');

  let record = { ...ROW };
  for (const [ep, body] of [
    ['enrich_profile', PROFILE], ['email_finder', FOUND], ['email_verifier', VERIFIED],
  ]) {
    const req = buildRequest(ep, record);
    assert.equal(req.ok, true, `${ep} must be callable from the folded record`);
    const file = path.join(tree.root, 'gtm', 'enrichment-cache', `${ep}.jsonl`);
    const keys = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).key);
    assert.ok(keys.includes(cacheKey(req.payload)),
      `${ep} was written under a key the folded record does not reproduce — `
      + `the read and the write disagree again. Written: ${keys.join(', ')}`);
    record = { ...record, ...mapResponse(ep, body) };
  }
});

test('the fold STOPS at the first miss, because a later key is then unknowable', (t) => {
  // The other half of correctness. If hop 1 is not cached we cannot know what hop 2's
  // request will look like, so claiming a hit for it would mark a hop skipped-not-
  // charged on the strength of a key we never checked.
  const { tree } = fixture(t);
  const store = loadSuppressionStore({ root: tree.root, path: path.join(tree.root, 'gtm', 'suppression.jsonl') });
  const cache = createCache({ root: tree.root, dir: 'gtm' });

  // Seed ONLY email_finder, under the key the executor would have written after hop 1.
  const afterProfile = { ...ROW, ...mapResponse('enrich_profile', PROFILE) };
  cache.put('email_finder', afterProfile, FOUND);

  const { descriptor } = toDescriptor(ROW, 0, { store, cache });
  assert.deepEqual(descriptor.cached, [],
    'enrich_profile is a miss, so email_finder\'s key cannot be predicted and must not '
    + 'be claimed as cached — that would skip a hop nobody proved was bought');
});

test('a cached waterfall still produces the enriched output columns', async (t) => {
  // The failure mode a naive "just skip the hop" fix would introduce: free, and empty.
  const { tree, input } = fixture(t, { rows: [ROW] });
  await enrichOnce(tree, input, 'f');

  const fake = fakeHttp({ routes: routes() });
  const res = await runEnrich({
    input, root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 1000, confirm: async () => true, runId: 'f3-g',
    output: 'out.jsonl',
  });
  assert.equal(res.http_calls, 0);
  const written = fs.readFileSync(path.join(tree.root, 'out.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(written.length, 1);
  assert.equal(written[0].email, 'ada@acme.example',
    'a rerun served from cache must still deliver the email the first run paid for');
  assert.equal(written[0].title, 'VP Sales');
});

test('--no-cache still re-pays, because that is what it is for', async (t) => {
  const { tree, input } = fixture(t, { rows: [ROW] });
  await enrichOnce(tree, input, 'h');

  const fake = fakeHttp({ routes: routes() });
  const res = await runEnrich({
    input, root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 1000, confirm: async () => true, runId: 'f3-i', noCache: true,
  });
  assert.equal(res.http_calls, 3, '--no-cache must not be quietly improved into a cache hit');
  assert.equal(res.cache.enabled, false);
});

test('loadCache({enabled:false}) is still a cache that always misses', () => {
  const c = loadCache({ enabled: false });
  assert.equal(c.enabled, false);
  assert.equal(c.has('enrich_profile', ROW), false);
});
