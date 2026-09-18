// Live run 2026-09-17: `richapi call` on an endpoint with no RESPONSE_MAPS entry billed
// the call and wrote only the input columns (CSV) or `{}` (JSONL). The paid body never
// reached the user. These replay the recorded bodies through the real runtime over a
// fake transport and fail against that code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson } from '../helpers/index.mjs';
import { CATALOG, REPO, fixture, apiOver, fakeHttp, readJsonl } from './helpers.mjs';
import { runCall } from '../../_lib/run.mjs';
import { RESPONSE_MAPS } from '../../_lib/client.mjs';
import { parseCsv } from '../../_lib/csv.mjs';
import { readPiiJsonl } from '../../_lib/pii.mjs';

const live = (name) => JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'fixtures', 'live', `${name}.json`), 'utf8')).body;

// endpoint -> how the recorded call is driven: an input CSV row, or one param set.
const CASES = {
  website_intelligence: { rows: [{ domain: 'richapi.ai', url: 'https://richapi.ai' }] },
  web_scrape: { rows: [{ url: 'https://richapi.ai' }] },
  profile_social_metrics: { params: { url: 'https://www.linkedin.com/in/williamhgates/' } },
  crunchbase_company_scraper_sync: { params: { crunchbase_company_url: 'https://www.crunchbase.com/organization/microsoft' } },
  google_maps_places_scraper_keyword: { params: { search_query: 'coffee', limit: 5 } },
};

async function call (t, endpoint, { output, suppress = [], root = null, api = null } = {}) {
  const c = CASES[endpoint];
  const fx = root ? { tree: { root }, input: c.rows ? 'in.csv' : null } : fixture(t, { rows: c.rows ?? null, suppress, name: 'in.csv' });
  const fake = fakeHttp({ fallback: () => okJson(live(endpoint)) });
  const res = await runCall({
    endpoint, ...(c.rows ? { input: fx.input } : { params: c.params }), output,
    root: fx.tree.root, catalog: CATALOG, budget: 100, api: api ?? apiOver(fake), confirm: async () => true,
  });
  return { res, fake, root: fx.tree.root };
}

// Which of these endpoints STILL has no response map is `client.mjs`'s business, and it
// shrinks as maps are recorded. A case that has since gained one no longer exercises the
// no-map path, so it is skipped rather than failed — but the file asserts that at least
// one case is left, or it would quietly stop testing anything.
const UNMAPPED = Object.keys(CASES).filter((e) => !Object.hasOwn(RESPONSE_MAPS, e));

test('there is still an endpoint with no response map to test the raw-delivery path with', () => {
  assert.ok(UNMAPPED.length > 0,
    'every CASES endpoint now has a map — add an unmapped one, or this file tests nothing');
});

for (const endpoint of UNMAPPED) {
  test(`${endpoint}: no map, and the paid body reaches JSONL and CSV`, async (t) => {

    const j = await call(t, endpoint, { output: 'out.jsonl' });
    assert.equal(j.fake.callCount, 1);
    const [row] = readJsonl(path.join(j.root, 'out.jsonl'));
    assert.deepEqual(row.response, live(endpoint), 'the full recorded body, not {}');
    assert.equal(row.response_mapped, false);
    for (const [k, v] of Object.entries(CASES[endpoint].rows?.[0] ?? {})) assert.equal(row[k], v, 'input columns kept');
    assert.equal(j.res.unmapped_rows, 1);
    assert.equal(j.res.output.unmapped_rows, 1);
    assert.match(j.res.mapping.by_endpoint[endpoint].first_reason, /delivered raw/);

    const c = await call(t, endpoint, { output: 'out.csv' });
    const [crow] = parseCsv(fs.readFileSync(path.join(c.root, 'out.csv'), 'utf8'));
    assert.deepEqual(JSON.parse(crow.response_json), live(endpoint));
    assert.equal(crow.response_mapped, 'false');
  });
}

test('a suppressed address inside an unmapped body drops the row (JSONL and CSV)', async (t) => {
  assert.match(JSON.stringify(live('website_intelligence')), /redacted@example\.invalid/,
    'the recording carries the address this test suppresses');
  for (const output of ['out.jsonl', 'out.csv']) {
    const { res, root } = await call(t, 'website_intelligence', { output, suppress: ['redacted@example.invalid'] });
    assert.equal(res.output.written, 0);
    assert.equal(res.output.suppressed, 1);
    assert.equal(res.unmapped_rows, 0);   // nothing is written at all
    assert.doesNotMatch(fs.readFileSync(path.join(root, output), 'utf8'), /redacted@example/);
  }
});

test('the persisted body is PII-stamped, and a cache hit writes the same output with no call', async (t) => {
  const first = await call(t, 'website_intelligence', { output: 'a.jsonl' });
  const { rows } = readPiiJsonl(path.join(first.root, 'gtm', 'runs', `${first.res.run_id}.results.jsonl`));
  assert.deepEqual(rows[0].fields.response, live('website_intelligence'), 'strict read: provenance present');

  const second = await call(t, 'website_intelligence', { output: 'b.jsonl', root: first.root, api: apiOver(fakeHttp({ throwOnCall: 'a cache hit must not call' })) });
  assert.equal(second.res.calls_made, 0);
  assert.equal(second.res.cache.hits, 1);
  assert.deepEqual(readJsonl(path.join(first.root, 'b.jsonl')), readJsonl(path.join(first.root, 'a.jsonl')));
  // Only when website_intelligence is still unmapped; the point of THIS test is the
  // provenance stamp and the cache hit, not the mapping.
  assert.equal(second.res.unmapped_rows, Object.hasOwn(RESPONSE_MAPS, 'website_intelligence') ? 0 : 1);
});
