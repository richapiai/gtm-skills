// The empty-column tripwire.
//
// This suite exists to make the empty-column defect impossible to ship twice.
//
// The defect: RESPONSE_MAPS was inferred rather than live-verified, `enrich_profile` and
// `enrich_company` mapped to ZERO columns, the user paid ~8 credits a contact, the
// run reported success, and the downstream "is this row enriched?" predicate keyed
// on columns that could never arrive — so every row re-enriched forever.
//
// RESPONSE_MAPS is STILL partly spec-derived (live capture needs an API key),
// so this is not a historical test. It is the live guard.
//
// Every assertion below is written to FAIL if the old behaviour returns: a 2xx that
// maps to nothing must be a loud, named, evidenced mapping failure — never a silent
// empty column.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, createFakeHttp, okJson } from '../helpers/index.mjs';
import {
  inspectResponse, mapResponse, RESPONSE_MAPS, RichApiClient,
  MAP_MAPPED, MAP_EMPTY, MAP_UNMAPPED, MAP_NO_MAP,
} from '../../_lib/client.mjs';
import { createMappingAudit, renderMappingAlert } from '../../_lib/mapping-audit.mjs';
import { buildReceipt, renderReceipt, assertMappingSurfaced, MappingFailureUnreported } from '../../_lib/receipt.mjs';
import { runEnrich, loadCatalog } from '../../_lib/enrich.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';
import { Ledger } from '../../_lib/ledger.mjs';
import { nullActivationRecorder } from '../../_lib/activation.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog(REPO);

