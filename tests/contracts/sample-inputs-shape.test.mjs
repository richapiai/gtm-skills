// Every capture sample-input must satisfy the catalog's own contract for that
// endpoint — BEFORE a capture run spends a credit proving otherwise.
//
// This file exists because six entries in sample-inputs.json were wrong at once
// and nothing caught them until a live run had already been paid for:
//
//   enrich_profile   sent `linkedin_url`; the API accepts only `url`.  400.
//   enrich_company   same.                                              400.
//   distribute_leads absent, so the harness synthesised a non-string.   400.
//   google_ad_transparency_scraper_sync   missing required `limit`.
//   google_maps_places_scraper_sync_using_url    "        "
//   google_maps_reviews_scraper_sync             "        "
//
// The last three are the expensive class. `limit` is not decoration on a
// per-result endpoint — it is the field that BOUNDS THE COST. An entry missing
// it is an unbounded charge waiting for someone to pass --run, and the only
// reason it did not happen is that the 2026-08-31 capture ran out of credits
// before reaching them.
//
// Law 1 is usually quoted about credit prices, but it is the same rule: a value
// hand-typed into a file that sits outside the layer which knows the truth goes
// stale, and the catalog is what knows the truth here. `_lib/client.mjs`
// RECORD_MAPPINGS already maps row column names to wire field names; a fixture
// that bypasses that mapping re-opens the exact divergence documented at
// client.mjs:355 as having "cost a full 500-row run".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SAMPLES = path.join(ROOT, 'tests/fixtures/live/sample-inputs.json');
const CATALOG = path.join(ROOT, '_lib/api-catalog.json');

const rawSamples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));
const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));

// The file documents itself inline: keys prefixed `_` are prose (`_readme`,
// `_comment_urls`), not endpoints. Skip them everywhere rather than teaching each
// test about them separately.
const samples = {
  ...rawSamples,
  inputs: Object.fromEntries(
    Object.entries(rawSamples.inputs).filter(([k]) => !k.startsWith('_')),
  ),
};

/** A per-result endpoint bills per row returned, so its bound is its limit field. */
const isPerResult = (ep) => ep?.pricing?.model === 'per_result'
  || ep?.pricing?.model === 'base_plus_per_result';

/** The limit-style field a per-result endpoint uses to cap what it returns. */
const LIMIT_FIELDS = ['limit', 'max_pages', 'max_results', 'count', 'page_size'];

test('every sample-input names an endpoint the catalog actually has', () => {
  for (const name of Object.keys(samples.inputs)) {
    assert.ok(
      catalog.endpoints[name],
      `sample-inputs.json has an entry for "${name}", which is not in the catalog. `
      + 'Either the endpoint was removed from the spec and this entry is dead, or the '
      + 'name is a typo — both mean a capture run would skip it silently.',
    );
  }
});

test('every sample-input carries the endpoint\'s required_request_fields', () => {
  const failures = [];
  for (const [name, body] of Object.entries(samples.inputs)) {
    if (body === null) continue; // declared uncapturable, on purpose
    const required = catalog.endpoints[name]?.required_request_fields ?? [];
    const missing = required.filter((f) => !(f in body));
    if (missing.length) failures.push(`${name}: missing ${missing.join(', ')}`);
  }
  assert.deepEqual(
    failures, [],
    'sample-inputs.json entries do not satisfy the catalog\'s required fields.\n'
    + failures.map((f) => '  ' + f).join('\n')
    + '\n\nEach of these 400s on a live capture. Fix the entry, not the catalog: '
    + 'the catalog is generated from the pinned spec (law 1).',
  );
});

test('a per-result sample-input bounds its own cost with a limit field', () => {
  const unbounded = [];
  for (const [name, body] of Object.entries(samples.inputs)) {
    if (body === null) continue;
    const ep = catalog.endpoints[name];
    if (!isPerResult(ep)) continue;
    const accepted = ep.required_request_fields ?? [];
    // Only demand a limit where the endpoint actually takes one.
    const known = LIMIT_FIELDS.filter((f) => accepted.includes(f));
    if (!known.length) continue;
    if (!known.some((f) => f in body)) {
      unbounded.push(`${name}: per_result but no ${known.join('/')} in the sample body`);
    }
  }
  assert.deepEqual(
    unbounded, [],
    'A per-result endpoint with no limit in its capture body is an UNBOUNDED CHARGE.\n'
    + unbounded.map((u) => '  ' + u).join('\n')
    + '\n\nSet the limit to 1: the capture plan costs at one result per endpoint, so '
    + 'the request must ask for one result or the plan understates the bill.',
  );
});

test('no sample-input sends a field the runtime would have mapped for it', async () => {
  // RECORD_MAPPINGS is the runtime's column-name -> wire-field-name layer. A sample
  // input written in the *column* dialect bypasses it and hits the API with a name
  // the API does not accept. That is precisely how enrich_profile broke.
  const { RECORD_MAPPINGS } = await import(path.join(ROOT, '_lib/client.mjs'));
  const offenders = [];
  for (const [name, body] of Object.entries(samples.inputs)) {
    if (body === null || !RECORD_MAPPINGS[name]) continue;
    const wireFields = Object.keys(RECORD_MAPPINGS[name]({}));
    const required = catalog.endpoints[name]?.required_request_fields ?? [];
    for (const wire of wireFields) {
      if (!required.includes(wire)) continue;
      if (!(wire in body)) {
        offenders.push(
          `${name}: requires "${wire}" but the sample sends ${JSON.stringify(Object.keys(body))} `
          + '— looks like a row-column name that RECORD_MAPPINGS would have translated',
        );
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'A capture sample is written in the row-column dialect, not the wire dialect.\n'
    + offenders.map((o) => '  ' + o).join('\n')
    + '\n\nSee _lib/client.mjs:355 — this divergence has already cost one 500-row run.',
  );
});

test('every sample-input value is public, non-personal data', () => {
  // The file is committed AND its values go to a live third-party API. A real
  // prospect in here is a privacy incident with a git history.
  const json = JSON.stringify(samples.inputs);
  const suspicious = [
    // free-mail addresses are the tell for a real person's contact details
    /@(gmail|yahoo|hotmail|outlook|proton(mail)?|icloud)\.[a-z]+/i,
  ];
  for (const re of suspicious) {
    assert.ok(
      !re.test(json),
      `sample-inputs.json contains what looks like a personal address (${re}). `
      + 'Every value here is sent to a live API and committed to git — use a public '
      + 'company or an example.com placeholder.',
    );
  }
});
