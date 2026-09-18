// The fixture corpus guards itself.
//
// These fixtures ARE the monthly-absorption test, which means the whole
// repo's confidence in catching a spec change rests on them being what they
// claim to be. Two ways they could quietly stop being that:
//
//   1. `current.yaml` drifts away from the pinned spec, so every delta is
//      measured against a baseline nobody agreed to;
//   2. a fixture is edited without editing manifest.json, so the catalog tests assert a
//      severity the file no longer produces.
//
// This suite closes both. It does NOT test catalog-diff — that suite lives
// under tests/catalog/.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPEC_FIXTURE_NAMES, specFixture, specFixtureText, specFixtureManifest,
  expectationsFor, pinnedSpec, pinnedSpecSha256, actualSpecSha256, pathBlocks
} from '../helpers/fixtures.mjs';
import { YamlError } from '../helpers/yaml.mjs';

const manifest = specFixtureManifest();

// ---------------------------------------------------- the pin still holds
test('spec/openapi.yaml still matches its recorded sha256', () => {
  assert.equal(
    actualSpecSha256(), pinnedSpecSha256(),
    'the pinned spec changed on disk. Every fixture is derived from it; re-derive them before trusting any diff test.'
  );
});

test('manifest.json records the same spec sha the fixtures were derived from', () => {
  assert.equal(manifest.derived_from.spec_sha256, pinnedSpecSha256());
});

test('manifest.json has an entry for each of the five fixtures, and no others', () => {
  assert.deepEqual(Object.keys(manifest.fixtures).sort(), [...SPEC_FIXTURE_NAMES].sort());
});

// -------------------------------------------------------- parseability
test('four fixtures parse; `malformed` must not', () => {
  for (const name of SPEC_FIXTURE_NAMES) {
    if (name === 'malformed') {
      assert.throws(() => specFixture(name), YamlError,
        'malformed.yaml has become parseable. It is the proof that a bad download warns and keeps the cache instead of wedging — if it parses, that proof is gone.');
      continue;
    }
    const doc = specFixture(name);
    assert.ok(doc && doc.paths, `${name}.yaml has a paths: block`);
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(Object.keys(doc.paths).length, expectationsFor(name).endpoint_count,
      `${name}.yaml endpoint count must match manifest.json`);
  }
});

test('malformed.yaml still carries all three declared defects', () => {
  const text = specFixtureText('malformed');
  assert.ok(text.includes('description: "First name (required if no linkedin_url'), 'unterminated quoted scalar');
  assert.ok(!text.includes('components:'), 'the document is truncated before components:');
  assert.equal(expectationsFor('malformed').parses, false);
});

// ------------------------------------- current.yaml is a verbatim slice
test('every current.yaml path block is BYTE-IDENTICAL to the pinned spec', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const specBlocks = pathBlocks(readFileSync(join(repoRoot, 'spec', 'openapi.yaml'), 'utf8'));
  const fixtureBlocks = pathBlocks(specFixtureText('current'));

  assert.equal(fixtureBlocks.size, 15);
  for (const [p, block] of fixtureBlocks) {
    assert.ok(specBlocks.has(p), `${p} exists in the pinned spec`);
    assert.equal(block, specBlocks.get(p),
      `${p} in current.yaml is not a byte-identical slice of spec/openapi.yaml — the baseline has drifted into fiction`);
  }
});

test('current.yaml covers every pricing model the catalog contract can express', () => {
  const doc = specFixture('current');
  const models = new Set();
  for (const item of Object.values(doc.paths)) {
    const p = item.post['x-pricing'];
    if (p.credits_per_call !== undefined && p.credits_per_result === undefined) models.add('flat');
    else if (p.base_credits_per_call !== undefined) models.add('base_plus_per_result');
    else if (p.credits_per_result !== undefined) models.add('per_result');
  }
  assert.deepEqual([...models].sort(), ['base_plus_per_result', 'flat', 'per_result']);
});

test('current.yaml keeps the two endpoints with NO response example at all', () => {
  const doc = specFixture('current');
  for (const p of ['/enrich_profiles_bulk', '/enrich_companies_bulk']) {
    const ex = doc.paths[p].post.responses['200'].content['application/json'].example;
    assert.equal(ex, undefined,
      `${p} must have no example. The batch path depends on it, and this is why field maps come from live fixtures, not the spec (law 2).`);
  }
});

