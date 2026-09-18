// richapi-catalog-gen.
// Verify criterion: regenerating from the same fixture spec twice is byte-identical.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DISABLED_BY_DEFAULT,
  buildCatalog,
  parseChecksumFile,
  run,
  serialize,
  sha256,
} from '../../_lib/catalog/generate.mjs';
import YAML from 'yaml';

import {
  FIELD_MAP_STATUS_KEYS_FROM_SPEC,
  billingFieldPresentInRecording,
  isBillingFieldPath,
  extractEndpoints,
  maxBatchFromText,
  parsePricing,
  responseExampleKeys,
  singleFormOf,
} from '../../_lib/catalog/extract.mjs';
import { validate } from './mini-schema-validator.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const MINI = path.join(FIXTURES, 'mini-spec.yaml');
const MINI_SHA = path.join(FIXTURES, 'mini-spec.yaml.sha256');
const REAL_SPEC = path.join(ROOT, 'spec', 'openapi.yaml');
const REAL_CATALOG = path.join(ROOT, '_lib', 'api-catalog.json');
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'contracts', 'api-catalog.schema.json'), 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-'));
}

// --- the verify criterion -------------------------------------------------------

test('regenerating from the same fixture spec twice is byte-identical', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  const first = await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out });
  assert.equal(first.code, 0);
  assert.equal(first.wrote, true);
  const bytes1 = fs.readFileSync(out);

  const second = await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out });
  assert.equal(second.code, 0);
  assert.equal(second.wrote, false, 'a no-op regeneration must not rewrite the file');
  const bytes2 = fs.readFileSync(out);

  assert.deepEqual(bytes1, bytes2, 'two runs over an unchanged spec differ byte-for-byte');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('determinism survives an intervening clock change (generated_at is stabilized)', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out, generatedAt: '2020-01-01T00:00:00.000Z' });
  const a = fs.readFileSync(out, 'utf8');
  await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out, generatedAt: '2031-06-06T06:06:06.000Z' });
  const b = fs.readFileSync(out, 'utf8');
  assert.equal(a, b);
  // ...but a real content change does re-stamp it.
  const changed = buildCatalog(fs.readFileSync(MINI), { generatedAt: '2031-06-06T06:06:06.000Z' }).catalog;
  changed.endpoints.email_finder.pricing.credits_per_call = 6;
  fs.writeFileSync(out, serialize(changed));
  const third = await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out, generatedAt: '2032-01-01T00:00:00.000Z' });
  assert.equal(third.catalog.generated_at, '2032-01-01T00:00:00.000Z');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- contract conformance -------------------------------------------------------

test('the generated catalog conforms to the frozen api-catalog schema', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const errors = validate(SCHEMA, catalog);
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('the fixture catalog conforms too', () => {
  const { catalog } = buildCatalog(fs.readFileSync(MINI), { generatedAt: '2026-01-01T00:00:00.000Z' });
  const errors = validate(SCHEMA, catalog);
  assert.deepEqual(errors, [], errors.join('\n'));
});

// --- integrity ------------------------------------------------------------------

test('a spec whose sha does not match the pin fails, and the cache is left intact', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out });
  const cached = fs.readFileSync(out, 'utf8');

  const tampered = path.join(dir, 'tampered.yaml');
  fs.writeFileSync(tampered, `${fs.readFileSync(MINI, 'utf8')}\n# an unannounced upstream edit\n`);
  const res = await run({ specFile: tampered, checksumFile: MINI_SHA, outFile: out });

  assert.equal(res.code, 1);
  assert.match(res.errors.join(' '), /sha256 mismatch/);
  assert.equal(fs.readFileSync(out, 'utf8'), cached, 'a mismatch must not clobber the cached catalog');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('--allow-sha-mismatch downgrades the mismatch to a warning', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  const tampered = path.join(dir, 'tampered.yaml');
  fs.writeFileSync(tampered, `${fs.readFileSync(MINI, 'utf8')}\n# edited\n`);
  const res = await run({ specFile: tampered, checksumFile: MINI_SHA, outFile: out, allowShaMismatch: true });
  assert.equal(res.code, 0);
  assert.match(res.warnings.join(' '), /sha256 mismatch/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the pinned spec still matches its checksum file', () => {
  const expected = parseChecksumFile(fs.readFileSync(`${REAL_SPEC}.sha256`, 'utf8'));
  assert.equal(sha256(fs.readFileSync(REAL_SPEC)), expected);
});

