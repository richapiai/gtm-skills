// tests/catalog/live-maps.test.mjs
//
// THE PROVENANCE GATE.
//
// `_lib/catalog/live-maps.mjs` decides what counts as evidence about the API's response
// shapes. Everything downstream trusts its output: the catalog's `field_map_keys`, the
// `live_fixture` status, and `tests/response-maps`'s check that every RESPONSE_MAPS path is
// one the server actually answered with.
//
// It shipped on 2026-09-02 with ZERO direct tests — exercised only indirectly through
// `catalog-gen`, which meant the rejection paths were never run at all. Those are the
// half that matters: absorbing a capture taken against a DIFFERENT spec would silently
// re-point the catalog at evidence about a different API, which is law 4's "never
// fabricate an actual" one level up, on the schema instead of the charge.
//
// Caught by /review. This file covers the gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  scalarPaths, detectEnvelope, digestRow, buildDigest, loadDigest, overlayDigest,
  LIVE_STATUS, LIVE_SOURCE,
} from '../../_lib/catalog/live-maps.mjs';
import { makeGtmTree } from '../helpers/index.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const capture = (body, { status = 200, sha = SHA_A } = {}) => ({
  http_status: status, body, captured_at: '2026-08-31T00:00:00Z', spec_sha256: sha,
});

// ---------------------------------------------------------------------------
// 1. scalarPaths — what counts as a readable value
// ---------------------------------------------------------------------------

test('LM.1 — nested objects and arrays flatten to indexed dotted paths', () => {
  const p = scalarPaths({
    firstname: 'Ada',
    location: { city: 'Seattle', defaultValue: 'Seattle, WA' },
    positionGroups: [{ company: { name: 'Acme' }, profilePositions: [{ title: 'VP' }] }],
    industries: ['Software'],
  });
  const keys = Object.keys(p).sort();
  assert.ok(keys.includes('location.city'));
  assert.ok(keys.includes('positionGroups.0.company.name'));
  assert.ok(keys.includes('positionGroups.0.profilePositions.0.title'));
  assert.ok(keys.includes('industries.0'), 'an array of scalars is indexed, not skipped');
  assert.equal(p['positionGroups.0.profilePositions.0.title'], 'string');
});

test('LM.2 — nothing is claimed about a shape that was not recorded', () => {
  // An empty array names a field and records NOTHING about its elements. Emitting a
  // path for it would invent a schema, which is the exact failure law 2 forbids.
  const p = scalarPaths({ skills: [], languages: [], nul: null, obj: {} });
  assert.deepEqual(Object.keys(p), [], 'empty containers and nulls contribute no paths');
});

test('LM.3 — recursion is bounded, so a pathological body cannot hang generation', () => {
  let deep = { leaf: 'v' };
  for (let i = 0; i < 200; i += 1) deep = { nest: deep };
  const p = scalarPaths(deep);
  assert.ok(Object.keys(p).length <= 1, 'depth cap holds');

  // A self-referential body must terminate rather than blow the stack. A capture file
  // cannot literally contain a cycle, but this function is exported and the cap is the
  // only thing standing between a caller's mistake and a hung build.
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => scalarPaths(cyclic));
});

// ---------------------------------------------------------------------------
// 2. detectEnvelope — recorded, never guessed
// ---------------------------------------------------------------------------

test('LM.4 — the envelope is the one the body actually has', () => {
  assert.equal(detectEnvelope({ success: true, result: { email: 'a@b' } }), 'result');
  assert.equal(detectEnvelope({ id: 1, data: { email: 'a@b' } }), 'data');
  assert.equal(detectEnvelope({ firstname: 'Ada' }), null, 'a flat body wraps in nothing');
  assert.equal(detectEnvelope({ result: null }), null, 'a null envelope is not an envelope');
  assert.equal(detectEnvelope({ result: [] }), null, 'an array is not an envelope');
  assert.equal(detectEnvelope(null), null);
  assert.equal(detectEnvelope([1, 2]), null);
});

// ---------------------------------------------------------------------------
// 3. digestRow — only a successful response describes a successful response
// ---------------------------------------------------------------------------

test('LM.5 — a non-2xx capture is never evidence about response shape', () => {
  // The 2026-08-31 run recorded 422s and 400s from wrong inputs. Each says the endpoint
  // EXISTS; none says what a successful answer looks like. Absorbing one would publish
  // an error body as the field map. A 201 is different: the scrapers answer 201 with
  // the full, billed result, so any 2xx is a successful answer.
  for (const status of [199, 300, 400, 401, 403, 404, 422, 429, 500]) {
    assert.equal(digestRow('x', capture({ error: 'nope' }, { status })), null,
      `HTTP ${status} must not produce a digest row`);
  }
  assert.ok(digestRow('x', capture({ email: 'a@b' })), 'a 200 does');
  assert.ok(digestRow('x', capture({ email: 'a@b' }, { status: 201 })), 'a 201 does');
});

