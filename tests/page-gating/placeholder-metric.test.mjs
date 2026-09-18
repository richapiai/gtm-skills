// Pin the placeholder-example metric before it reaches public docs.
//
// CLAUDE.md law 2 says "39 of 68 response examples are >=40%
// the literal string `example`". The number was never wrong; the DEFINITION under it was
// never written down, and the same sentence measures 26, 36, 39 or 40 depending on what
// you decide 40% is 40% of. These tests pin the reading and the number together, so a
// future spec that ships real examples turns the doc red instead of leaving it wrong.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  PLACEHOLDER,
  THRESHOLD,
  claimSentence,
  leafValues,
  leafValuesWithEmptyContainers,
  measureOperation,
  measureSpec,
  measureSpecFile,
  stringLeafValues,
  topLevelValues,
} from '../../_lib/catalog/placeholder-metric.mjs';

const SPEC = fileURLToPath(new URL('../../spec/openapi.yaml', import.meta.url));
const measured = measureSpecFile(SPEC);

// --- the pinned number -----------------------------------------------------

test('THE NUMBER: 39 of 68, by scalar leaf value, at >=40%', () => {
  assert.equal(measured.endpoints_total, 68, 'the population is every POST operation in the pinned spec');
  assert.equal(measured.threshold, 0.4);
  assert.equal(
    measured.by_scalar_leaf_values.count,
    39,
    'law 2 says 39 of 68. If this fails the spec moved — regenerate the doc, do not edit the test.',
  );
});

test('the two bulk enrich endpoints are in the denominator and out of the numerator', () => {
  assert.deepEqual(measured.no_example, ['enrich_companies_bulk', 'enrich_profiles_bulk']);
  for (const n of measured.no_example) {
    assert.ok(
      !measured.by_scalar_leaf_values.endpoints.includes(n),
      `${n} declares no example at all; "no example" is not "a placeholder example"`,
    );
  }
});

test('the rejected readings are what made the claim ambiguous, and they still differ', () => {
  const r = measured.rejected_readings;
  assert.equal(r.top_level_keys_only.count, 26, 'counting only the response object\'s own keys');
  assert.equal(r.leaf_with_empty_containers.count, 36, 'counting {} and [] as leaves dilutes the ratio');
  assert.equal(r.string_leaves_only.count, 40, 'dropping numbers/booleans/nulls from the denominator');
  assert.equal(r.scalar_leaves_strictly_above.count, 38, 'the threshold is >=40%, not >40%');

  // The whole point: four defensible readings, four different numbers.
  const counts = new Set([
    measured.by_scalar_leaf_values.count,
    r.top_level_keys_only.count,
    r.leaf_with_empty_containers.count,
    r.string_leaves_only.count,
  ]);
  assert.equal(counts.size, 4, 'if these ever agreed, the definition would not need pinning');
});

test('the doc sentence is generated from the measurement, never typed', () => {
  assert.equal(
    claimSentence(measured),
    '39 of 68 response examples are at least 40% the literal string "example" by scalar leaf value; ' +
      '2 (enrich_companies_bulk, enrich_profiles_bulk) declare no example at all',
  );
});

// --- the predicate itself --------------------------------------------------

test('a placeholder is the WHOLE value "example", not a value containing it', () => {
  const op = (example) => ({ responses: { 200: { content: { 'application/json': { example } } } } });

  // 2 of 4 scalar leaves are exactly "example" -> 50% -> dominated.
  const exact = measureOperation('exact', op({ a: 'example', b: 'example', c: 'acme', d: 7 }));
  assert.equal(exact.leaf.placeholders, 2);
  assert.equal(exact.leaf.total, 4);
  assert.ok(exact.leaf.ratio >= THRESHOLD);

  // Plausible sample data is not a placeholder, whatever substring it contains.
  const lookalike = measureOperation(
    'lookalike',
    op({ a: 'example.com', b: 'user@example.com', c: 'Example', d: ' example' }),
  );
  assert.equal(lookalike.leaf.placeholders, 0, 'example.com is sample data; "example" is a blank');
  assert.equal(lookalike.leaf.ratio, 0);
});

test('leaves are collected at any depth, through arrays', () => {
  const nested = { data: { items: [{ name: 'example' }, { name: 'example' }], page: 1 } };
  assert.deepEqual(leafValues(nested), ['example', 'example', 1]);
  assert.deepEqual(topLevelValues(nested), [nested.data]);
  assert.deepEqual(stringLeafValues(nested), ['example', 'example']);
});

test('the empty-container choice is the one real judgement call, and it is explicit', () => {
  const withEmpties = { data: {}, meta: [], name: 'example' };
  assert.deepEqual(leafValues(withEmpties), ['example'], 'pinned: containers are structure, not values');
  assert.deepEqual(
    leafValuesWithEmptyContainers(withEmpties).sort(),
    ['example', '[]', '{}'].sort(),
    'the rejected reading, kept computable so the 3-endpoint gap is a number not an opinion',
  );

  // Under the pinned reading this example is 100% placeholder; under the other, 33%.
  const doc = { paths: { '/e': { post: { operationId: 'e', responses: { 200: { content: { 'application/json': { example: withEmpties } } } } } } } };
  const m = measureSpec(doc);
  assert.equal(m.by_scalar_leaf_values.count, 1);
  assert.equal(m.rejected_readings.leaf_with_empty_containers.count, 0);
});

test('an endpoint whose example is a bare scalar still measures', () => {
  const doc = { paths: { '/s': { post: { operationId: 's', responses: { 200: { content: { 'application/json': { example: PLACEHOLDER } } } } } } } };
  const m = measureSpec(doc);
  assert.equal(m.endpoints_total, 1);
  assert.equal(m.by_scalar_leaf_values.count, 1);
  assert.deepEqual(m.no_example, []);
});

test('a path with no POST operation is not an endpoint and is not counted', () => {
  const doc = { paths: { '/health': { get: {} } } };
  const m = measureSpec(doc);
  assert.equal(m.endpoints_total, 0, 'the API is POST-only');
  assert.equal(m.by_scalar_leaf_values.count, 0);
});
