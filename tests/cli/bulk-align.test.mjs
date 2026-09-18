// tests/cli/bulk-align.test.mjs — bulk results are matched to rows by identity.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alignBulkRows } from '../../_lib/batch.mjs';

test('reordered results land on the rows that asked for them', () => {
  const ids = ['urn:li:fsd_profile:A', 'urn:li:fsd_profile:B', 'urn:li:fsd_profile:C'];
  const rows = [{ entityUrn: 'B', n: 'b' }, { entityUrn: 'C', n: 'c' }, { entityUrn: 'A', n: 'a' }];
  assert.deepEqual(alignBulkRows(ids, rows).map((r) => r.n), ['a', 'b', 'c']);
});

test('company results match on objectUrn, and a bare id matches a full URN', () => {
  const rows = [{ objectUrn: 1441, name: 'g' }, { entityUrn: 'urn:li:fsd_company:1035', name: 'm' }];
  assert.deepEqual(alignBulkRows(['1035', 'urn:li:company:1441'], rows).map((r) => r.name), ['m', 'g']);
});

test('a row the response does not name gets null, never a neighbour', () => {
  const out = alignBulkRows(['A', 'B', 'C'], [{ entityUrn: 'C' }, { entityUrn: 'A' }]);
  assert.equal(out[0].entityUrn, 'A');
  assert.equal(out[1], null);
  assert.equal(out[2].entityUrn, 'C');
});

test('each result is used once; a redacted zero id matches nothing', () => {
  assert.deepEqual(alignBulkRows(['A', 'A'], [{ entityUrn: 'A' }]).map(Boolean), [true, false]);
  assert.deepEqual(alignBulkRows(['0'], [{ objectUrn: 0 }]), [null]);
});

test('no rows, or no ids, fails closed', () => {
  assert.deepEqual(alignBulkRows(['A'], null), [null]);
  assert.deepEqual(alignBulkRows(null, [{ entityUrn: 'A' }]), []);
  assert.deepEqual(alignBulkRows([null, ''], [{ entityUrn: 'A' }]), [null, null]);
});

test('an email lookup needs a domain or a profile URL, never a company name alone', async () => {
  const { buildRequest } = await import('../../_lib/client.mjs');
  // Live 2026-09-17: first + last + company_name with no domain answered http_400.
  const named = buildRequest('email_finder', { first_name: 'A', last_name: 'B', company_name: 'Acme' });
  assert.equal(named.ok, false, 'a company name alone must be refused before the call is paid for');
  assert.equal(buildRequest('email_finder', { first_name: 'A', last_name: 'B', company_domain: 'acme.com' }).ok, true);
  assert.equal(buildRequest('email_finder', { linkedin_url: 'https://www.linkedin.com/in/a/' }).ok, true);
});