// --- never wedge ----------------------------------------------------------------

test('an unreachable spec URL falls back to the pinned file rather than failing', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  const res = await run({
    specFile: MINI,
    checksumFile: MINI_SHA,
    outFile: out,
    specUrl: 'https://spec.invalid/openapi.yaml',
    fetchImpl: async () => {
      throw new Error('ENOTFOUND');
    },
  });
  assert.equal(res.code, 0);
  assert.match(res.warnings.join(' '), /spec fetch failed/);
  assert.equal(Object.keys(res.catalog.endpoints).length, 7);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline with no spec at all keeps the cached catalog and exits 0', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  await run({ specFile: MINI, checksumFile: MINI_SHA, outFile: out });
  const cached = fs.readFileSync(out, 'utf8');

  const res = await run({ specFile: path.join(dir, 'does-not-exist.yaml'), checksumFile: null, outFile: out });
  assert.equal(res.code, 0, 'offline must never wedge the pack');
  assert.equal(res.wrote, false);
  assert.match(res.warnings.join(' '), /keeping cached catalog/);
  assert.equal(fs.readFileSync(out, 'utf8'), cached);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('offline with no spec AND no cache is the one hard failure', async () => {
  const dir = tmpdir();
  const res = await run({
    specFile: path.join(dir, 'nope.yaml'),
    checksumFile: null,
    outFile: path.join(dir, 'api-catalog.json'),
  });
  assert.equal(res.code, 1);
  assert.match(res.errors.join(' '), /no spec and no cached catalog/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- extraction rules -----------------------------------------------------------

// REWRITTEN 2026-08-30. What this test used to assert was measurably false.
//
// It required `field_map_status: TODO_no_usable_example` on all 68 rows — i.e. "no
// usable example" — while 65 of them declared a 200 example with a non-empty object.
// The status claimed nothing was there. Something was: the KEY NAMES.
//
// Law 2 still holds and is still asserted below. It is a law about VALUES: the values
// are the literal string "example" on 39 of 68 rows, so no `field_map` may be derived
// from them and `field_map` stays null on every row until a live fixture is recorded for it.
// The keys are a different claim, independently corroborated against the server's own
// generated manifest, and they are now published as `field_map_keys` — an ARRAY, so it
// can never be read as a map.
test('field_map is null on EVERY endpoint - never derived from a spec example (law 2)', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const eps = Object.values(catalog.endpoints);
  assert.equal(eps.length, 68);
  for (const e of eps) {
    assert.equal(e.field_map, null, `${e.name} has a field_map derived from the spec`);
  }
});

test('all 68 endpoints publish top-level KEY NAMES (65 from the spec example, 3 only from a recording)', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const eps = Object.values(catalog.endpoints);
  const withKeys = eps.filter((e) => Array.isArray(e.field_map_keys) && e.field_map_keys.length > 0);

  // The regression this is written to catch: every row going back to `field_map_keys:
  // null`, which is the old "no usable example" lie restated in a new field.
  // UPDATED 2026-09-17: the three rows the spec leaves blank now have recordings.
  assert.equal(withKeys.length, 68, 'every row carries keys once the recordings are absorbed');
  const specOnly = buildCatalog(fs.readFileSync(REAL_SPEC), { generatedAt: 'x' }).catalog;
  const specWithKeys = Object.values(specOnly.endpoints)
    .filter((e) => Array.isArray(e.field_map_keys) && e.field_map_keys.length > 0);
  assert.equal(specWithKeys.length, 65, 'the pinned spec declares 65 non-empty 200 example objects');

  // A row's key list may come from either source, and which one it came from is
  // recorded rather than inferred: `live_capture` where a recorded 2xx response replaced
  // the spec's guess (63 endpoints), `spec_200_example_top_level_keys` where nothing
  // usable has been recorded yet (5). What must never happen is a row that
  // carries keys and declines to say where they came from.
  const KEY_SOURCES = ['spec_200_example_top_level_keys', 'live_capture'];
  for (const e of withKeys) {
    assert.ok(KEY_SOURCES.includes(e.field_map_keys_source),
      `${e.name}: the provenance of a key list is never left to be inferred `
      + `(got ${JSON.stringify(e.field_map_keys_source)})`);
    assert.deepEqual(e.field_map_keys, [...e.field_map_keys].sort(),
      `${e.name}: keys must be sorted or regeneration is not byte-identical`);
    assert.equal(new Set(e.field_map_keys).size, e.field_map_keys.length, `${e.name}: duplicate key`);
  }

  // The exact key set the whole change rests on. It used to be the spec's 200-example
  // top-level keys, byte-identical to the backend's generated manifest. Both were
  // WRONG about the live response: the server answers `picture`/`url`/`positionGroups`,
  // not `profilePicture`/`linkedinUrl`/`currentTitle`, and it does not answer
  // `connectionCount` or `followerCount` at all. The recording is now the authority.
  const profileKeys = catalog.endpoints.enrich_profile.field_map_keys;
  assert.equal(catalog.endpoints.enrich_profile.field_map_keys_source, 'live_capture');
  for (const k of ['firstname', 'lastname', 'url', 'picture', 'industry', 'entityUrn',
    'location.defaultValue', 'positionGroups.0.profilePositions.0.title',
    'positionGroups.0.company.name', 'positionGroups.0.company.domain']) {
    assert.ok(profileKeys.includes(k), `the recorded profile response contains ${k}`);
  }
  for (const gone of ['currentTitle', 'currentCompany', 'linkedinUrl', 'profilePicture',
    'connectionCount', 'followerCount']) {
    assert.ok(!profileKeys.includes(gone),
      `${gone} is a spec fiction — the recorded response does not contain it, and a map `
      + 'that reads it delivers an empty column on a paid call');
  }
});

test('the three endpoints with NOTHING in the 200 example stay blank in the spec, and only a recording fills them', () => {
  // enrich_*_bulk declare no `example` at all; google_maps_places_scraper_keyword
  // declares one that is not a JSON object. From the spec alone they stay blank and say
  // so. If this list ever shrinks without a spec change, something started inventing keys.
  const THREE = ['enrich_companies_bulk', 'enrich_profiles_bulk', 'google_maps_places_scraper_keyword'];
  const specOnly = buildCatalog(fs.readFileSync(REAL_SPEC), { generatedAt: 'x' }).catalog;
  const blank = Object.values(specOnly.endpoints)
    .filter((e) => e.field_map_keys === null)
    .map((e) => e.name)
    .sort();
  assert.deepEqual(blank, THREE);
  for (const name of blank) {
    const e = specOnly.endpoints[name];
    assert.equal(e.field_map_keys_source, null, `${name}: no keys means no source`);
    assert.equal(e.field_map_status, 'TODO_no_usable_example', name);
    // null, never [] — "the API returns no keys" is a claim we cannot make.
    assert.notDeepEqual(e.field_map_keys, [], `${name}: an empty array would assert emptiness`);
  }
  // In the committed catalog their keys exist only because a 2xx was recorded.
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  for (const name of THREE) {
    assert.equal(catalog.endpoints[name].field_map_keys_source, 'live_capture', name);
    assert.equal(catalog.endpoints[name].field_map_status, 'live_fixture', name);
  }
});

test('a key set is NOT a field map, and the catalog keeps the two apart by TYPE', () => {
  // The honesty guard. A consumer that does Object.entries(field_map) must never be
  // handed a key list, and a key list must never grow values.
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  for (const e of Object.values(catalog.endpoints)) {
    assert.equal(e.field_map, null, `${e.name}: field_map is live-fixture-only`);
    if (e.field_map_keys === null) continue;
    assert.ok(Array.isArray(e.field_map_keys), `${e.name}: field_map_keys must be an array`);
    for (const k of e.field_map_keys) {
      assert.equal(typeof k, 'string', `${e.name}: a key list holds names, never values`);
    }
  }

  // What a key set still cannot supply, restated against the RECORDING (2026-09-02).
  // The old assertion named `education`/`experience`/`skills` — spec names for arrays
  // that were empty in the example, so their element shape was nowhere on record. The
  // capture answers `educations` with a populated element, so its shape IS recorded and
  // is indexed as a path. The arrays that came back EMPTY in the recording are the ones
  // whose element shape is still unknown, and an empty array yields no path at all —
  // which is the honest outcome, not a gap to paper over.
  const profile = catalog.endpoints.enrich_profile.field_map_keys;
  assert.ok(profile.some((k) => k.startsWith('educations.0.')),
    'a populated array in the recording contributes indexed paths');
  for (const emptyInCapture of ['skills', 'languages', 'certifications', 'recommendations']) {
    assert.ok(!profile.some((k) => k === emptyInCapture || k.startsWith(`${emptyInCapture}.`)),
      `${emptyInCapture} came back empty in the recording, so nothing is claimed about its elements`);
  }
});

test('field_map_status never leaves the FROZEN contract enum, whatever the keys say', () => {
  // The enum was amended on 2026-08-30 with the merge owner's authorisation — see the
  // AMENDED block in tests/contracts/frozen-contracts.sha256 — to add
  // `keys_from_spec_example`. Before that the generator FAILED CLOSED to the status that
  // claims less, which was correct but made 65 rows say "no usable example" about an
  // example they had just read the keys off.
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const allowed = new Set(SCHEMA.$defs.endpoint.properties.field_map_status.enum);
  assert.ok(allowed.has(FIELD_MAP_STATUS_KEYS_FROM_SPEC),
    'the frozen enum lost keys_from_spec_example; the pinned catalog cannot be regenerated');
  for (const e of Object.values(catalog.endpoints)) {
    assert.ok(allowed.has(e.field_map_status),
      `${e.name}: field_map_status ${e.field_map_status} is not in the frozen enum`);
  }

  // Exactly the rows that have keys carry the new status, and the three genuine blanks
  // are NOT promoted by it.
  const spec = fs.readFileSync(REAL_SPEC, 'utf8');
  const { endpoints } = extractEndpoints(YAML.parse(spec), { allowedFieldMapStatuses: allowed });
  const promoted = Object.values(endpoints).filter(
    (e) => e.field_map_status === FIELD_MAP_STATUS_KEYS_FROM_SPEC
  );
  assert.equal(promoted.length, 65, 'the enum must promote exactly the rows that have keys');
  for (const e of promoted) assert.ok(e.field_map_keys?.length, `${e.name} promoted without keys`);
  const stillTodo = Object.values(endpoints)
    .filter((e) => e.field_map_status === 'TODO_no_usable_example')
    .map((e) => e.name)
    .sort();
  assert.deepEqual(stillTodo, [
    'enrich_companies_bulk',
    'enrich_profiles_bulk',
    'google_maps_places_scraper_keyword',
  ], 'the three genuine blanks must NOT be promoted by an enum amendment');

  // And the fail-closed path still works, because it is what protects the pack if the
  // amendment is ever reverted: narrow the enum back and every row drops to the status
  // that claims less rather than emitting a value the contract rejects.
  const narrowed = new Set(['live_fixture', 'TODO_no_usable_example']);
  const { endpoints: closed } = extractEndpoints(YAML.parse(spec), {
    allowedFieldMapStatuses: narrowed,
  });
  for (const e of Object.values(closed)) {
    assert.equal(e.field_map_status, 'TODO_no_usable_example',
      `${e.name}: a status outside the contract was emitted instead of failing closed`);
    // The keys themselves are additive and legal either way; only the CLAIM narrows.
    assert.deepEqual(e.field_map_keys, endpoints[e.name].field_map_keys, e.name);
  }
});

test('responseExampleKeys reads top level only, and refuses to assert emptiness', () => {
  // Walking into the example would start describing nested shape, which is exactly the
  // part the spec cannot support.
  assert.deepEqual(responseExampleKeys({ b: 1, a: { deep: 'x' } }), ['a', 'b']);
  assert.deepEqual(responseExampleKeys({}), null, 'an empty object is not a key set');
  assert.deepEqual(responseExampleKeys(undefined), null);
  assert.deepEqual(responseExampleKeys(null), null);
  assert.deepEqual(responseExampleKeys([{ a: 1 }]), null, 'a bare array has no top-level names');
  assert.deepEqual(responseExampleKeys('example'), null, 'a bare scalar has no keys');
});

test('pricing shapes parse to the right model', () => {
  assert.equal(parsePricing({ credits_per_call: 5 }).model, 'flat');
  assert.equal(parsePricing({ credits_per_result: 6, result_count_field: 'totalElements' }).model, 'per_result');
  assert.equal(
    parsePricing({ base_credits_per_call: 10, credits_per_result: 0.5, result_count_field: 'elements' }).model,
    'base_plus_per_result'
  );
  // A declared base of zero is economically identical to per_result. Calling it
  // base_plus_per_result would make the model flip - a PRICING_SEMANTICS_CHANGED BLOCK -
  // the day the API drops a redundant `base_credits_per_call: 0`.
  const zeroBase = parsePricing({ base_credits_per_call: 0, credits_per_result: 0.1, result_count_field: 'elements' });
  assert.equal(zeroBase.model, 'per_result');
  assert.equal(zeroBase.credits_base, 0, 'the declared base is still recorded verbatim');
  assert.equal(parsePricing(undefined).model, 'unknown');
});

test('billing_field_present_in_response is false for EVERY endpoint — no recording reports a charge', () => {
  // REWRITTEN 2026-09-17, and this assertion is the whole point of the rewrite.
  //
  // The old version pinned "11 of 21 metered endpoints omit the billing field" and
  // "flat calls are verifiable by construction". Both were claims about a SPEC
  // EXAMPLE, not about a response. Measured across the 65 recorded 2xx bodies in
  // tests/fixtures/live: ZERO carry a credits/charge/cost field at any depth. So the
  // catalog was telling 57 endpoints' callers that their charge comes back from the
  // API while every receipt those calls produced read `estimated_unverifiable`.
  //
  // This test fails against the old behaviour: it asserted `true` for all 47 flat rows.
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const reported = Object.values(catalog.endpoints)
    .filter((e) => e.pricing.billing_field_present_in_response !== false)
    .map((e) => e.name);
  assert.deepEqual(reported, [],
    'an endpoint may claim it reports its charge only when a RECORDED 2xx body carries '
    + 'a billing field. None do, so every credit line in this pack is an estimate.');
  assert.equal(
    Object.keys(catalog.endpoints).length, 68,
    'all 68 rows are covered by the claim above');
});

test('the billing flag is evidence-derived: a recorded charge field, and nothing else, flips it', () => {
  // The generator has no other input for this flag, so the unit is the predicate.
  assert.equal(isBillingFieldPath('credits_charged', 'number'), true);
  assert.equal(isBillingFieldPath('meta.credits', 'number'), true);
  assert.equal(isBillingFieldPath('usage.cost', 'number'), true);
  assert.equal(isBillingFieldPath('credits', 'string'), false, 'a non-numeric "charge" is prose');
  assert.equal(isBillingFieldPath('result.price', 'number'), false, 'a product price is not a charge');
  assert.equal(isBillingFieldPath('data.0.cost', 'number'), false, 'business data, not a bill');
  assert.equal(billingFieldPresentInRecording({ observed_types: { 'meta.credits_used': 'number' } }), true);
  assert.equal(billingFieldPresentInRecording({ observed_types: { price: 'number' } }), false);
  assert.equal(billingFieldPresentInRecording(undefined), false, 'no recording fails closed');
});

test('a recorded charge field DOES flip the flag — the rule is evidence, not a blanket false', () => {
  const doc = YAML.parse(fs.readFileSync(MINI, 'utf8'));
  const name = Object.keys(extractEndpoints(doc).endpoints)[0];
  const withCharge = extractEndpoints(doc, {
    liveDigest: { endpoints: { [name]: { observed_types: { credits_charged: 'number' } } } },
  });
  assert.equal(withCharge.endpoints[name].pricing.billing_field_present_in_response, true);
  assert.equal(extractEndpoints(doc).endpoints[name].pricing.billing_field_present_in_response, false);
});

test('bounded is false for exactly the 11 per-result endpoints with no result-limit parameter', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const unbounded = Object.values(catalog.endpoints)
    .filter((e) => e.pricing.bounded === false)
    .map((e) => e.name)
    .sort();
  assert.deepEqual(unbounded, [
    'directory_yellowpages',
    'enrich_companies_bulk',
    'enrich_profiles_bulk',
    'lead_search',
    'linkedin_ad_search',
    'linkedin_company_employees_search',
    'linkedin_company_posts',
    'linkedin_company_search',
    'linkedin_job_search',
    'profile_search',
    'similarweb_scraper_sync',
  ]);
  // Params that merely CONTAIN a size word must not count as a bound:
  // directory_yellowpages has max_pages (pages, not results) and linkedin_company_posts
  // has posted_limit / scrape_posted_limit (recency strings like '24h', not counts).
  assert.equal(catalog.endpoints.directory_yellowpages.pricing.bounded, false);
  assert.equal(catalog.endpoints.linkedin_company_posts.pricing.bounded, false);
  // A flat call's spend does not depend on how many results come back.
  assert.equal(catalog.endpoints.website_intelligence.pricing.bounded, true);
});

test('the empty-required-fields hazard is recorded, not smoothed over', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const none = Object.values(catalog.endpoints)
    .filter((e) => e.required_request_fields.length === 0)
    .map((e) => e.name)
    .sort();
  assert.equal(none.length, 10, '10 endpoints declare no required fields');
  assert.ok(none.includes('email_finder'));
  assert.ok(none.includes('phone_finder'), '25 credits a call and nothing is required');
  assert.ok(none.includes('lead_search'));
  // An empty POST to email_finder is spec-valid.
  assert.equal(catalog.endpoints.email_finder.request_body_required, false);
  assert.equal(catalog.endpoints.phone_finder.pricing.credits_per_call, 25);
});

