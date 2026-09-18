// `pricing.page_gated` is emitted, and it is NOT `!bounded`.
//
// The contract field was added because the catalog generator and gates.yaml each
// computed "the eleven unbounded endpoints" from the same pinned spec and got different
// sets. They were answering two different questions:
//
//   bounded     does a request field cap how many results THIS CALL bills for?
//   page_gated  can the caller walk to the next page and be billed again for the
//               same result set, with no ceiling but a human?
//
// Nothing emitted the field, so the catalog said nothing and gates.yaml said something
// else. These tests pin the predicate to the spec and pin the divergence to gates.yaml.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { extractEndpoints } from '../../_lib/catalog/extract.mjs';

const ROOT = new URL('../../', import.meta.url);
const catalog = JSON.parse(fs.readFileSync(fileURLToPath(new URL('_lib/api-catalog.json', ROOT)), 'utf8'));
const gates = parseYaml(fs.readFileSync(fileURLToPath(new URL('_lib/gates.yaml', ROOT)), 'utf8'));

const pageGatedInCatalog = Object.values(catalog.endpoints)
  .filter((e) => e.pricing.page_gated)
  .map((e) => e.name)
  .sort();

const boundedFalseInCatalog = Object.values(catalog.endpoints)
  .filter((e) => e.pricing.bounded === false)
  .map((e) => e.name)
  .sort();

test('every catalog endpoint carries a boolean pricing.page_gated', () => {
  const names = Object.keys(catalog.endpoints);
  assert.ok(names.length > 0);
  for (const n of names) {
    assert.equal(
      typeof catalog.endpoints[n].pricing.page_gated,
      'boolean',
      `${n}: page_gated must be emitted as a boolean, not left undefined`,
    );
  }
});

test('page_gated and bounded are different predicates, and the sets actually differ', () => {
  const gated = new Set(pageGatedInCatalog);
  const unbounded = new Set(boundedFalseInCatalog);
  const symmetric = [...new Set([...gated, ...unbounded])]
    .filter((n) => gated.has(n) !== unbounded.has(n))
    .sort();

  // If this ever went empty the field would be redundant with `bounded` and should be
  // deleted rather than maintained. It is not empty, and here is exactly why.
  assert.deepEqual(symmetric, [
    // limit exists but bounds the PAGE, and `page` walks past it -> gated, but bounded
    'enrich_companies_bulk',
    'enrich_profiles_bulk',
    'people_search',
    'post_keyword_search',
    'profile_activities',
    // flat, so bounded per call, but `page` makes every page another flat charge
    'post_activities',
    'search_bing',
  ].sort());
});

test('a limit that bounds the page is not a bound: people_search / post_keyword_search', () => {
  for (const n of ['people_search', 'post_keyword_search']) {
    const p = catalog.endpoints[n].pricing;
    assert.equal(p.bounded, true, `${n} declares a limit, so it is bounded per call`);
    assert.equal(p.page_gated, true, `${n} also declares page, so the total is unbounded`);
  }
});

test('a bulk endpoint is bounded by the caller\'s own input array, so it does not page-gate', () => {
  for (const n of ['enrich_profiles_bulk', 'enrich_companies_bulk']) {
    const e = catalog.endpoints[n];
    assert.equal(e.pricing.bounded, false, `${n} declares no limit parameter`);
    assert.equal(e.max_batch, 50, `${n} documents its own batch ceiling`);
    assert.equal(
      e.pricing.page_gated,
      false,
      `${n} bills for the urns the caller supplied; there is no next page and nothing ` +
        'for a human between pages to decide',
    );
  }
});

test('a flat endpoint page-gates exactly when it takes a page — each page is another flat charge', () => {
  // Was "a flat endpoint never page-gates". That is true per call and false per walk:
  // post_activities is 3 credits a call with a zero-based `page`, and it walked pages
  // with no confirm because the predicate excluded every flat endpoint.
  const post = catalog.endpoints.post_activities.pricing;
  assert.equal(post.model, 'flat');
  assert.equal(post.bounded, true, 'one flat call is still bounded');
  assert.equal(post.page_gated, true, 'post_activities takes `page`; walking it multiplies a flat price');
  assert.ok(gates.unbounded_endpoints.endpoints.includes('post_activities'),
    'the runtime reads gates.yaml, so the catalog being right is not enough');

  // A flat endpoint with no pagination param has no next page to walk.
  const verifier = catalog.endpoints.email_verifier.pricing;
  assert.equal(verifier.model, 'flat');
  assert.equal(verifier.page_gated, false, 'email_verifier has no page field');

  // And the rule holds across the whole catalog, derived from the pinned spec.
  const spec = parseYaml(fs.readFileSync(fileURLToPath(new URL('spec/openapi.yaml', ROOT)), 'utf8'));
  const derived = extractEndpoints(spec).endpoints;
  const flat = Object.values(derived).filter((e) => e.pricing.model === 'flat');
  assert.ok(flat.length > 0);
  const flatGated = flat.filter((e) => e.pricing.page_gated).map((e) => e.name).sort();
  assert.deepEqual(flatGated, ['post_activities', 'search_bing'],
    'the flat endpoints that take `page` are exactly the flat endpoints that page-gate');
});

