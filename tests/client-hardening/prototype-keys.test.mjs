/**
 * `__proto__` passed every membership guard written as a bare bracket lookup.
 *
 * `REQUEST_CONTRACTS['__proto__']` is `Object.prototype` — truthy.
 * `RECORD_MAPPINGS['constructor']` is the `Object` function — truthy, and CALLABLE.
 * `RESPONSE_MAPS['valueOf']` is a function — truthy.
 *
 * So the one check whose whole job is "refuse to guess" let those names straight
 * through. `_lib/gates.mjs` already gets this right everywhere it looks a key up
 * (`Object.prototype.hasOwnProperty.call`, at :77, :241 and :361); the transport
 * tables did not.
 *
 * Impact was a crash or a junk request rather than traversal, but the guard is only
 * worth having if it holds for every string, so these are the strings it is tested on.
 *
 * SCOPE: this file covers the `_lib/client.mjs` and `_lib/batch.mjs` sites. The three
 * `_lib/run.mjs` sites (:120, :489, :541) are covered separately, not
 * here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRequest, mapRecord, mapResponse, inspectResponse,
  REQUEST_CONTRACTS, RECORD_MAPPINGS, RESPONSE_MAPS,
  MAP_NO_MAP,
} from '../../_lib/client.mjs';
import { bulkVariantFor } from '../../_lib/batch.mjs';

/**
 * Every `Object.prototype` member that a bare bracket lookup answers truthily for.
 * If any of these ever stops being a hazard it is because the lookup got a guard,
 * which is exactly what is being asserted.
 */
const PROTO_KEYS = [
  '__proto__', 'constructor', 'valueOf', 'toString', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  '__defineGetter__', '__lookupGetter__',
];

test('the hazard is real: a bare lookup answers truthily for all of them', () => {
  // Not a test of our code; a test that the fixture is still the hazard it claims to
  // be. If a future Node makes these lookups undefined, the guards below become
  // belt-and-braces rather than load-bearing, and someone should know.
  const hazardous = PROTO_KEYS.filter(k => Boolean(REQUEST_CONTRACTS[k]));
  assert.deepEqual(hazardous, PROTO_KEYS,
    'the bare-lookup hazard changed shape; re-read this file before trusting it');
});

// ---------------------------------------------------------------------------
// _lib/client.mjs
// ---------------------------------------------------------------------------

test('buildRequest REFUSES a prototype key instead of throwing on it', () => {
  for (const key of PROTO_KEYS) {
    // Before the fix, `contract` was Object.prototype, the `!contract` guard did not
    // fire, and `for (const k of contract.properties)` threw a TypeError — the
    // opposite of the named, actionable refusal this function promises.
    let out;
    assert.doesNotThrow(() => { out = buildRequest(key, { url: 'https://x.example' }); },
      `buildRequest("${key}") threw instead of refusing`);
    assert.equal(out.ok, false, `buildRequest("${key}") accepted a payload`);
    assert.match(out.reason, /no request contract/);
    assert.match(out.reason, /refusing to guess/);
  }
});

test('the real endpoints still build exactly as before', () => {
  const out = buildRequest('enrich_profile', { linkedin_url: 'https://linkedin.example/in/a' });
  assert.equal(out.ok, true);
  assert.deepEqual(out.payload, { url: 'https://linkedin.example/in/a' });

  const short = buildRequest('phone_finder', { first_name: 'A' });
  assert.equal(short.ok, false);
  assert.match(short.reason, /insufficient input/);
});

test('mapRecord does not CALL a prototype member as if it were a mapper', () => {
  // `RECORD_MAPPINGS['constructor']` is the Object function. The old code called it.
  const record = { url: 'https://x.example', urn: '76136784' };
  for (const key of PROTO_KEYS) {
    const out = mapRecord(key, record);
    assert.equal(out, record, `mapRecord("${key}") replaced the record`);
  }
  // And a real mapping is untouched by the guard.
  assert.deepEqual(
    mapRecord('enrich_profile', { linkedin_url: 'u' }),
    { linkedin_url: 'u', url: 'u' },
  );
});

test('mapResponse returns no columns for a prototype key', () => {
  // The recorded shape: the address is inside `result`. `confidence` is not a key the
  // server answers with at all, so it is gone from the map and from this body.
  const body = { success: true, result: { email: 'a@b.example', email_status: 'valid' }, provider: 'p' };
  for (const key of PROTO_KEYS) {
    assert.deepEqual(mapResponse(key, body), {}, `mapResponse("${key}") invented columns`);
  }
  assert.deepEqual(mapResponse('email_finder', body),
    { email: 'a@b.example', email_status: 'valid', email_provider: 'p' });
});

test('inspectResponse reports "no map" for a prototype key, not a phantom map', () => {
  const body = { result: { email: 'a@b.example' } };
  for (const key of PROTO_KEYS) {
    const r = inspectResponse(key, body);
    assert.equal(r.status, MAP_NO_MAP, `inspectResponse("${key}") claimed status ${r.status}`);
    assert.deepEqual(r.expected_keys, [], `inspectResponse("${key}") reported prototype members as expected keys`);
    assert.equal(r.is_mapping_failure, true);
  }
});

test('no table has a genuine own property under any of these names', () => {
  // The guards are only correct while the tables really do not own these keys.
  for (const table of [REQUEST_CONTRACTS, RECORD_MAPPINGS, RESPONSE_MAPS]) {
    for (const key of PROTO_KEYS) {
      assert.equal(Object.prototype.hasOwnProperty.call(table, key), false,
        `a table now owns "${key}" — the guard would start refusing a real endpoint`);
    }
  }
});

// ---------------------------------------------------------------------------
// _lib/batch.mjs
// ---------------------------------------------------------------------------

const CATALOG = {
  endpoints: {
    enrich_profile: { bulk_variant: 'enrich_profiles_bulk', max_batch: 50 },
    enrich_profiles_bulk: { max_batch: 50 },
  },
};

test('bulkVariantFor refuses a prototype key rather than reading Object.prototype', () => {
  for (const key of PROTO_KEYS) {
    assert.equal(bulkVariantFor(CATALOG, key), null, `bulkVariantFor("${key}") found a bulk variant`);
  }
});

test('a bulk_variant naming a prototype key does not resolve either', () => {
  // The second lookup in the same function: `catalog.endpoints[def.bulk_variant]`.
  const poisoned = { endpoints: { enrich_profile: { bulk_variant: '__proto__', max_batch: 50 } } };
  assert.equal(bulkVariantFor(poisoned, 'enrich_profile'), null,
    'a bulk_variant of "__proto__" resolved to Object.prototype and batching went ahead');
});

test('real bulk routing is unchanged', () => {
  const v = bulkVariantFor(CATALOG, 'enrich_profile');
  assert.equal(v.endpoint, 'enrich_profiles_bulk');
  assert.equal(v.maxBatch, 50);
  assert.equal(bulkVariantFor(CATALOG, 'email_finder'), null);
  assert.equal(bulkVariantFor(null, 'enrich_profile'), null);
});