test('bulk variants and batch ceilings are derived, not typed', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  assert.equal(catalog.endpoints.enrich_profile.bulk_variant, 'enrich_profiles_bulk');
  assert.equal(catalog.endpoints.enrich_profile.max_batch, 50);
  assert.equal(catalog.endpoints.enrich_company.bulk_variant, 'enrich_companies_bulk');
  assert.equal(catalog.endpoints.enrich_company.max_batch, 50);
  assert.equal(catalog.endpoints.enrich_profiles_bulk.max_batch, 50);
  assert.equal(catalog.endpoints.email_finder.bulk_variant, null);

  assert.equal(singleFormOf('enrich_profiles_bulk', ['enrich_profile']), 'enrich_profile');
  assert.equal(singleFormOf('enrich_companies_bulk', ['enrich_company']), 'enrich_company');
  assert.equal(singleFormOf('enrich_profiles_bulk', []), null);
  assert.equal(maxBatchFromText('Fetch up to 50 LinkedIn profiles in a single call.'), 50);
  assert.equal(maxBatchFromText('no ceiling here'), null);
});

test('capability groups come from OUR taxonomy, not the incoherent spec tags', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const finder = catalog.endpoints.email_finder;
  const verifier = catalog.endpoints.email_verifier;
  assert.equal(finder.spec_tag, 'Enrichment');
  assert.equal(verifier.spec_tag, 'Waterfall');
  assert.equal(finder.capability_group, 'email_and_phone');
  assert.equal(verifier.capability_group, finder.capability_group, 'same waterfall family, same group');

  const counts = {};
  for (const e of Object.values(catalog.endpoints)) {
    counts[e.capability_group] = (counts[e.capability_group] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    people_search: 8,
    enrichment: 9,
    email_and_phone: 5,
    posts_activity: 5,
    ads_libraries: 4,
    maps_directories: 4,
    web_intelligence: 10,
    search_trends: 3,
    funding: 1,
    youtube: 4,
    ai: 1,
    social: 1,
    utilities: 13,
  });
  const allowed = new Set(SCHEMA.$defs.endpoint.properties.capability_group.enum);
  for (const g of Object.keys(counts)) assert.ok(allowed.has(g), `${g} is not in the frozen enum`);
});