function fixture (t, rows) {
  const tree = makeGtmTree({ prefix: 's5-tripwire-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const header = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const csv = [header.join(','), ...rows.map(r => header.map(h => r[h] ?? '').join(','))].join('\n') + '\n';
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, csv);
  return { tree, input };
}

const person = (i) => ({
  first_name: `First${i}`,
  last_name: `Last${i}`,
  company_domain: `acme${i}.example`,
  linkedin_url: `https://linkedin.com/in/person-${i}`,
});

// ---------------------------------------------------------------------------
// 1. Classification: not-found vs mapping failure
// ---------------------------------------------------------------------------

test('a 2xx whose keys do not match the map is a MAPPING FAILURE, not an empty result', () => {
  // Exactly the empty-column defect: the API answers in camelCase, the map is inferred, nothing lines up.
  // Substituted here with a snake_case body against the camelCase map so the test does
  // not depend on which direction the eventual real mismatch runs in.
  const body = { title: 'VP Sales', company_name: 'Acme', location_name: 'Berlin' };

  // The old behaviour, still reachable and still silent:
  assert.deepEqual(mapResponse('enrich_profile', body), {},
    'precondition: this body genuinely maps to nothing');

  const i = inspectResponse('enrich_profile', body);
  assert.equal(i.status, MAP_UNMAPPED, 'a data-bearing 2xx that maps to nothing MUST be a mapping failure');
  assert.equal(i.is_mapping_failure, true);
  assert.equal(i.column_count, 0);
  assert.match(i.reason, /NONE are in the field map/);
  // The map's provenance travels with the finding — the reader needs to know the map
  // was never live-verified before they go looking for the bug elsewhere.
  assert.equal(i.map_status, 'live_captured_2026_08_31_single_sample');
});

test('a genuine not-found is NOT reported as a mapping failure', () => {
  // The distinction the whole tripwire turns on. Each of these is the API saying
  // "I looked and there is nothing", which is a correct zero-column answer.
  const notFounds = [
    {},                                                   // empty object
    { data: null },                                       // null envelope
    { data: {} },                                         // empty envelope
    { success: true, data: null },                        // meta-only
    { status: 'not_found', message: 'no match' },         // meta-only, worded
    { email: null, confidence: null },                    // map keys present, no values
    { data: [] },                                         // empty collection
    null,                                                 // no JSON body at all
  ];
  for (const body of notFounds) {
    const i = inspectResponse('email_finder', body);
    assert.equal(i.status, MAP_EMPTY, `${JSON.stringify(body)} must read as a genuine not-found`);
    assert.equal(i.is_mapping_failure, false, `${JSON.stringify(body)} must NOT be flagged as a bug`);
  }
});

test('`status` is meta at the top level and real data inside the envelope', () => {
  // UPDATED 2026-09-02 against the recording. email_verifier does not answer a
  // top-level `status` at all — it answers `{success, result:{status}, provider, ...}`
  // — so the same word is envelope noise at the root and the verdict one level in.
  // Getting this backwards produces either a false alarm on every not-found or a
  // missed failure on every verify.
  assert.equal(inspectResponse('email_verifier', { result: { status: 'valid' } }).status, MAP_MAPPED);
  assert.equal(inspectResponse('email_verifier', { status: 'valid' }).status, MAP_EMPTY);
  assert.equal(inspectResponse('enrich_profile', { status: 'ok' }).status, MAP_EMPTY);
});

test('a response we have no map for at all is a mapping failure, not an empty answer', () => {
  const i = inspectResponse('some_unmapped_endpoint', { anything: 'here' });
  assert.equal(i.status, MAP_NO_MAP);
  assert.equal(i.is_mapping_failure, true);
  assert.match(i.reason, /a paid response we cannot read/);
});

test('a correct response still maps, and is not flagged', () => {
  // The live shape: the current role lives under positionGroups, not at the top level.
  const i = inspectResponse('enrich_profile', {
    firstname: 'Dana', lastname: 'Wu',
    positionGroups: [{ company: { name: 'Acme' }, profilePositions: [{ title: 'VP Sales' }] }],
    skills: ['a', 'b'],           // arrays are not columns; must not stop it mapping
  });
  assert.equal(i.status, MAP_MAPPED);
  assert.equal(i.is_mapping_failure, false);
  assert.equal(i.columns.title, 'VP Sales');
  assert.equal(i.columns.company_name, 'Acme');
  assert.ok(!('skills' in i.columns));
});

// ---------------------------------------------------------------------------
// 2. Evidence
// ---------------------------------------------------------------------------

test('the raw response key set is recorded, because that is what fixes the map', () => {
  const body = { currentJobTitle: 'VP Sales', orgName: 'Acme', credits_charged: 1 };
  const i = inspectResponse('enrich_profile', body);
  assert.deepEqual(i.raw_keys.sort(), ['credits_charged', 'currentJobTitle', 'orgName']);
  assert.deepEqual(i.unrecognised_keys.sort(), ['currentJobTitle', 'orgName']);
  assert.deepEqual(i.expected_keys, Object.keys(RESPONSE_MAPS.enrich_profile));

  // Without this, the next debugger is guessing at camelCase vs snake_case again,
  // which is precisely how the empty-column defect survived to production.
  const audit = createMappingAudit();
  audit.record(i, { row_id: 'r00001-abc', hop: 0 });
  const alert = renderMappingAlert(audit.summary());
  assert.match(alert, /API returned: credits_charged, currentJobTitle, orgName/);
  assert.match(alert, /map expects : firstname, lastname, headline/);
});

test('law 7: the evidence carries key NAMES only, never a value', () => {
  const i = inspectResponse('enrich_profile', {
    currentJobTitle: 'VP Sales at Acme',
    workEmail: 'dana.wu@acme.example',
    mobile: '+1 555 0100',
  });
  const audit = createMappingAudit();
  audit.record(i, { row_id: 'r00001-abc' });
  const blob = JSON.stringify(audit.summary()) + '\n' + renderMappingAlert(audit.summary());
  for (const value of ['VP Sales at Acme', 'dana.wu@acme.example', '+1 555 0100', 'acme.example']) {
    assert.ok(!blob.includes(value), `a contact value leaked into the mapping evidence: ${value}`);
  }
  // ...while the key names, which are what a fix needs, are all present.
  for (const key of ['currentJobTitle', 'workEmail', 'mobile']) assert.ok(blob.includes(key));
});

test('distinct key sets are deduped and bounded', () => {
  const audit = createMappingAudit();
  for (let n = 0; n < 50; n++) audit.record(inspectResponse('enrich_profile', { alpha: n }));
  for (let n = 0; n < 10; n++) audit.record(inspectResponse('enrich_profile', { beta: n }));
  const e = audit.summary().by_endpoint.enrich_profile;
  assert.equal(e.calls, 60);
  assert.equal(e.failures, 60);
  assert.equal(e.observed_key_sets.length, 2, 'identical key sets must collapse to one entry');
  assert.equal(e.observed_key_sets[0].count, 50);
});

// ---------------------------------------------------------------------------
// 3. The receipt says so, loudly
// ---------------------------------------------------------------------------

function ledgerWith (t, lines) {
  const tree = makeGtmTree({ prefix: 's5-ledger-' });
  t.after(() => tree.cleanup());
  const led = new Ledger({ dir: tree.gtm, runId: 'r-1' });
  for (const l of lines) led.record(l);
  return led;
}

test('a run that paid for calls and delivered no columns SAYS SO, at the top', (t) => {
  const led = ledgerWith(t, [
    { endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, estimateBasis: 'flat 1', responseBody: { title: 'VP' }, httpStatus: 200 },
    { endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, estimateBasis: 'flat 1', responseBody: { title: 'CTO' }, httpStatus: 200 },
  ]);
  const audit = createMappingAudit();
  audit.record(inspectResponse('enrich_profile', { title: 'VP', company_name: 'Acme' }));
  audit.record(inspectResponse('enrich_profile', { title: 'CTO', company_name: 'Beta' }));
  const mapping = audit.summary();

  assert.equal(mapping.total_blackout, true, 'two paid calls, zero columns');

  const r = buildReceipt({ ledger: led, mapping });
  assert.equal(r.mapping_blackout, true);
  assert.equal(r.mapping_failures, 2);
  assert.equal(r.columns_delivered, 0);

  const text = renderReceipt(r);
  assert.match(text, /MAPPING FAILURE/);
  assert.match(text, /DELIVERED ZERO COLUMNS/);
  // Loud means FIRST. Buried under a spend table is the same silent failure with
  // extra steps.
  assert.ok(text.indexOf('MAPPING FAILURE') < text.indexOf('Spent'),
    'the tripwire must appear above the spend line');
  // And it must name the re-enrich consequence, which is the expensive half.
  assert.match(text, /re-bought on every subsequent run/);
});

test('a clean run grows no warning section (or the warning stops being read)', (t) => {
  const led = ledgerWith(t, [
    { endpoint: 'email_finder', catalogEntry: CATALOG.endpoints.email_finder, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: { result: { email: 'a@b.example' }, credits_charged: 5 }, httpStatus: 200 },
  ]);
  // The LIVE shape: the address is inside `result`. Written that way here because a
  // "clean run" fixture that uses a shape the server does not send is how the map
  // stayed wrong for a week while this very test reported everything fine.
  const audit = createMappingAudit();
  audit.record(inspectResponse('email_finder', { result: { email: 'a@b.example' }, credits_charged: 5 }));
  const mapping = audit.summary();
  assert.equal(mapping.total_blackout, false);
  assert.equal(mapping.mapping_failures, 0);

  const text = renderReceipt(buildReceipt({ ledger: led, mapping }));
  assert.equal(renderMappingAlert(mapping), null);
  assert.ok(!text.includes('MAPPING FAILURE'));
  assert.match(text, /delivered 1 distinct column/);
});

test('a genuine not-found run is reported as a not-found, never as a bug', (t) => {
  const led = ledgerWith(t, [
    { endpoint: 'email_finder', catalogEntry: CATALOG.endpoints.email_finder, estimatedCredits: 5, estimateBasis: 'flat 5', responseBody: { result: null }, httpStatus: 200 },
  ]);
  const audit = createMappingAudit();
  audit.record(inspectResponse('email_finder', { result: null }));
  const mapping = audit.summary();

  // Zero columns AND zero failures. total_blackout is true (money bought nothing),
  // but there is no mapping failure to report, so the alert speaks about spend, not
  // about a broken map.
  assert.equal(mapping.mapping_failures, 0);
  assert.equal(mapping.empty_responses, 1);
  const r = buildReceipt({ ledger: led, mapping });
  assert.equal(r.mapping_failures, 0);
  const text = renderReceipt(r);
  assert.match(text, /THIS RUN PAID FOR CALLS AND DELIVERED ZERO COLUMNS/);
  assertMappingSurfaced(r, mapping);
});

test('the guard fires on a receipt that hides a mapping failure (and is not tautological)', (t) => {
  const led = ledgerWith(t, [
    { endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, estimateBasis: 'flat 1', responseBody: { title: 'VP' }, httpStatus: 200 },
  ]);
  const audit = createMappingAudit();
  audit.record(inspectResponse('enrich_profile', { title: 'VP' }));
  const mapping = audit.summary();

  const honest = buildReceipt({ ledger: led, mapping });
  assertMappingSurfaced(honest, mapping);   // does not throw

  // Lesson from an earlier receipt guard: a guard that recomputes from the same derived field it is checking
  // can never fire. This one recomputes from the audit's raw per-endpoint counters.
  assert.throws(
    () => assertMappingSurfaced({ ...honest, mapping_failures: 0, mapping_blackout: false }, mapping),
    MappingFailureUnreported);
  assert.throws(
    () => assertMappingSurfaced({ ...honest, mapping_blackout: false }, mapping),
    MappingFailureUnreported);
});

test('a receipt built with no audit says nothing, rather than implying clean', (t) => {
  const led = ledgerWith(t, [
    { endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, estimateBasis: 'flat 1', responseBody: { title: 'VP' }, httpStatus: 200 },
  ]);
  const r = buildReceipt({ ledger: led });                 // no mapping passed
  assert.equal(r.mapping, null);
  assert.equal(r.columns_delivered, null, 'not measured is not zero');
  assert.equal(r.mapping_blackout, false);
  assert.ok(!renderReceipt(r).includes('MAPPING FAILURE'));
  assert.equal(assertMappingSurfaced(r, null), true, 'no summary means no claim either way');
});

// ---------------------------------------------------------------------------
// 4. End to end — the shape the user actually hits on their first run
// ---------------------------------------------------------------------------

test('REPRODUCTION: a paid run that delivers no columns is loud, not silent', async (t) => {
  const { tree, input } = fixture(t, Array.from({ length: 4 }, (_, i) => person(i)));

  // Every hop answers 2xx with a real payload whose keys the map does not know.
  // This is the bug as it shipped, reproduced end to end.
  const http = createFakeHttp({
    fallback: (call) => okJson({
      jobTitle: 'VP Sales', organisation: 'Acme', workEmail: `p@${call.endpoint}.example`,
      credits_charged: 1,
    }),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 1000, api,
    verify: false, confirm: async () => true, output: 'out.csv',
    activation: nullActivationRecorder(),
  });

  assert.equal(res.mode, 'run');
  assert.ok(res.http_calls > 0, 'the run must actually have paid for calls');

  // --- the tripwire ---
  assert.ok(res.mapping, 'the run result must carry a mapping audit');
  assert.equal(res.mapping.total_blackout, true, 'paid calls + zero columns must be a blackout');
  assert.equal(res.mapping.mapping_failures, res.http_calls,
    'every unreadable 2xx must be counted as a mapping failure');
  assert.equal(res.mapping.empty_responses, 0,
    'a data-bearing body must NEVER be filed as a genuine not-found');
  assert.ok(res.mapping.failed_endpoints.includes('enrich_profile'));

  // --- the evidence ---
  assert.ok(res.mapping_issues.length > 0);
  const keys = res.mapping_issues[0].raw_keys;
  assert.ok(keys.includes('jobTitle') && keys.includes('organisation'),
    'the raw response key set must be captured');

  // --- the receipt ---
  assert.equal(res.receipt.mapping_blackout, true);
  const text = renderReceipt(res.receipt);
  assert.match(text, /MAPPING FAILURE/);
  assert.match(text, /jobTitle/, 'the receipt must carry the evidence, not just the verdict');

  // --- and the thing that made the defect invisible: the output looked fine ---
  const out = fs.readFileSync(path.join(tree.root, 'out.csv'), 'utf8');
  const header = out.split('\n')[0].split(',');
  for (const col of ['title', 'company_name', 'email']) {
    assert.ok(!header.includes(col),
      'precondition: the output genuinely has no enriched columns — which is why the run must shout');
  }
});

test('rows that failed to map are NOT treated as enriched on the next run', async (t) => {
  const { tree, input } = fixture(t, [person(1)]);
  const http = createFakeHttp({ fallback: okJson({ jobTitle: 'VP', credits_charged: 1 }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });
  const common = {
    input, root: tree.root, catalog: CATALOG, budget: 1000, api,
    verify: false, confirm: async () => true, noCache: true,
    activation: nullActivationRecorder(),
  };

  const first = await runEnrich({ ...common });
  const second = await runEnrich({ ...common });

  // The old failure mode was infinite re-enrichment with nothing anywhere saying why.
  // Re-enrichment still happens (the row genuinely is not enriched) — but now BOTH
  // runs carry the blackout, so the user is told on run one instead of on the bill.
  assert.ok(second.http_calls > 0, 'precondition: the row is re-bought, because it was never enriched');
  assert.equal(first.mapping.total_blackout, true);
  assert.equal(second.mapping.total_blackout, true);
});

test('a partly-readable run reports the failure without claiming a blackout', async (t) => {
  const { tree, input } = fixture(t, [person(1)]);
  const http = createFakeHttp({
    fallback: (call) => (call.endpoint === 'email_finder'
      // email_finder's map is right
      ? okJson({ result: { email: 'a@acme.example' }, provider: 'provider_a', credits_charged: 5 })
      // enrich_profile's is not
      : okJson({ jobTitle: 'VP Sales', credits_charged: 1 })),
  });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 1000, api,
    verify: false, confirm: async () => true, activation: nullActivationRecorder(),
  });

  assert.equal(res.mapping.total_blackout, false, 'something was delivered, so it is not a blackout');
  assert.equal(res.mapping.mapping_failures, 1);
  assert.deepEqual(res.mapping.failed_endpoints, ['enrich_profile']);
  const text = renderReceipt(res.receipt);
  assert.match(text, /some paid responses could not be read/);
  assert.match(text, /enrich_profile/);
});

test('a run whose only calls were unbilled does not crash the receipt guard', () => {
  // Live 2026-09-17: three email_finder calls answered 200 {billed:false,
  // "providers returned an error"}. The guard counted them as billed, threw
  // MappingFailureUnreported, and the user got a stack trace instead of a receipt.
  const summary = {
    calls: 3,
    by_endpoint: { email_finder: { calls: 3, mapped: 0, empty: 0, provider_error: 3, failures: 0, unmapped: 0, columns: [] } },
  };
  const receipt = { calls: 3, mapping_failures: 0, mapping_blackout: false };
  assert.equal(assertMappingSurfaced(receipt, summary), true);
});

test('a billed call that delivered nothing still trips the guard', () => {
  const summary = {
    calls: 2,
    by_endpoint: { email_finder: { calls: 2, mapped: 0, empty: 1, provider_error: 1, failures: 0, unmapped: 0, columns: [] } },
  };
  assert.throws(() => assertMappingSurfaced({ calls: 2, mapping_failures: 0, mapping_blackout: false }, summary),
    /1 billed call\(s\) delivered 0 columns/);
});