test('LM.6 — a 200 carrying no readable scalar produces no row', () => {
  assert.equal(digestRow('x', capture({})), null);
  assert.equal(digestRow('x', capture({ skills: [] })), null);
  assert.equal(digestRow('x', capture(null)), null);
  assert.equal(digestRow('x', capture([1, 2])), null, 'an array body is not a record');
});

test('LM.7 — a row records where it came from, so provenance is never inferred', () => {
  const row = digestRow('email_finder', capture({ success: true, result: { email: 'a@b' }, provider: 'p' }));
  assert.equal(row.source, LIVE_SOURCE);
  assert.equal(row.envelope, 'result');
  assert.equal(row.spec_sha256, SHA_A);
  assert.equal(row.captured_at, '2026-08-31T00:00:00Z');
  assert.deepEqual(row.scalar_paths, [...row.scalar_paths].sort(),
    'paths are sorted, or the digest is not byte-stable across regenerations');
});

// ---------------------------------------------------------------------------
// 4. buildDigest — THE GATE
// ---------------------------------------------------------------------------

function capturesDir (t, files) {
  const tree = makeGtmTree({ prefix: 'live-maps-' });
  t.after(() => tree.cleanup());
  const dir = path.join(tree.root, 'captures');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, `${name}.json`),
      typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

test('LM.8 — a capture pinned to a DIFFERENT spec is refused, with a reason', (t) => {
  // THE SECURITY-RELEVANT PATH, and the one that had no test. A recording taken against
  // another spec is evidence about another API. Folding it in silently would re-point
  // the catalog's response shapes at something the pinned spec never described.
  const d = capturesDir(t, {
    good: capture({ email: 'a@b' }, { sha: SHA_A }),
    stale: capture({ email: 'a@b' }, { sha: SHA_B }),
  });
  const digest = buildDigest(d, { specSha256: SHA_A });
  assert.ok(digest.endpoints.good, 'a matching capture is absorbed');
  assert.equal(digest.endpoints.stale, undefined, 'a mismatched capture is NOT absorbed');
  const why = digest.skipped.find(s => s.endpoint === 'stale');
  assert.ok(why, 'a refusal is recorded, never silent');
  assert.match(why.reason, /different spec/,
    'the reason must name the cause, or nobody can tell a rejection from an absence');
});

test('LM.9 — buildDigest refuses to run without a spec pin at all', () => {
  // A digest that does not record which spec its captures were taken against cannot be
  // checked for staleness later, and an uncheckable provenance claim is worth nothing.
  assert.throws(() => buildDigest('/nonexistent', {}), /specSha256/);
});

test('LM.10 — an unreadable capture is skipped with a reason, never crashes the build', (t) => {
  const dir = capturesDir(t, {
    good: capture({ email: 'a@b' }),
    corrupt: '{ not json',
  });
  const digest = buildDigest(dir, { specSha256: SHA_A });
  assert.ok(digest.endpoints.good);
  assert.equal(digest.endpoints.corrupt, undefined);
  assert.match(digest.skipped.find(s => s.endpoint === 'corrupt').reason, /unreadable/);
});

test('LM.11 — the harness\'s own bookkeeping files are not mistaken for captures', (t) => {
  const dir = capturesDir(t, {
    'capture-report': { planned_credits: 99 },
    'sample-inputs': { email_finder: {} },
    real: capture({ email: 'a@b' }),
  });
  const digest = buildDigest(dir, { specSha256: SHA_A });
  assert.deepEqual(Object.keys(digest.endpoints), ['real']);
});

test('LM.12 — a missing captures directory yields an empty digest, not a throw', () => {
  const d = buildDigest('/definitely/not/here', { specSha256: SHA_A });
  assert.deepEqual(d.endpoints, {});
  assert.equal(d.spec_sha256, SHA_A);
});

// ---------------------------------------------------------------------------
// 5. overlayDigest — what actually reaches the catalog
// ---------------------------------------------------------------------------

const baseEndpoints = () => ({
  email_finder: { name: 'email_finder', field_map: null, field_map_status: 'keys_from_spec_example', field_map_keys: ['confidence', 'email', 'provider'] },
  other: { name: 'other', field_map: null, field_map_status: 'keys_from_spec_example', field_map_keys: ['a'] },
});