test('an endpoint the taxonomy has never seen gets a provisional group and a loud warning, not a crash', () => {
  const spec = fs.readFileSync(path.join(FIXTURES, 'mini-spec-plus-one.yaml'), 'utf8');
  const { catalog, stats, warnings } = buildCatalog(spec, { generatedAt: '2026-01-01T00:00:00.000Z' });
  assert.ok(catalog.endpoints.brand_new_endpoint, 'the new endpoint is still catalogued');
  assert.deepEqual(stats.provisional_groups, ['brand_new_endpoint']);
  assert.match(warnings.join('\n'), /brand_new_endpoint.*not in the capability taxonomy/);
});

test('post_keyword_search ships enabled, page-gated, priced per result on numberOfElements', () => {
  const catalog = JSON.parse(fs.readFileSync(REAL_CATALOG, 'utf8'));
  const e = catalog.endpoints.post_keyword_search;
  // Re-pinned 2026-09-17: the spec now bills 0.1 per result on the page count
  // (`numberOfElements`), not 6 per result on the total (`totalElements`). The bill is
  // bounded by the page, like every other search.
  assert.equal(e.pricing.disabled_by_default, false);
  assert.equal(e.pricing.disabled_reason, null);
  assert.equal(e.pricing.credits_per_result, 0.1);
  assert.equal(e.pricing.result_count_field, 'numberOfElements');
  assert.equal(e.pricing.page_gated, true);
  // Nothing is disabled by accident, and anything disabled on purpose says why.
  const disabled = Object.values(catalog.endpoints).filter((x) => x.pricing.disabled_by_default);
  // profile_social_metrics was briefly seeded here on 2026-08-30 as a "phantom". It is
  // not: the live server answers 401 (route exists, behind auth), not 404. See the
  // comment above DISABLED_BY_DEFAULT in _lib/catalog/generate.mjs before adding it back.
  assert.deepEqual(disabled.map((x) => x.name).sort(), Object.keys(DISABLED_BY_DEFAULT).sort());
  for (const x of disabled) {
    assert.ok(typeof x.pricing.disabled_reason === 'string' && x.pricing.disabled_reason.trim(),
      `${x.name} is disabled without a reason`);
  }
  for (const [name, reason] of Object.entries(DISABLED_BY_DEFAULT)) {
    assert.ok(String(reason?.reason ?? "").trim(), `DISABLED_BY_DEFAULT.${name} carries no reason`);
  }
});

test('the committed catalog is current with the pinned spec', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'api-catalog.json');
  fs.copyFileSync(REAL_CATALOG, out);
  // The digest MUST be passed, or this regenerates from the spec alone and reports the
  // absorbed catalog as stale — which is the same trap a consumer would fall into.
  const res = await run({
    specFile: REAL_SPEC,
    checksumFile: `${REAL_SPEC}.sha256`,
    outFile: out,
    liveDigestFile: path.join(ROOT, '_lib', 'live-field-maps.json'),
  });
  assert.equal(res.code, 0);
  assert.equal(res.wrote, false, 'run `npm run catalog:gen` - _lib/api-catalog.json is stale');
  fs.rmSync(dir, { recursive: true, force: true });
});
