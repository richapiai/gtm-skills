// Reusable conformance matchers, exercised against realistic objects.
//
// `assertConformsTo(contract, object)` is the matcher the other suites
// call. Each contract gets a positive case built from real spec data and a set
// of negative cases drawn from the failure modes the plan names — because a
// matcher that never rejects anything is indistinguishable from no matcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertConformsTo, assertViolates, conformsTo, CONTRACT_NAMES
} from '../helpers/contracts.mjs';
import { pinnedSpecSha256 } from '../helpers/fixtures.mjs';

// ---------------------------------------------------------- api-catalog
const CATALOG = {
  schema_version: 1,
  generated_at: '2026-08-28T09:00:00Z',
  spec_sha256: pinnedSpecSha256(),
  spec_version: '1.0.0',
  endpoints: {
    phone_finder: {
      name: 'phone_finder',
      path: '/phone_finder',
      capability_group: 'email_and_phone',
      spec_tag: 'Enrichment',
      pricing: {
        model: 'flat',
        credits_per_call: 25,
        billing_field_present_in_response: false,
        bounded: true,
        disabled_by_default: false
      },
      required_request_fields: [],
      request_body_required: false,
      bulk_variant: null,
      max_batch: null,
      field_map: null,
      field_map_status: 'TODO_no_usable_example',
      deprecated: false
    },
    enrich_profiles_bulk: {
      name: 'enrich_profiles_bulk',
      path: '/enrich_profiles_bulk',
      capability_group: 'enrichment',
      pricing: {
        model: 'per_result',
        credits_per_result: 1,
        result_count_field: '_list_count',
        billing_field_present_in_response: false,
        bounded: false
      },
      required_request_fields: ['urns'],
      request_body_required: true,
      max_batch: 50,
      field_map_status: 'TODO_no_usable_example'
    }
  }
};

test('api-catalog: a realistic generated catalog conforms', () => {
  assertConformsTo('api-catalog', CATALOG, 'generated catalog');
});

test('api-catalog: rejects an unknown capability_group', () => {
  const bad = structuredClone(CATALOG);
  bad.endpoints.phone_finder.capability_group = 'Enrichment'; // a spec tag, not our taxonomy
  assertViolates('api-catalog', bad, 'spec tags are not our capability taxonomy');
});

test('api-catalog: rejects a field_map_status outside the two allowed values', () => {
  const bad = structuredClone(CATALOG);
  bad.endpoints.phone_finder.field_map_status = 'derived_from_spec_example';
  assertViolates('api-catalog', bad, 'the spec is not a schema source (law 2)');
});

test('api-catalog: rejects a non-sha256 spec_sha256', () => {
  const bad = structuredClone(CATALOG);
  bad.spec_sha256 = 'unknown';
  assertViolates('api-catalog', bad);
});

test('api-catalog: rejects an unknown pricing model', () => {
  const bad = structuredClone(CATALOG);
  bad.endpoints.phone_finder.pricing.model = 'per_success';
  assertViolates('api-catalog', bad);
});

test('api-catalog: rejects an endpoint missing required_request_fields', () => {
  const bad = structuredClone(CATALOG);
  delete bad.endpoints.phone_finder.required_request_fields;
  assertViolates('api-catalog', bad, 'an absent list and an empty list must not look alike');
});

// --------------------------------------------------------- journal-line
const JOURNAL_PENDING = {
  schema_version: 1,
  run_id: 'run-2026-08-28-01',
  row_id: 'row-380',
  hop: 1,
  endpoint: 'phone_finder',
  status: 'pending',
  ts: '2026-08-28T09:00:01Z',
  credits_estimated: 25,
  credits_actual: null,
  response_hash: null,
  provider: null,
  confidence: null,
  error: null,
  attempt: 1
};

test('journal-line: the pre-call `pending` line conforms', () => {
  assertConformsTo('journal-line', JOURNAL_PENDING, 'pre-call write');
});

test('journal-line: the post-call `ok` line conforms', () => {
  assertConformsTo('journal-line', {
    ...JOURNAL_PENDING,
    status: 'ok',
    ts: '2026-08-28T09:00:03Z',
    credits_actual: null,
    response_hash: 'a'.repeat(64),
    provider: 'provider_b',
    confidence: 0.92
  });
});

test('journal-line: a dry-run line is every row pending with zero calls made', () => {
  for (const row of ['row-1', 'row-2', 'row-3']) {
    assertConformsTo('journal-line', { ...JOURNAL_PENDING, row_id: row, status: 'pending', credits_actual: null });
  }
});

test('journal-line: cache hits and suppression drops have their own statuses', () => {
  assertConformsTo('journal-line', { ...JOURNAL_PENDING, status: 'skipped_cache' });
  assertConformsTo('journal-line', { ...JOURNAL_PENDING, status: 'skipped_suppressed' });
  assertConformsTo('journal-line', { ...JOURNAL_PENDING, status: 'skipped_budget' });
});

