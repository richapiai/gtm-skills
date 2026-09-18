// tests/catalog/legacy-catalog.test.mjs — the legacy tool-list catalog adapter.
//
// `richapi-catalog-diff` accepts a legacy catalog (a `tools[]` array with prose prices)
// as the OLD side of a diff. Tiered prose prices have no x-pricing equivalent, so they
// must come out as model "unknown", never as a guessed number (law 1, law 4).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isV1Catalog, adaptV1, normalizeCatalog } from '../../_lib/catalog/adapt-v1.mjs';
import { diffCatalogs } from '../../_lib/catalog/diff.mjs';

const LEGACY = {
  version: 'legacy',
  generated_at: '2026-05-04',
  tools: [
    { name: 'people_search', billing: 'per_result', credits: '0.1 / result' },
    { name: 'enrich_profile', billing: 'per_call', credits: '1 / call' },
    { name: 'email_finder', billing: 'waterfall', credits: '2 success / 1 soft-fail / 0 hard-fail' },
    { name: 'clean_domain', billing: 'free', credits: '0 (free)' },
  ],
};

test('a tools[] catalog is recognised, and a current catalog is not', () => {
  assert.equal(isV1Catalog(LEGACY), true);
  assert.equal(isV1Catalog({ endpoints: {} }), false);
  assert.equal(isV1Catalog(null), false);
});

test('prose prices map to the x-pricing vocabulary, and tiers stay unknown', () => {
  const { endpoints } = adaptV1(LEGACY);
  assert.deepEqual(Object.keys(endpoints), ['clean_domain', 'email_finder', 'enrich_profile', 'people_search']);
  assert.equal(endpoints.people_search.pricing.model, 'per_result');
  assert.equal(endpoints.people_search.pricing.credits_per_result, 0.1);
  assert.equal(endpoints.enrich_profile.pricing.model, 'flat');
  assert.equal(endpoints.enrich_profile.pricing.credits_per_call, 1);
  assert.equal(endpoints.clean_domain.pricing.credits_per_call, 0);
  assert.equal(endpoints.email_finder.pricing.model, 'unknown', 'a tiered price is never guessed');
  assert.equal(endpoints.email_finder.pricing.credits_per_call, null);
  assert.equal(endpoints.email_finder.field_map_status, 'TODO_no_usable_example');
});

test('normalizeCatalog passes a current catalog through and adapts a legacy one', () => {
  const current = { schema_version: 1, endpoints: {} };
  assert.equal(normalizeCatalog(current), current);
  assert.ok(normalizeCatalog(LEGACY).endpoints.people_search);
});

test('a legacy tiered price moving to flat is reported, not absorbed silently', () => {
  const older = adaptV1(LEGACY);
  const newer = structuredClone(older);
  newer.endpoints.email_finder.pricing = { ...newer.endpoints.email_finder.pricing,
    model: 'flat', credits_per_call: 5, bounded: true, billing_field_present_in_response: true };
  const report = diffCatalogs(older, newer);
  const text = JSON.stringify(report);
  assert.match(text, /email_finder/);
  assert.match(text, /PRICING_SEMANTICS_CHANGED/);
});
