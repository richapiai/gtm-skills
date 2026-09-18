// The tests that bite for /cost-optimizer.
//
// The single property everything here defends: A SAVING MAY NEVER EXCEED WHAT THE LEDGER
// CAN SUPPORT, and an estimate must be labelled as one. Eleven metered endpoints never
// report their charge, so a saving computed against a fabricated actual is a fabricated
// saving — and it is fabricated in the flattering direction, which is why it needs a
// test rather than a comment.
//
// Every test runs the script the SKILL.md actually ships, extracted verbatim.
//
// (Helpers live in ../scheduled-workflow/helpers.mjs. This suite owns both directories;
// keeping one copy of the sandbox machinery is the same arrangement the /measure suite
// used for its two suites.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

import {
  projectWith, gatesWithRequestedKeys, gatesFileWith, gatesFileWithout, catalogFileWith,
  runCost, lline, jline, CONTACTS, contactLeaks, REQUESTED_COST_GATES,
} from '../scheduled-workflow/helpers.mjs';
import { loadGates, hasGate, gateValue } from '../../../_lib/gates.mjs';

const [ADA, GRACE, ALAN] = CONTACTS;

/** Ledger totals recomputed independently of the script, from the raw lines. */
function ledgerBounds (lines) {
  let floor = 0;
  let ceiling = 0;
  for (const l of lines) {
    if (l.cost_status === 'actual') { floor += l.credits_actual; ceiling += l.credits_actual; }
    else if (l.cost_status === 'estimated_unverifiable') ceiling += l.credits_estimated;
  }
  return { floor, ceiling };
}

/** Pull every credit figure a saving line claims. */
function claimedSavings (report) {
  const out = [];
  for (const m of report.matchAll(/Saves(?: at least ([\d.]+),)? at most ([\d.]+)/g)) {
    out.push({ floor: Number(m[1] ?? 0), ceiling: Number(m[2]) });
  }
  for (const m of report.matchAll(/Saves ([\d.]+), verified/g)) {
    out.push({ floor: Number(m[1]), ceiling: Number(m[1]) });
  }
  return out;
}

function run (opts) {
  const proj = projectWith(opts);
  const gatesFile = gatesWithRequestedKeys(proj.root, opts.mutateGates);
  const res = runCost({ ROOT: proj.root, GATES_FILE: gatesFile, NOW: '2026-09-01T00:00:00.000Z',
    ...(opts.env ?? {}) });
  const report = res.status === 0 ? proj.read('gtm/cost/optimizer.md') : '';
  return { proj, res, report, gatesFile };
}

// --- the headline -----------------------------------------------------------