test('journal-line: rejects an invented status', () => {
  assertViolates('journal-line', { ...JOURNAL_PENDING, status: 'done' });
});

test('journal-line: rejects a negative hop and a non-ISO ts', () => {
  assertViolates('journal-line', { ...JOURNAL_PENDING, hop: -1 });
  assertViolates('journal-line', { ...JOURNAL_PENDING, ts: '28/08/2026' });
});

test('journal-line: rejects a line missing row_id — the resume key', () => {
  const bad = { ...JOURNAL_PENDING };
  delete bad.row_id;
  assertViolates('journal-line', bad, 'without row_id a resume cannot tell paid rows from unpaid ones');
});

test('journal-line: a corrupt/truncated line fails rather than being half-read', () => {
  // What a kill mid-write leaves behind.
  const truncated = '{"schema_version":1,"run_id":"run-1","row_id":"row-380","hop":1,"endp';
  let parsed = null; let threw = false;
  try { parsed = JSON.parse(truncated); } catch { threw = true; }
  assert.equal(threw, true, 'a truncated journal line must not parse');
  assert.equal(parsed, null);
  // And a line that parses but lost fields must still be rejected.
  assertViolates('journal-line', { schema_version: 1, run_id: 'run-1', row_id: 'row-380' });
});

// ---------------------------------------------------------- ledger-line
const LEDGER_UNVERIFIABLE = {
  schema_version: 1,
  ts: '2026-08-28T09:00:03Z',
  run_id: 'run-2026-08-28-01',
  endpoint: 'enrich_profiles_bulk',
  credits_estimated: 50,
  credits_actual: null,
  cost_status: 'estimated_unverifiable',
  result_count: 50,
  balance_after: null,
  balance_source: 'unknown',
  http_status: 200
};

test('ledger-line: the estimated_unverifiable row conforms', () => {
  // 11 of 21 metered endpoints omit the billing field; those rows are written
  // this way and never as `actual` (law 4).
  assertConformsTo('ledger-line', LEDGER_UNVERIFIABLE);
});

test('ledger-line: a 402 body populates the balance for free', () => {
  assertConformsTo('ledger-line', {
    ...LEDGER_UNVERIFIABLE,
    endpoint: 'phone_finder',
    credits_estimated: 25,
    credits_actual: null,
    cost_status: 'estimated_unverifiable',
    result_count: null,
    balance_after: 2.5,
    balance_source: '402_body',
    http_status: 402
  });
});

test('ledger-line: rejects an invented cost_status', () => {
  assertViolates('ledger-line', { ...LEDGER_UNVERIFIABLE, cost_status: 'assumed' });
});

test('ledger-line: rejects an invented balance_source', () => {
  assertViolates('ledger-line', { ...LEDGER_UNVERIFIABLE, balance_source: 'guessed' });
});

test('ledger-line: rejects a row with no cost_status at all', () => {
  const bad = { ...LEDGER_UNVERIFIABLE };
  delete bad.cost_status;
  assertViolates('ledger-line', bad, 'an unlabelled cost silently reads as an actual');
});

test('ledger-line: the contract cannot express a string credits_estimated', () => {
  assertViolates('ledger-line', { ...LEDGER_UNVERIFIABLE, credits_estimated: '50' });
});

// ------------------------------------------------------------- matchers
test('assertConformsTo names the contract, the pointer and the value on failure', () => {
  assert.throws(
    () => assertConformsTo('ledger-line', { ...LEDGER_UNVERIFIABLE, cost_status: 'assumed' }, 'session receipt'),
    (e) => {
      assert.equal(e.name, 'ContractViolation');
      assert.equal(e.contract, 'ledger-line');
      assert.match(e.message, /session receipt/);
      assert.match(e.message, /_lib\/contracts\/ledger-line\.schema\.json/);
      assert.match(e.message, /\/cost_status/);
      return true;
    }
  );
});

test('assertViolates fails loudly when the object actually conforms', () => {
  assert.throws(() => assertViolates('ledger-line', LEDGER_UNVERIFIABLE), /expected this object to VIOLATE/);
});

test('conformsTo returns a structured result rather than throwing', () => {
  const r = conformsTo('journal-line', { schema_version: 1 });
  assert.equal(r.valid, false);
  assert.ok(r.errors.length >= 1);
  assert.ok(r.errors.every(e => typeof e.path === 'string' && typeof e.message === 'string'));
});

test('an unknown contract name is a hard error, not a silent pass', () => {
  assert.throws(() => conformsTo('dual-contract', {}), /unknown contract/);
  assert.deepEqual([...CONTRACT_NAMES], ['api-catalog', 'journal-line', 'ledger-line']);
});