test('current.yaml keeps email_finder, whose entire example is the string "example"', () => {
  const ex = specFixture('current').paths['/email_finder'].post.responses['200'].content['application/json'].example;
  assert.deepEqual(ex, { confidence: 'example', email: 'example', provider: 'example' });
  assert.equal(Object.values(ex).every(v => v === 'example'), true);
});

test('current.yaml keeps endpoints that declare ZERO required request fields', () => {
  const doc = specFixture('current');
  for (const p of ['/email_finder', '/phone_finder']) {
    const schema = doc.paths[p].post.requestBody.content['application/json'].schema;
    assert.equal(schema.required, undefined,
      `${p} declares no required fields — a known hazard the runtime must cover, not a green light`);
  }
  assert.equal(doc.paths['/phone_finder'].post['x-pricing'].credits_per_call, 25,
    'and phone_finder costs 25 credits per call with no required field');
});

// --------------------------------------------------------- endpoint-added
test('endpoint-added adds exactly the endpoint the manifest declares', () => {
  const base = Object.keys(specFixture('current').paths);
  const cand = Object.keys(specFixture('endpoint-added').paths);
  const added = cand.filter(p => !base.includes(p));
  const removed = base.filter(p => !cand.includes(p));
  assert.deepEqual(added, ['/slack_channel_members']);
  assert.deepEqual(removed, []);

  const declared = expectationsFor('endpoint-added').expected_findings.filter(f => f.severity === 'ADDED');
  assert.deepEqual(declared.map(f => f.path), added);
});

test('the added endpoint is a verbatim slice of the pinned spec and costs what the manifest says', () => {
  const op = specFixture('endpoint-added').paths['/slack_channel_members'].post;
  const real = pinnedSpec().paths['/slack_channel_members'].post;
  assert.deepEqual(op['x-pricing'], real['x-pricing']);
  assert.deepEqual(op['x-pricing'], expectationsFor('endpoint-added').expected_findings[0].pricing);
});

// ------------------------------------------------------- endpoint-removed
test('endpoint-removed contains one true removal and one rename', () => {
  const base = specFixture('current').paths;
  const cand = specFixture('endpoint-removed').paths;
  const removed = Object.keys(base).filter(p => !(p in cand));
  const added = Object.keys(cand).filter(p => !(p in base));
  assert.deepEqual(removed.sort(), ['/find_personal_email', '/linkedin_ad_search']);
  assert.deepEqual(added, ['/ad_search']);
});

test('the rename is byte-identical apart from the path key and operationId', () => {
  // If it were not, a fuzzy matcher could "detect" the rename off some other
  // signal and still be wrong on the real May-to-August churn.
  const before = pathBlocks(specFixtureText('current')).get('/linkedin_ad_search');
  const after = pathBlocks(specFixtureText('endpoint-removed')).get('/ad_search');
  const normalised = after
    .replace('  /ad_search:', '  /linkedin_ad_search:')
    .replace('      operationId: ad_search', '      operationId: linkedin_ad_search');
  assert.equal(normalised, before);
});

test('the true removal has no lookalike left in the candidate', () => {
  const cand = Object.keys(specFixture('endpoint-removed').paths);
  assert.equal(cand.some(p => p.includes('personal') || p.includes('find_personal')), false,
    'find_personal_email must be a genuine REMOVED_UNMAPPED, not an accidental rename candidate');
});

test('endpoint-removed declares what it must NOT produce', () => {
  const e = expectationsFor('endpoint-removed');
  assert.deepEqual(e.must_not_produce, ['REMOVED_UNMAPPED for linkedin_ad_search', 'ADDED for ad_search']);
});

// --------------------------------------------------------- price-changed
test('price-changed encodes exactly the five declared deltas and nothing else', () => {
  const older = specFixture('price-changed').paths;   // baseline (2026-05)
  const newer = specFixture('current').paths;         // candidate (pinned spec)
  assert.deepEqual(Object.keys(older).sort(), Object.keys(newer).sort(),
    'the endpoint SET must be identical — this fixture isolates pricing');

  const changed = Object.keys(newer).filter(p =>
    JSON.stringify(older[p].post['x-pricing']) !== JSON.stringify(newer[p].post['x-pricing']));
  const declared = expectationsFor('price-changed').expected_findings.map(f => `/${f.endpoint}`);
  assert.deepEqual(changed.sort(), declared.sort());
  assert.equal(changed.length, 5);
});