test('no saving exceeds what the ledger can support', () => {
  const ledger = [
    // repeat purchases inside the enrich_company TTL
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-10T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:01:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-10T00:01:00Z' }),
    // a hop that never hit, entirely unverifiable
    lline({ runId: 'r3', endpoint: 'email_finder', rowId: ADA, hop: 1, estimated: 5, costStatus: 'estimated_unverifiable', at: '2026-08-12T00:00:00Z' }),
    lline({ runId: 'r3', endpoint: 'email_finder', rowId: GRACE, hop: 1, estimated: 5, costStatus: 'estimated_unverifiable', at: '2026-08-12T00:01:00Z' }),
    // empty pages
    lline({ runId: 'r4', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-13T00:00:00Z' }),
    lline({ runId: 'r4', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-13T00:01:00Z' }),
    // ordinary productive spend that must never be counted as a saving
    lline({ runId: 'r5', endpoint: 'email_verifier', rowId: ALAN, estimated: 2, actual: 2, costStatus: 'actual', at: '2026-08-14T00:00:00Z' }),
  ];
  const journals = {
    r3: [
      jline({ runId: 'r3', rowId: ADA, hop: 1, endpoint: 'email_finder', status: 'failed' }),
      jline({ runId: 'r3', rowId: GRACE, hop: 1, endpoint: 'email_finder', status: 'failed' }),
    ],
  };
  const { res, report } = run({ ledger, journals });
  assert.equal(res.status, 0, res.out);

  const bounds = ledgerBounds(ledger);
  assert.match(report, new RegExp(`floor \\(the ledger can prove this\\): ${bounds.floor}`));
  assert.match(report, new RegExp(`ceiling \\(the honest upper bound\\):  ${bounds.ceiling}`));

  const savings = claimedSavings(report);
  assert.ok(savings.length >= 3, `expected several findings, got ${savings.length}`);
  for (const s of savings) {
    assert.ok(s.ceiling <= bounds.ceiling + 1e-9,
      `a single saving of ${s.ceiling} exceeds the whole ledger ceiling ${bounds.ceiling}`);
    assert.ok(s.floor <= bounds.floor + 1e-9,
      `a saving floor of ${s.floor} exceeds the ledger's verified actuals ${bounds.floor}`);
  }
  // The reported total (the first "Total identified" line) is the union, and it must
  // also be inside the ledger.
  const totalLine = report.match(/Total identified: saves[^\n]*/)[0];
  const totalCeiling = Number(totalLine.match(/at most ([\d.]+)/)[1]);
  assert.ok(totalCeiling <= bounds.ceiling + 1e-9);
  // Productive spend is not a saving.
  assert.ok(totalCeiling < bounds.ceiling, 'a report claiming the WHOLE ledger was wasted '
    + 'has stopped distinguishing spend from waste');
});

test('the findings sum to exactly their union — no credit is counted twice', () => {
  // A hop that never hit AND whose rows were re-bought inside the TTL. Both patterns
  // match the same ledger lines; the later finding must lose them.
  const ledger = [
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: ADA, hop: 0, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: ADA, hop: 0, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-05T00:00:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: GRACE, hop: 0, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-05T00:01:00Z' }),
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: GRACE, hop: 0, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:01:00Z' }),
  ];
  // Run r2's units all failed, so r2's lines are ALSO a dead hop.
  const journals = {
    r2: [
      jline({ runId: 'r2', rowId: ADA, hop: 0, endpoint: 'enrich_company', status: 'failed' }),
      jline({ runId: 'r2', rowId: GRACE, hop: 0, endpoint: 'enrich_company', status: 'failed' }),
    ],
  };
  const { res, report } = run({ ledger, journals });
  assert.equal(res.status, 0, res.out);

  const savings = claimedSavings(report);
  const sum = savings.reduce((s, x) => s + x.ceiling, 0);
  const totalLine = report.match(/Total identified: saves[^\n]*/)[0];
  const total = Number(totalLine.match(/at most ([\d.]+)/)?.[1]
    ?? totalLine.match(/saves ([\d.]+), verified/)[1]);
  assert.equal(sum, total, 'the findings must sum to their union, or a credit is double-claimed');
  assert.ok(total <= ledgerBounds(ledger).ceiling + 1e-9);
  // And when a finding was reduced, the report says so rather than swallowing it.
  if (savings.length > 1) assert.match(report, /reduced:/);
});

test('an unverifiable-only saving is labelled ESTIMATE and has a floor of zero', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'profile_activities', rowId: ADA, hop: 0, estimated: 6, costStatus: 'estimated_unverifiable', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'profile_activities', rowId: GRACE, hop: 0, estimated: 6, costStatus: 'estimated_unverifiable', at: '2026-08-01T00:01:00Z' }),
  ];
  const journals = {
    r1: [
      jline({ runId: 'r1', rowId: ADA, hop: 0, endpoint: 'profile_activities', status: 'failed' }),
      jline({ runId: 'r1', rowId: GRACE, hop: 0, endpoint: 'profile_activities', status: 'failed' }),
    ],
  };
  const { res, report } = run({ ledger, journals });
  assert.equal(res.status, 0, res.out);
  assert.match(report, /Saves at most 12 — ESTIMATE/);
  assert.match(report, /the ledger can prove none of this saving/);
  assert.ok(!/Saves 12, verified/.test(report),
    'an unverifiable line may never be spoken about as a verified saving');
  assert.match(report, /floor \(the ledger can prove this\): 0/);
});