test('OV.1 — an absorbed row replaces the spec\'s guess and says it did', () => {
  const digest = buildDigestFrom({ email_finder: capture({ success: true, result: { email: 'a@b' }, provider: 'p' }) });
  const { endpoints, absorbed } = overlayDigest(baseEndpoints(), digest, { specSha256: SHA_A });
  assert.deepEqual(absorbed, ['email_finder']);
  const e = endpoints.email_finder;
  assert.equal(e.field_map_status, LIVE_STATUS);
  assert.equal(e.field_map_keys_source, LIVE_SOURCE);
  assert.equal(e.live_envelope, 'result');
  assert.ok(e.field_map_keys.includes('result.email'),
    'the catalog publishes the path the server answered with, not the spec\'s top-level guess');
  assert.ok(!e.field_map_keys.includes('confidence'),
    'the spec\'s fictional key is gone — that fiction is what dropped the email');
  assert.equal(e.field_map, null,
    'the catalog publishes an observed SHAPE, never a mapping — one source of truth per decision');
});

test('OV.2 — an endpoint with no recording keeps exactly what it had', () => {
  const digest = buildDigestFrom({ email_finder: capture({ result: { email: 'a@b' } }) });
  const { endpoints } = overlayDigest(baseEndpoints(), digest, { specSha256: SHA_A });
  assert.deepEqual(endpoints.other, baseEndpoints().other,
    'absorption must not touch a row it has no evidence about');
});

test('OV.3 — a digest built against another spec is rejected WHOLE, with a reason', () => {
  const digest = { spec_sha256: SHA_B, endpoints: { email_finder: { scalar_paths: ['x'], spec_sha256: SHA_B } } };
  const { endpoints, absorbed, rejected } = overlayDigest(baseEndpoints(), digest, { specSha256: SHA_A });
  assert.deepEqual(absorbed, [], 'nothing is absorbed from a mismatched digest');
  assert.equal(endpoints.email_finder.field_map_status, 'keys_from_spec_example', 'the row is untouched');
  assert.match(rejected[0].reason, /built against spec/);
});

test('OV.4 — a recording for an endpoint the spec dropped is refused, not resurrected', () => {
  const digest = buildDigestFrom({ removed_endpoint: capture({ a: 1 }) });
  const { endpoints, rejected } = overlayDigest(baseEndpoints(), digest, { specSha256: SHA_A });
  assert.equal(endpoints.removed_endpoint, undefined,
    'absorption may correct a row, never invent one the spec does not have');
  assert.match(rejected.find(r => r.endpoint === 'removed_endpoint').reason, /not in the spec/);
});

test('OV.5 — a null digest is a no-op, so a missing file degrades and never wedges', () => {
  const { endpoints, absorbed } = overlayDigest(baseEndpoints(), null, { specSha256: SHA_A });
  assert.deepEqual(absorbed, []);
  assert.deepEqual(endpoints, baseEndpoints());
});

test('OV.6 — overlay does not mutate the endpoints it was given', () => {
  const input = baseEndpoints();
  const digest = buildDigestFrom({ email_finder: capture({ result: { email: 'a@b' } }) });
  overlayDigest(input, digest, { specSha256: SHA_A });
  assert.equal(input.email_finder.field_map_status, 'keys_from_spec_example',
    'the caller\'s object is untouched; catalog generation reruns must be deterministic');
});

test('LD.1 — loadDigest never throws, and refuses a file that is not a digest', () => {
  assert.equal(loadDigest('/definitely/not/here'), null);
  const tree = makeGtmTree({ prefix: 'live-maps-load-' });
  const bad = tree.write('bad.json', '{ "nope": 1 }');
  assert.equal(loadDigest(bad), null, 'an object with no `endpoints` is not a digest');
  const notJson = tree.write('bad2.json', 'nope');
  assert.equal(loadDigest(notJson), null);
  tree.cleanup();
});

/** Build a digest in memory from endpoint -> capture, without touching disk. */
function buildDigestFrom (captures) {
  const endpoints = {};
  for (const [name, cap] of Object.entries(captures)) {
    const row = digestRow(name, cap);
    if (row) endpoints[name] = row;
  }
  return { schema_version: 1, spec_sha256: SHA_A, endpoints, skipped: [] };
}

test('a 201 answer and a bare array body are both usable evidence', () => {
  const created = digestRow('scraper', { http_status: 201, body: { data: { title: 'x', count: 2 } } });
  assert.ok(created, 'a 201 is a successful, billed answer');
  assert.equal(created.envelope, 'data');

  const bulk = digestRow('bulk', { http_status: 200, body: [{ entityUrn: 'A', firstname: 'x' }, { entityUrn: 'B' }] });
  assert.ok(bulk);
  assert.equal(bulk.envelope, 'array');
  assert.deepEqual(bulk.top_level_keys, ['entityUrn', 'firstname']);

  assert.equal(digestRow('empty', { http_status: 200, body: [] }), null);
  assert.equal(digestRow('error', { http_status: 422, body: { error: 'x' } }), null);
});