test('the predicate is derived for flat endpoints too: synthetic page vs no page', () => {
  const body = (properties) => ({
    required: true,
    content: { 'application/json': { schema: { type: 'object', properties, required: ['q'] } } },
  });
  const doc = {
    paths: {
      '/synthetic_flat_paged': {
        post: { operationId: 'synthetic_flat_paged', 'x-pricing': { credits_per_call: 3 }, requestBody: body({ q: {}, page: {} }) },
      },
      '/synthetic_flat_plain': {
        post: { operationId: 'synthetic_flat_plain', 'x-pricing': { credits_per_call: 3 }, requestBody: body({ q: {}, limit: {} }) },
      },
    },
  };
  const { endpoints } = extractEndpoints(doc);
  assert.equal(endpoints.synthetic_flat_paged.pricing.model, 'flat');
  assert.equal(endpoints.synthetic_flat_paged.pricing.bounded, true);
  assert.equal(endpoints.synthetic_flat_paged.pricing.page_gated, true);
  assert.equal(endpoints.synthetic_flat_plain.pricing.page_gated, false);
});

test('the predicate is derived, not seeded: a synthetic cursor endpoint page-gates', () => {
  const doc = {
    paths: {
      '/synthetic_cursor_search': {
        post: {
          operationId: 'synthetic_cursor_search',
          'x-pricing': { credits_per_result: 3, result_count_field: 'total' },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { q: {}, limit: {}, cursor: {} }, required: ['q'] },
              },
            },
          },
        },
      },
      '/synthetic_capped_search': {
        post: {
          operationId: 'synthetic_capped_search',
          'x-pricing': { credits_per_result: 3, result_count_field: 'total' },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', properties: { q: {}, limit: {} }, required: ['q'] },
              },
            },
          },
        },
      },
    },
  };
  const { endpoints } = extractEndpoints(doc);
  assert.equal(endpoints.synthetic_cursor_search.pricing.bounded, true);
  assert.equal(
    endpoints.synthetic_cursor_search.pricing.page_gated,
    true,
    'a cursor makes limit a per-page bound even under a name the pinned spec never uses',
  );
  assert.equal(endpoints.synthetic_capped_search.pricing.bounded, true);
  assert.equal(endpoints.synthetic_capped_search.pricing.page_gated, false);
});

// ---------------------------------------------------------------------------
// The divergence. gates.yaml is READ ONLY here.
// ---------------------------------------------------------------------------

test('RESOLVED: the catalog and gates.yaml now page-gate the same set', () => {
  const inGates = [...gates.unbounded_endpoints.endpoints].sort();
  const inCatalog = pageGatedInCatalog;

  const onlyInCatalog = inCatalog.filter((n) => !inGates.includes(n));
  const onlyInGates = inGates.filter((n) => !inCatalog.includes(n));

  // The runtime gate reads gates.yaml, so this difference is what the pack ACTUALLY
  // does versus what the spec says it should do. It is recorded, not reconciled:
  // gates.yaml is policy, and a page-gate is a behavioural change.
  assert.deepEqual(
    onlyInGates,
    [],
    'gates.yaml page-gates something the spec does not justify — that is the safe direction, but say so',
  );
  // This test originally recorded a live divergence rather than reconciling it,
  // because gates.yaml was outside that change's scope and adding a page gate is a
  // behavioural change, not a bookkeeping one. That was the right call: the gap
  // was found precisely BECAUSE it was written down instead of smoothed over.
  //
  // It has since been reconciled. profile_activities is 2cr/result billed on
  // `totalElements`, with `limit` documented as "Number of items per page" and a
  // `pagination_token` to walk with, and billing_field_present_in_response is
  // false — so the charge is never verifiable and the total is unbounded. The
  // runtime gate reads gates.yaml, so its absence there meant it did not
  // page-gate at all, which is the post_keyword_search shape. It is now listed.
  assert.deepEqual(
    onlyInCatalog,
    [],
    'the catalog page-gates an endpoint gates.yaml does not, so the runtime does not '
      + 'gate it. Add it to gates.yaml:unbounded_endpoints.endpoints — do not relax '
      + 'this assertion.',
  );
});

test('the two files agree on the whole set, not just its size', () => {
  const inGates = new Set(gates.unbounded_endpoints.endpoints);
  const agreed = pageGatedInCatalog.filter((n) => inGates.has(n));
  assert.equal(agreed.length, pageGatedInCatalog.length,
    'every catalog-derived page-gated endpoint is gated at runtime');
  assert.equal(inGates.size, pageGatedInCatalog.length,
    'and gates.yaml carries nothing extra');
});
