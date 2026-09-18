/**
 * "MAPPING FAILURE — THIS RUN PAID FOR CALLS AND DELIVERED ZERO COLUMNS" was printed
 * by six of the eleven live recipe runs on 2026-09-17, for endpoints that had never
 * had a `RESPONSE_MAPS` entry at all — while `_lib/run.mjs` was handing the caller the
 * whole body raw. Nothing had been lost. The banner was wrong, and a banner that is
 * wrong on most runs is a banner nobody reads on the run where it is real.
 *
 * The distinction this file pins:
 *
 *   NO MAP        the endpoint has no map, the raw body is delivered, nothing is lost.
 *                 Reported calmly, with the key count, as a coverage gap.
 *   MAPPED + LOST there IS a map, the response carried data, and it read none of it.
 *                 A paid response we could not read. Stays as loud as it ever was.
 *
 * Every test here fails against the old behaviour, where both arms incremented
 * `failures` and both produced the same shouting block.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MAP_NO_MAP, MAP_UNMAPPED, MAP_EMPTY, inspectResponse } from '../../_lib/client.mjs';
import {
  createMappingAudit,
  renderMappingAlert,
  renderUnmappedNote,
} from '../../_lib/mapping-audit.mjs';
import { buildReceipt, renderReceipt } from '../../_lib/receipt.mjs';
import { Ledger } from '../../_lib/ledger.mjs';
import { loadCatalog } from '../../_lib/enrich.mjs';
import { makeGtmTree } from '../helpers/index.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

/** An endpoint with no RESPONSE_MAPS entry, answering with real data. */
const NO_MAP_ENDPOINT = 'search_reference_data';
const NO_MAP_BODY = { seniority: ['CXO'], industries: ['Accounting'], functions: ['Sales'] };

/** A MAPPED endpoint whose response carries data the map cannot read. */
const MAPPED_ENDPOINT = 'email_finder';
const UNREADABLE_BODY = { addr: 'x@y.z', verdict: 'valid' };

test('an unmapped endpoint is NO_MAP, and the audit does not call that a failure', () => {
  const insp = inspectResponse(NO_MAP_ENDPOINT, NO_MAP_BODY);
  assert.equal(insp.status, MAP_NO_MAP);

  const audit = createMappingAudit();
  audit.record(insp);
  const s = audit.summary();

  assert.equal(s.mapping_failures, 0,
    'no map is a coverage gap, not a failure — the raw body reached the caller');
  assert.equal(s.unmapped_responses, 1);
  assert.deepEqual(s.unmapped_endpoints, [NO_MAP_ENDPOINT]);
  assert.deepEqual(s.failed_endpoints, []);
});

test('a run made entirely of unmapped endpoints is not a blackout and prints no alarm', () => {
  const audit = createMappingAudit();
  audit.record(inspectResponse(NO_MAP_ENDPOINT, NO_MAP_BODY));
  audit.record(inspectResponse(NO_MAP_ENDPOINT, NO_MAP_BODY));
  const s = audit.summary();

  assert.equal(s.columns_delivered, 0, 'no map means no columns, by construction');
  assert.equal(s.total_blackout, false,
    'zero columns because nothing was asked to map is not "paid and got nothing"');
  assert.equal(renderMappingAlert(s), null, 'the loud block must not fire here');
});

test('the calm note names the endpoint, the call count and the key count', () => {
  const audit = createMappingAudit();
  audit.record(inspectResponse(NO_MAP_ENDPOINT, NO_MAP_BODY));
  const note = renderUnmappedNote(audit.summary());

  assert.ok(note, 'a coverage gap is reported, not swallowed');
  assert.match(note, /DELIVERED UNMAPPED/);
  assert.match(note, /raw body, 3 key\(s\)/);
  assert.match(note, new RegExp(NO_MAP_ENDPOINT));
  assert.match(note, /NOT a mapping failure/);
  assert.match(note, /RESPONSE_MAPS/, 'it says how to close the gap');
  assert.ok(!/MAPPING FAILURE —/.test(note), 'the calm note must not borrow the alarm wording');
});