test('price-changed: each declared factor is the real ratio in the files', () => {
  const older = specFixture('price-changed').paths;
  const newer = specFixture('current').paths;
  for (const f of expectationsFor('price-changed').expected_findings) {
    const o = older[`/${f.endpoint}`].post['x-pricing'];
    const n = newer[`/${f.endpoint}`].post['x-pricing'];
    if (f.severity === 'PRICING_SEMANTICS_CHANGED') {
      assert.equal(o.credits_per_call, f.old.credits_per_call);
      assert.equal(o.credits_per_result, undefined, 'the baseline bills per call');
      assert.equal(n.credits_per_result, f.new.credits_per_result);
      assert.equal(n.result_count_field, f.new.result_count_field);
      assert.ok(n.credits_per_result < o.credits_per_call,
        'the NUMBER went down — a naive numeric comparison calls this a warn-only price cut '
        + 'and misses that the formula changed');
      continue;
    }
    assert.equal(o.credits_per_call, f.old.credits_per_call, `${f.endpoint} baseline`);
    assert.equal(n.credits_per_call, f.new.credits_per_call, `${f.endpoint} candidate`);
    const factor = Math.max(n.credits_per_call / o.credits_per_call, o.credits_per_call / n.credits_per_call);
    assert.ok(Math.abs(factor - f.factor) < 1e-9, `${f.endpoint} factor ${factor} != declared ${f.factor}`);
    assert.equal(f.severity, factor >= 2 ? 'REPRICED_MAJOR' : 'REPRICED_MINOR',
      `${f.endpoint} severity must follow the diff severity threshold (>=2x is MAJOR)`);
    assert.equal(f.blocks, factor >= 2);
  }
});

test('price-changed includes the exact 2.0x boundary case', () => {
  const boundary = expectationsFor('price-changed').expected_findings.find(f => f.factor === 2.0);
  assert.ok(boundary, 'a diff using > instead of >= passes every other case and fails only this one');
  assert.equal(boundary.endpoint, 'email_verifier');
  assert.equal(boundary.severity, 'REPRICED_MAJOR');
  assert.equal(boundary.blocks, true);
});

test('price-changed includes a genuinely-minor, warn-only case', () => {
  const minor = expectationsFor('price-changed').expected_findings.filter(f => f.severity === 'REPRICED_MINOR');
  assert.equal(minor.length, 1);
  assert.equal(minor[0].endpoint, 'web_emails');
  assert.equal(minor[0].blocks, false);
});

test('email_finder at 2.5x is a major reprice, because the threshold is >=2x', () => {
  // A 2 -> 5 reprice can read as minor. It is 2.5x, and the catalog-diff severity rule
  // puts REPRICED_MAJOR at >=2x, so it blocks. The manifest says so in the finding.
  const f = expectationsFor('price-changed').expected_findings.find(x => x.endpoint === 'email_finder');
  assert.equal(f.factor, 2.5);
  assert.equal(f.severity, 'REPRICED_MAJOR');
  assert.equal(f.blocks, true);
  assert.match(f.note, />=2x/);
});

test('price-changed declares its inverted diff direction explicitly', () => {
  const e = expectationsFor('price-changed');
  assert.equal(e.role, 'baseline');
  assert.equal(e.candidate, 'current.yaml');
  assert.match(e.diff_direction, /INVERTED/);
  assert.ok(e.why_inverted.length > 0);
});

// ------------------------------------------- every fixture explains itself
test('every fixture declares what breaking it means', () => {
  for (const name of SPEC_FIXTURE_NAMES) {
    const e = expectationsFor(name);
    assert.ok(e.breaking_this_means && e.breaking_this_means.length > 20,
      `${name} must say what breaking it costs, or a future reader will "fix" it`);
  }
});

test('every fixture file opens with a human-readable banner', () => {
  for (const name of SPEC_FIXTURE_NAMES) {
    const first = specFixtureText(name).split('\n')[0];
    assert.match(first, /^# =+$/, `${name}.yaml must open with a banner comment`);
  }
});