test('a verified saving is stated exactly, without estimate language', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-01T00:01:00Z' }),
  ];
  const { res, report } = run({ ledger });
  assert.equal(res.status, 0, res.out);
  assert.match(report, /Saves 20, verified against the charge the API reported/);
  assert.ok(!/ESTIMATE/.test(report.split('## Bulk')[0].split('## What to do about it')[1] ?? ''),
    'nothing in this report is an estimate, so nothing should say it is');
});

test('a non-2xx storm yields no saving — those calls were never charged', () => {
  // 11 of 21 metered endpoints never report a charge, but a non-2xx deducts nothing at
  // all, and the ledger records that as known_zero. A finding built on those lines would
  // claim a saving on money nobody spent.
  const ledger = Array.from({ length: 40 }, (_, i) => lline({
    runId: 'r1', endpoint: 'email_finder', rowId: ADA, hop: 1, estimated: 5, actual: 0,
    costStatus: 'known_zero', httpStatus: 429, at: `2026-08-01T00:${String(i).padStart(2, '0')}:00Z`,
  }));
  const journals = {
    r1: [jline({ runId: 'r1', rowId: ADA, hop: 1, endpoint: 'email_finder', status: 'failed' })],
  };
  const { res, report } = run({ ledger, journals });
  assert.equal(res.status, 0, res.out);
  assert.match(report, /floor \(the ledger can prove this\): 0/);
  assert.match(report, /ceiling \(the honest upper bound\):  0/);
  assert.equal(claimedSavings(report).length, 0,
    'a 429 storm is not a saving opportunity; it cost nothing');
});

// --- thresholds are read, not typed ----------------------------------------

test('the thresholds this skill reads are merged, at the values this suite pins', () => {
  // The floors below are moved in a gates FILE by the two tests that follow, which is
  // how this suite proves they are READ rather than typed into the script. Pinning the
  // shipped values keeps that honest: a silent edit would otherwise change which
  // findings a report makes while every test here stayed green.
  const gates = loadGates();
  for (const [k, expected] of Object.entries(REQUESTED_COST_GATES)) {
    const dotted = `skills.cost_optimizer.${k}`;
    assert.ok(hasGate(gates, dotted), `${dotted} does not resolve`);
    assert.equal(gateValue(gates, dotted), expected,
      `${dotted} shipped as ${gateValue(gates, dotted)}, not ${expected} — reconcile deliberately`);
  }
});

test('a missing gate key is a STOP, not "no threshold"', () => {
  // Was: run against the real gates.yaml, which carried no skills.cost_optimizer block.
  // It carries one now, so the fail-closed input is MADE: a copy of the real file with
  // that block deleted. Same law-5 path, but it stays true after this merge and every
  // future one, because nothing about it depends on the shipped file's contents.
  //
  // The property is worth more here than almost anywhere: without an evidence floor
  // this skill does not fail to run, it runs and RECOMMENDS — a saving asserted off a
  // sample of one, in the flattering direction. "No threshold" must never read as
  // "every threshold cleared".
  const proj = projectWith({
    ledger: [lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: 1, costStatus: 'actual' })],
  });
  const stripped = gatesFileWithout(proj.root, 'cost_optimizer');

  // The strip is asserted directly — a no-op strip would make this green and vacuous.
  const doc = parseYaml(readFileSync(stripped, 'utf8'));
  assert.equal('cost_optimizer' in (doc.skills ?? {}), false,
    'the stripped gates file still carries skills.cost_optimizer');

  const res = runCost({ ROOT: proj.root, GATES_FILE: stripped, NOW: '2026-09-01T00:00:00.000Z' });
  assert.equal(res.status, 3, res.out);
  assert.match(res.out, /gates\.yaml key missing: skills\.cost_optimizer\./);
  assert.match(res.out, /law 5/);
  assert.ok(!proj.exists('gtm/cost/optimizer.md'), 'no report is written on a fail-closed stop');
});