test('a MAPPED endpoint that reads nothing off a data-bearing body is still loud', () => {
  const insp = inspectResponse(MAPPED_ENDPOINT, UNREADABLE_BODY);
  assert.equal(insp.status, MAP_UNMAPPED, 'there IS a map and it matched nothing');

  const audit = createMappingAudit();
  audit.record(insp);
  const s = audit.summary();

  assert.equal(s.mapping_failures, 1);
  assert.deepEqual(s.failed_endpoints, [MAPPED_ENDPOINT]);
  assert.equal(s.unmapped_responses, 0);
  assert.equal(s.total_blackout, true, 'a billed call whose data we could not read');

  const alert = renderMappingAlert(s);
  assert.ok(alert);
  assert.match(alert, /MAPPING FAILURE/);
  assert.match(alert, /DELIVERED ZERO COLUMNS/);
  assert.match(alert, /re-bought on every subsequent run/);
});

test('the two kinds are reported separately in one run, and the receipt keeps them apart', (t) => {
  const audit = createMappingAudit();
  audit.record(inspectResponse(NO_MAP_ENDPOINT, NO_MAP_BODY));
  audit.record(inspectResponse(MAPPED_ENDPOINT, UNREADABLE_BODY));
  const mapping = audit.summary();

  assert.equal(mapping.mapping_failures, 1);
  assert.equal(mapping.unmapped_responses, 1);

  const tree = makeGtmTree({ prefix: 'unmapped-note-' });
  t.after(() => tree.cleanup());
  const ledger = new Ledger({ dir: tree.gtm, runId: 'r-1' });
  for (const endpoint of [NO_MAP_ENDPOINT, MAPPED_ENDPOINT]) {
    ledger.record({
      endpoint,
      catalogEntry: CATALOG.endpoints[endpoint],
      estimatedCredits: 1,
      estimateBasis: 'flat 1',
      responseBody: {},
      httpStatus: 200,
    });
  }
  const receipt = buildReceipt({ ledger, mapping });
  assert.equal(receipt.mapping_failures, 1);
  assert.equal(receipt.mapping_unmapped, 1);
  assert.deepEqual(receipt.unmapped_endpoints, [NO_MAP_ENDPOINT]);

  const text = renderReceipt(receipt);
  assert.match(text, /MAPPING FAILURE/, 'the real failure still shouts, above the money');
  assert.match(text, /DELIVERED UNMAPPED/, 'and the coverage gap is named, calmly, below it');
  assert.ok(
    text.indexOf('MAPPING FAILURE') < text.indexOf('DELIVERED UNMAPPED'),
    'the alarm comes first; the coverage note is not an alarm'
  );
});

test('a clean run grows neither block', () => {
  const audit = createMappingAudit();
  audit.record(inspectResponse('email_finder', { result: { email: 'a@b.c' }, provider: 'p' }));
  const s = audit.summary();
  assert.equal(renderMappingAlert(s), null);
  assert.equal(renderUnmappedNote(s), null);
});

test('a provider error is not counted as an empty answer', () => {
  // Live 2026-09-17: email_finder answered 200 with {ok:false, billed:false, why:
  // "providers returned an error"}. Counting that as `empty` reads as "paid, got
  // nothing"; the API says it charged nothing.
  const audit = createMappingAudit();
  const inspection = { endpoint: 'email_finder', status: MAP_EMPTY, mapped_columns: [], expected_keys: ['result.email'] };
  audit.record(inspection, { row_id: 'r0', billing: { billed: false, reason: 'provider_error' } });
  const unbilledOnly = audit.summary();
  assert.equal(unbilledOnly.provider_error_responses, 1);
  assert.equal(unbilledOnly.empty_responses, 0, 'an unbilled call is not a not-found');
  assert.equal(unbilledOnly.total_blackout, false,
    'a run whose only zero-column call was never billed is not "paid for nothing"');

  audit.record({ ...inspection }, { row_id: 'r1', billing: { billed: true, reason: null } });
  const withBilledMiss = audit.summary();
  assert.equal(withBilledMiss.empty_responses, 1, 'a billed miss is still an empty answer');
  assert.equal(withBilledMiss.total_blackout, true, 'a billed call that delivered nothing still shouts');
});
