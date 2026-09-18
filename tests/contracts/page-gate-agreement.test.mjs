// tests/contracts/page-gate-agreement.test.mjs
//
// The catalog and gates.yaml must agree about which endpoints need a human
// between pages.
//
// This disagreement has now happened twice. Early on, the catalog generator and the
// cost runtime each computed "the 11 unbounded endpoints" from the same spec and got DIFFERENT
// SETS — which is why `pricing.page_gated` was added to the catalog contract in
// the first place, to separate two predicates that had been conflated:
//
//   bounded      — a request field bounds THE PAGE (a `limit`, a `max_pages`)
//   page_gated   — nothing bounds THE TOTAL, so walking pages multiplies the
//                  charge without limit and only a human between pages caps it
//
// Both can be true at once, and for most of these endpoints they are. That is
// the whole reason one flag could not do the job.
//
// Then it happened again: once catalog-gen actually started emitting
// page_gated, the catalog derived 12 endpoints and gates.yaml listed 11. The
// missing one was `profile_activities` — per_result at 2 credits, billed on
// totalElements, with billing_field_present_in_response false, so the charge is
// never verifiable from a response. The runtime gate reads gates.yaml, so it
// was not page-gated at all. That is the post_keyword_search failure shape, the
// one that produces a five-figure bill from a single call.
//
// Nobody noticed for the same reason both times: the two files are read by
// different code, so each looks internally consistent. This test is the only
// place they are compared.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const catalog = JSON.parse(readFileSync(join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));
const gates = parseYaml(readFileSync(join(ROOT, '_lib', 'gates.yaml'), 'utf8'));

const derived = new Set(
  Object.entries(catalog.endpoints)
    .filter(([, def]) => def.pricing?.page_gated === true)
    .map(([name]) => name),
);
const gated = new Set(gates.unbounded_endpoints.endpoints);

test('every endpoint the catalog derives as page-gated is gated at runtime', () => {
  const ungated = [...derived].filter((n) => !gated.has(n)).sort();
  assert.deepEqual(ungated, [],
    'these endpoints are page-gated in the catalog but absent from '
    + 'gates.yaml:unbounded_endpoints.endpoints, so the runtime does NOT gate them. '
    + 'The runtime reads gates.yaml, so the catalog being right is not enough:\n  '
    + ungated.join('\n  '));
});

test('every endpoint gated at runtime is one the catalog agrees about', () => {
  // The other direction matters less — an extra gate costs a confirm prompt, not
  // money — but a gate on an endpoint the catalog thinks is bounded means one of
  // the two is wrong, and we should find out which.
  const extra = [...gated].filter((n) => !derived.has(n)).sort();
  assert.deepEqual(extra, [],
    'these endpoints are gated in gates.yaml but the catalog does not derive them '
    + 'as page-gated. One of the two is wrong:\n  ' + extra.join('\n  '));
});

test('bounded and page_gated are genuinely different predicates', () => {
  // Pins the distinction that caused the original disagreement. If a
  // future refactor collapses them into one flag, this fails and says why.
  const both = Object.entries(catalog.endpoints)
    .filter(([, d]) => d.pricing?.bounded === true && d.pricing?.page_gated === true);
  assert.ok(both.length > 0,
    'no endpoint is both bounded and page-gated, which means the two flags have '
    + 'collapsed into one. A `limit` that bounds the PAGE does not bound the TOTAL; '
    + 'people_search is the canonical case.');
});

test('a page-gated endpoint whose charge is unverifiable is the highest-risk shape', () => {
  // Not a failure — a census. These are the endpoints where the estimate is the
  // only number that will ever exist AND the total is unbounded, so the human
  // between pages is the entire cost control. If this list grows, the gate
  // configuration deserves a fresh look rather than a silent inheritance.
  const risky = [...derived]
    .filter((n) => catalog.endpoints[n].pricing?.billing_field_present_in_response === false)
    .sort();
  for (const n of risky) {
    assert.ok(gated.has(n),
      `${n} is page-gated with no billing field in the response — it must be gated at runtime`);
  }
});