test('and on the SHIPPED gates.yaml the same run completes, honestly', () => {
  // The counterpart, on the default path with no GATES_FILE at all. Without it the STOP
  // above could be any refusal; with it, the STOP is provably the missing block.
  //
  // It also re-asserts the file's headline property on the merged path: one call
  // charged 1 credit with an `actual`, so the report's floor and ceiling are both 1.
  // A merged key must not become licence to round a spend upward.
  const proj = projectWith({
    ledger: [lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: 1, costStatus: 'actual' })],
  });
  const res = runCost({ ROOT: proj.root, NOW: '2026-09-01T00:00:00.000Z' });
  assert.equal(res.status, 0, res.out);
  assert.doesNotMatch(res.out, /gates\.yaml key missing/);
  const report = proj.read('gtm/cost/optimizer.md');
  assert.deepEqual(claimedSavings(report), [],
    'one call is not evidence of a pattern, so it must recommend nothing');
  for (const { floor, ceiling } of claimedSavings(report)) {
    assert.ok(ceiling <= 1 && floor <= ceiling, 'a saving may never exceed what the ledger supports');
  }
});

test('the evidence floor comes from the gate file', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-01T00:01:00Z' }),
  ];
  const strict = run({ ledger, mutateGates: (d) => { d.skills.cost_optimizer.min_evidence_calls = 99; } });
  assert.equal(strict.res.status, 0, strict.res.out);
  assert.match(strict.report, /Nothing found that clears the evidence and saving floors/);

  const loose = run({ ledger });
  assert.match(loose.report, /Pages bought that returned no rows/);
});

test('the saving floor comes from the gate file', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'lead_search', estimated: 10, actual: 10, costStatus: 'actual', resultCount: 0, at: '2026-08-01T00:01:00Z' }),
  ];
  const strict = run({ ledger, mutateGates: (d) => { d.skills.cost_optimizer.min_saving_credits = 1000; } });
  assert.match(strict.report, /Nothing found/);
});

test('the cache TTL comes from the gate file, not from the script', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-20T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:01:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-20T00:01:00Z' }),
  ];
  const long = run({ ledger });
  assert.match(long.report, /Paid twice for a fact the cache TTL says had not moved/);

  // Shorten the TTL below the gap and the same ledger stops being a finding.
  const short = run({ ledger, mutateGates: (d) => { d.cache_ttl.endpoints.enrich_company = '1d'; } });
  assert.ok(!/Paid twice for a fact/.test(short.report),
    'with a one-day TTL a nineteen-day gap is a legitimate re-fetch, not a waste');
});

test('an endpoint the policy says is never cached is never a repeat-purchase finding', () => {
  // ai_enrich is 0d — non-deterministic output, never served from cache. Re-buying it
  // is not a missed cache hit.
  const ledger = [
    lline({ runId: 'r1', endpoint: 'ai_enrich', rowId: ADA, estimated: 2, actual: 2, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r2', endpoint: 'ai_enrich', rowId: ADA, estimated: 2, actual: 2, costStatus: 'actual', at: '2026-08-01T01:00:00Z' }),
    lline({ runId: 'r3', endpoint: 'ai_enrich', rowId: ADA, estimated: 2, actual: 2, costStatus: 'actual', at: '2026-08-01T02:00:00Z' }),
  ];
  const { report } = run({ ledger });
  assert.ok(!/Paid twice for a fact/.test(report));
});

// --- bulk is not a saving ---------------------------------------------------

test('a bulk variant is reported with zero credit saving and a named cost in certainty', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'enrich_profile', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'enrich_profile', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:01:00Z' }),
  ];
  const { report } = run({ ledger });
  assert.match(report, /Bulk variants — no credit saving/);
  assert.match(report, /enrich_profiles_bulk/);
  // The two prices are printed from the catalog rather than asserted in prose. The
  // verifiability columns used to be expected to DISAGREE (`yes | no`), on the theory
  // that a flat single form reports its charge. It never did: as of 2026-09-17 the
  // flag is derived from recorded responses and no endpoint carries a billing field,
  // so both columns read `no` and the bulk form's cost in certainty is the SHAPE of
  // the price (per-result, unbounded by the call), not a lost reconciliation.
  const bulkSection = report.split('## Bulk variants')[1];
  assert.ok(bulkSection, report);
  const row = bulkSection.split('\n').find((l) => l.startsWith('| enrich_profile |'));
  assert.ok(row, report);
  assert.match(row, /\| no \| no \|/,
    'neither form reports its charge back, and the report must not claim either does');
  assert.match(row, /"model":"flat"[\s\S]*"model":"per_result"/,
    'the certainty that is lost is the flat price, which the row prints from the catalog');
  assert.ok(!claimedSavings(report).some((s) => /bulk/i.test(String(s))),
    'batching must never be booked as a credit saving');
});

test('the bulk note is catalog-derived — reprice the bulk form and the note follows', () => {
  const proj = projectWith({
    ledger: [
      lline({ runId: 'r1', endpoint: 'enrich_profile', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual' }),
      lline({ runId: 'r1', endpoint: 'enrich_profile', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual' }),
    ],
  });
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const catalog = catalogFileWith(proj.root, (d) => {
    d.endpoints.enrich_profiles_bulk.pricing.credits_per_result = 0.4;
  });
  const res = runCost({ ROOT: proj.root, GATES_FILE: gatesFile, CATALOG_FILE: catalog,
    NOW: '2026-09-01T00:00:00.000Z' });
  assert.equal(res.status, 0, res.out);
  const row = proj.read('gtm/cost/optimizer.md').split('## Bulk variants')[1].split('\n')
    .find((l) => l.startsWith('| enrich_profile |'));
  assert.match(row, /"per_result":0\.4/,
    'the price in the report must come from the catalog, so a reprice moves it');
});

// --- degradation ------------------------------------------------------------

test('no ledger means nothing to optimise, said plainly', () => {
  const proj = projectWith({});
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const res = runCost({ ROOT: proj.root, GATES_FILE: gatesFile });
  assert.equal(res.status, 2);
  assert.match(res.out, /nothing to optimise/);
});

test('a clean ledger produces a report that finds nothing, not an invented finding', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'email_verifier', rowId: GRACE, estimated: 2, actual: 2, costStatus: 'actual', at: '2026-08-01T00:01:00Z' }),
  ];
  const journals = {
    r1: [
      jline({ runId: 'r1', rowId: ADA, hop: 0, endpoint: 'enrich_company', status: 'ok' }),
      jline({ runId: 'r1', rowId: GRACE, hop: 0, endpoint: 'email_verifier', status: 'ok' }),
    ],
  };
  const { res, report } = run({ ledger, journals });
  assert.equal(res.status, 0, res.out);
  assert.match(report, /Nothing found that clears the evidence and saving floors/);
  assert.match(report, /a pattern seen once is not a recommendation/);
  assert.equal(claimedSavings(report).length, 0);
});

test('a corrupt ledger line is skipped rather than crashing the audit', () => {
  const proj = projectWith({
    ledger: [lline({ runId: 'r1', endpoint: 'enrich_company', estimated: 1, actual: 1, costStatus: 'actual' })],
  });
  proj.write('gtm/api-calls.jsonl',
    proj.read('gtm/api-calls.jsonl') + '{ not json\n');
  const gatesFile = gatesWithRequestedKeys(proj.root);
  const res = runCost({ ROOT: proj.root, GATES_FILE: gatesFile });
  assert.equal(res.status, 0, res.out);
});

// --- PII --------------------------------------------------------------------

test('the report never carries a contact, though every fixture row is one', () => {
  const ledger = [
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:00:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: ADA, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-05T00:00:00Z' }),
    lline({ runId: 'r1', endpoint: 'enrich_company', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-01T00:01:00Z' }),
    lline({ runId: 'r2', endpoint: 'enrich_company', rowId: GRACE, estimated: 1, actual: 1, costStatus: 'actual', at: '2026-08-05T00:01:00Z' }),
  ];
  const { report, res } = run({ ledger });
  assert.equal(res.status, 0, res.out);
  assert.match(report, /Paid twice/, 'the finding must actually have fired for this to prove anything');
  assert.deepEqual(contactLeaks(report), [],
    'row identifiers are grouping keys only and are never printed');
});
