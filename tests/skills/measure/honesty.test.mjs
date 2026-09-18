// /measure — the honesty properties, which are the entire point of the skill.
//
// Every case runs the script that ships inside skills/measure/SKILL.md, extracted
// verbatim. A report is only honest if the thing the user runs is the thing that
// refuses; a test against a private helper would stay green while the shipped script
// learned to round.
//
// The four properties under test:
//   1. a run over unverifiable endpoints presents a RANGE, never a single spent figure
//   2. a report never states a spend exceeding what the ledger can support
//   3. coverage / not-found is reported BEFORE wins
//   4. a shareable artifact built from a PII-bearing journal has zero row-level fields

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  projectWith, jline, lline, runMeasure, MEASURE_SCRIPT, CONTACTS, contactLeaks,
  gatesFileWith, tmpRoot,
} from './helpers.mjs';
import { Ledger } from '../../../_lib/ledger.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { buildReceipt, assertNeverOverstates, ReceiptOverstatement, spendPhrase }
  from '../../../_lib/receipt.mjs';
import { assertAggregateOnly } from '../../../_lib/share-render.mjs';

const NOW = '2026-08-28T12:00:00.000Z';
const home = () => mkdtempSync(join(tmpdir(), 'p6-home-'));

/**
 * A run over `n` contacts on one hop. `verifiable` decides whether the LEDGER lines
 * carry a real charge read back from the response (`actual`) or the estimate that is
 * all 11 of the 21 metered endpoints will ever give us (`estimated_unverifiable`).
 */
function fixture ({
  runId = 'run-p6', contacts = CONTACTS.slice(0, 4), okCount = 3,
  verifiable = false, perCall = 2, endpoint = 'email_finder', ledgerLines = null,
} = {}) {
  const journal = [];
  const ledger = [];
  contacts.forEach((c, i) => {
    const ok = i < okCount;
    journal.push(jline({ runId, rowId: c, endpoint, status: 'pending', creditsEstimated: perCall }));
    journal.push(jline({
      runId, rowId: c, endpoint, status: ok ? 'ok' : 'failed',
      creditsEstimated: perCall, creditsActual: verifiable ? perCall : null,
      provider: ok ? 'provider_a' : null, error: ok ? null : 'http_404',
    }));
    ledger.push(lline({
      runId, endpoint, estimated: perCall,
      actual: verifiable ? perCall : null,
      costStatus: verifiable ? 'actual' : 'estimated_unverifiable',
      rowId: c,
    }));
  });
  return projectWith({ runId, journal, ledger: ledgerLines ?? ledger });
}

const measure = (p, env = {}) =>
  runMeasure({ ROOT: p.root, RUN: p.runId, NOW, richapi_SKILLS_HOME: home(), ...env });

const reportOf = (p) => p.read(`gtm/measure/${p.runId}-report.md`);

/** Every spend claim the report makes, as a number. */
function spendClaims (text) {
  return [...text.matchAll(/(?:spent|at least|up to)\s+([\d.,]+)/gi)]
    .map((m) => Number(String(m[1]).replace(/,/g, '')))
    .filter(Number.isFinite);
}

// ===========================================================================
// 1. A range stays a range.
// ===========================================================================

test('a run over endpoints that never report a charge is reported as a RANGE', () => {
  const p = fixture({ verifiable: false });
  const r = measure(p);
  assert.equal(r.status, 0, r.out);
  const text = reportOf(p);

  assert.match(text, /up to 8 credits/, 'the ceiling must be stated as a ceiling');
  assert.match(text, /this is an estimate/i);
  assert.match(text, /The figure above is a RANGE and stays one/);
  assert.match(text, /4 of 4 call\(s\) hit an endpoint that does not report its charge/);

  // The thing that must NEVER appear: a single, flat "you spent N".
  assert.doesNotMatch(text, /^Spent \d+(\.\d+)? credits\.$/m,
    'an unverifiable run must not be collapsed into one spent figure');
});

test('a partly-verifiable run states BOTH ends of the range, floor and ceiling', () => {
  const runId = 'run-mixed';
  const journal = [];
  const ledger = [];
  CONTACTS.slice(0, 4).forEach((c, i) => {
    const verifiable = i < 2;
    journal.push(jline({ runId, rowId: c, endpoint: 'email_finder', status: 'ok', creditsEstimated: 2, creditsActual: verifiable ? 2 : null, provider: 'provider_a' }));
    ledger.push(lline({
      runId, endpoint: 'email_finder', estimated: 2, actual: verifiable ? 2 : null,
      costStatus: verifiable ? 'actual' : 'estimated_unverifiable', rowId: c,
    }));
  });
  const p = projectWith({ runId, journal, ledger });
  assert.equal(measure(p).status, 0);
  const text = reportOf(p);
  assert.match(text, /Spent at least 4 credits, up to 8/,
    'a floor of verified actuals and a ceiling including the estimates');
  assert.doesNotMatch(text, /^Spent 8 credits\.$/m);
});

test('NEGATIVE CONTROL: a fully verifiable run IS allowed an exact figure', () => {
  // Without this, "always print a range" would pass every other test in this file
  // while being just as dishonest in the other direction.
  const p = fixture({ runId: 'run-exact', verifiable: true });
  assert.equal(measure(p).status, 0);
  const text = reportOf(p);
  assert.match(text, /^Spent 8 credits\.$/m);
  assert.doesNotMatch(text, /The figure above is a RANGE/);
});

test('the range comes from the ledger module, not from wording invented here', () => {
  // The report must quote spendPhrase() verbatim. If a future edit hand-writes its own
  // sentence, the pack grows a second, friendlier convention — which is the failure.
  const p = fixture({ verifiable: false });
  measure(p);
  const ledger = new Ledger({ dir: join(p.root, 'gtm'), runId: p.runId });
  const receipt = buildReceipt({ ledger, runLabel: p.runId });
  assert.ok(reportOf(p).includes(spendPhrase(receipt)),
    'the report must contain the receipt module\'s own phrasing, character for character');
});

// ===========================================================================
// 2. Never overstate.
// ===========================================================================

test('no spend claim in the report exceeds what the ledger can support', () => {
  for (const verifiable of [true, false]) {
    const p = fixture({ runId: `run-cap-${verifiable}`, verifiable });
    measure(p);
    const ledger = new Ledger({ dir: join(p.root, 'gtm'), runId: p.runId });
    const t = ledger.totals();
    const ceiling = t.credits_actual + t.credits_estimated_unverifiable;
    for (const claim of spendClaims(reportOf(p))) {
      assert.ok(claim <= ceiling + 1e-9,
        `report claims ${claim} credits, ledger ceiling is ${ceiling}`);
    }
  }
});

test('a journal that accounts for more than the ledger does not raise the claim', () => {
  // The journal is not the money record. A run whose journal says 100 credits while the
  // ledger only recorded 4 must report the LEDGER figure and surface the divergence,
  // not quietly adopt the bigger, more impressive number.
  const runId = 'run-divergent';
  const journal = [];
  CONTACTS.slice(0, 4).forEach((c) => {
    journal.push(jline({ runId, rowId: c, endpoint: 'email_finder', status: 'ok', creditsEstimated: 25, provider: 'provider_a' }));
  });
  const ledger = [lline({ runId, endpoint: 'email_finder', estimated: 4, actual: null, costStatus: 'estimated_unverifiable' })];
  const p = projectWith({ runId, journal, ledger });
  assert.equal(measure(p).status, 0);
  const text = reportOf(p);

  for (const claim of spendClaims(text)) {
    assert.ok(claim <= 4 + 1e-9, `report claims ${claim} credits against a ledger ceiling of 4`);
  }
  assert.match(text, /DIVERGENCE: the journal accounts for 100 credits/);
  assert.match(text, /The LEDGER figure governs/);
  assert.match(text, /journal est\. credits/, 'the per-hop column must be labelled as the journal\'s, not as spend');
});

test('the never-overstate guard is live, and the script does not disarm it', () => {
  // Two halves. First: the guard really throws — a guard that cannot fire is not one.
  const p = fixture({ verifiable: false });
  const ledger = new Ledger({ dir: join(p.root, 'gtm'), runId: p.runId });
  const honest = buildReceipt({ ledger, runLabel: p.runId });
  assert.equal(assertNeverOverstates(honest, ledger), true);

  assert.throws(() => assertNeverOverstates({ ...honest, credits_floor: 99 }, ledger),
    ReceiptOverstatement, 'a floor above verified actuals must throw');
  assert.throws(() => assertNeverOverstates({ ...honest, credits_ceiling: 99 }, ledger),
    ReceiptOverstatement, 'a ceiling above the ledger must throw');
  assert.throws(() => assertNeverOverstates({ ...honest, exact: true }, ledger),
    ReceiptOverstatement, 'claiming an exact figure over unverifiable lines must throw');

  // Second: the shipped script calls it, and does not wrap it in a try. A caught
  // ReceiptOverstatement is the same as no guard at all.
  const src = MEASURE_SCRIPT();
  assert.match(src, /^assertNeverOverstates\(receipt, ledger\);$/m,
    'the guard must be called at statement level, unwrapped');
  const guardIdx = src.indexOf('assertNeverOverstates(receipt, ledger)');
  const before = src.slice(0, guardIdx);
  const opens = (before.match(/\btry\s*\{/g) || []).length;
  const closes = (before.match(/\}\s*catch\b/g) || []).length;
  assert.equal(opens, closes, 'the guard call sits inside an open try block');
});

test('an unreconciled ledger is reported as unreconciled, never as agreement', () => {
  const p = fixture({ verifiable: false });
  measure(p);
  const text = reportOf(p);
  assert.match(text, /Reconciliation against `GET \/usage`: unreconciled/);
  assert.match(text, /NOT reconciled\. The ledger total above is our own arithmetic\./);
});

// ===========================================================================
// 3. Coverage before wins.
// ===========================================================================

test('what was NOT found is reported before what was, and before the money', () => {
  const p = fixture({ verifiable: false, okCount: 1 });   // 3 of 4 not found → 25%
  assert.equal(measure(p).status, 3, 'coverage this low is a STOP, and the report still writes');
  const text = reportOf(p);

  const at = (re) => text.search(re);
  const coverageHeading = at(/^## Coverage — what this run did NOT find$/m);
  const notFound = at(/\*\*not found:/m);
  const found = at(/^- found \(any hop\)/m);
  const spendHeading = at(/^## Spend$/m);
  const winsHeading = at(/^## What worked — by hop$/m);

  assert.ok(coverageHeading > -1 && notFound > -1 && found > -1 && spendHeading > -1 && winsHeading > -1,
    'the documented sections are not all present');
  assert.equal(coverageHeading, Math.min(coverageHeading, notFound, found, spendHeading, winsHeading),
    'coverage must be the first section of the report');
  assert.ok(notFound < found, 'not-found must be stated before found');
  assert.ok(coverageHeading < spendHeading, 'coverage must precede the spend section');
  assert.ok(spendHeading < winsHeading, 'wins come last');

  assert.match(text, /- \*\*not found:      3\*\*/);
  assert.match(text, /- found \(any hop\):  1/);

  // The one-line stdout summary leads with coverage too — a user who reads nothing
  // else reads that line.
  const r = measure(p);
  const cov = r.stdout.indexOf('coverage');
  const spend = r.stdout.indexOf('spend');
  assert.ok(cov > -1 && spend > -1 && cov < spend, r.stdout);
});

test('an incomplete row counts as not found, and the interrupt buckets are itemised', () => {
  const runId = 'run-interrupted';
  const journal = [
    jline({ runId, rowId: CONTACTS[0], endpoint: 'email_finder', status: 'ok', creditsEstimated: 2, provider: 'provider_a' }),
    jline({ runId, rowId: CONTACTS[1], endpoint: 'email_finder', status: 'pending', creditsEstimated: 2, attempt: 1 }),
    jline({ runId, rowId: CONTACTS[2], endpoint: 'email_finder', status: 'skipped_budget', creditsEstimated: 2, attempt: 0 }),
  ];
  const p = projectWith({ runId, journal, ledger: [lline({ runId, endpoint: 'email_finder', estimated: 2 })] });
  measure(p);
  const text = reportOf(p);
  assert.match(text, /- \*\*not found:      2\*\*/, 'in-flight and budget-halted rows are not found');
  assert.match(text, /- in flight at interrupt: 1/);
  assert.match(text, /- halted on budget:       1/);
});

test('coverage below the gate floor exits 3 and names the gate key', () => {
  const p = fixture({ runId: 'run-lowcov', verifiable: false, okCount: 1 });   // 25%
  const r = measure(p);
  assert.equal(r.status, 3, 'a coverage STOP must be actionable by a caller');
  assert.match(reportOf(p), /Coverage gate `quality_stops\.coverage_min_pct`: STOP/);
});

test('the coverage floor is READ from the gate file, not hard-coded', () => {
  const dir = tmpRoot('p6-gates-');
  const p = fixture({ runId: 'run-gateread', verifiable: false, okCount: 3 });  // 75%
  assert.equal(measure(p).status, 0, '75% clears the shipped floor');
  const strict = gatesFileWith(dir, (doc) => { doc.quality_stops.coverage_min_pct = 90; });
  assert.equal(measure(p, { GATES_FILE: strict }).status, 3,
    'raising the floor in the gate file must change the verdict');
});

test('every rate carries its denominator', () => {
  const p = fixture({ verifiable: false });
  measure(p);
  const text = reportOf(p);
  const tableRows = text.split('\n').filter((l) => /^\| \d+ \| [a-z_]+ \|/.test(l) || /^\| [a-z_]+ \| \d+ \|/.test(l));
  assert.ok(tableRows.length > 0);
  for (const row of tableRows) {
    assert.match(row, /n=\d+/, `a rate without an n: ${row}`);
  }
});

// ===========================================================================
// 4. The shareable artifact.
// ===========================================================================

test('a share artifact built from a PII-bearing journal carries zero row-level fields', () => {
  // The journal's row_ids ARE contacts. That is the realistic case and the only one
  // worth testing: a fixture keyed on "r1" would prove nothing about a real run.
  const p = fixture({ runId: 'run-share', verifiable: false });
  const rawJournal = p.read(`gtm/runs/${p.runId}.jsonl`);
  assert.ok(contactLeaks(rawJournal).length >= 4, 'the fixture journal must actually carry PII');

  assert.equal(measure(p, { SHARE: '1' }).status, 0);
  const share = p.read(`gtm/measure/${p.runId}-share.md`);

  assert.deepEqual(contactLeaks(share), [], 'the share artifact leaked a contact');
  for (const forbidden of ['row_id', 'response_hash', 'linkedin', 'phone']) {
    assert.ok(!share.toLowerCase().includes(forbidden), `share artifact mentions ${forbidden}`);
  }
  assert.match(share, /Aggregate-only\. No row identifiers, contact fields, or response bodies/);
  // It is still a real report, not an empty file that trivially leaks nothing.
  assert.match(share, /Coverage: 75%/);
  assert.match(share, /up to 8 credits/);
});

test('the PRIVATE report is aggregate too; it is built from the same object', () => {
  const p = fixture({ runId: 'run-private', verifiable: false });
  measure(p, { SHARE: '1' });
  assert.deepEqual(contactLeaks(reportOf(p)), [], 'the local report leaked a contact');
});

test('a poisoned journal cannot ride a name field out of the boundary', () => {
  // provider is coerced from free text on the way in (a real vendor is called
  // "Acme Data Labs"), so an attacker's best shot is a name-shaped value. The share
  // renderer buckets anything unrecognised; assert that end to end.
  const runId = 'run-poison';
  const journal = [
    jline({
      runId, rowId: CONTACTS[0], endpoint: 'email_finder', status: 'ok',
      creditsEstimated: 2, provider: 'contact_me_at_ceo_example_com',
    }),
  ];
  const p = projectWith({ runId, journal, ledger: [lline({ runId, endpoint: 'email_finder', estimated: 2 })] });
  measure(p, { SHARE: '1' });
  const share = p.read(`gtm/measure/${runId}-share.md`);
  assert.deepEqual(contactLeaks(share), []);
  assert.doesNotMatch(share, /https?:\/\//);
});

test('the finished artifact passes the pack\'s own aggregate-only gate', () => {
  const p = fixture({ runId: 'run-gate', verifiable: false });
  measure(p, { SHARE: '1' });
  const body = p.read(`gtm/measure/${p.runId}-share.md`);
  assert.doesNotThrow(() => assertAggregateOnly({ rendered_share_artifact: body }));
});

// ===========================================================================
// Everything else that would make the report a lie.
// ===========================================================================

test('/measure makes no paid call, and cannot: no client, no network', () => {
  const src = MEASURE_SCRIPT();
  const imports = [...src.matchAll(/^import[\s\S]*?from '([^']+)';$/gm)].map((m) => m[1]);
  const allowed = new Set([
    'node:fs', 'node:path',
    './_lib/ledger.mjs', './_lib/receipt.mjs', './_lib/share-render.mjs',
    './_lib/journal.mjs', './_lib/gates.mjs', './_lib/activation.mjs',
  ]);
  for (const i of imports) assert.ok(allowed.has(i), `unexpected import: ${i}`);
  assert.ok(!imports.includes('./_lib/client.mjs') && !imports.includes('./_lib/enrich.mjs'),
    'measuring must never reach the HTTP client');
  for (const re of [/\bfetch\s*\(/, /from\s+['"]node:(http|https|net|dns|dgram|tls|child_process)/,
    /require\(['"]node:(http|https)/, /https?:\/\/[a-z]/i]) {
    assert.doesNotMatch(src, re, `the measure script contains a network primitive: ${re}`);
  }
});

test('activation bands are surfaced, not reimplemented', () => {
  const p = fixture({ runId: 'run-bands', verifiable: false });
  measure(p);
  const text = reportOf(p);
  // The `activation:` block now exists in gates.yaml, so the bands are configured
  // and this fixture is instrumentation-DARK rather than unconfigured: a single
  // machine has n=1, far below either metric's min_n.
  //
  // The rule under test is unchanged and is the one that matters — a dark metric
  // reads YELLOW, never RED. Absence of data is not evidence of failure, and a
  // dark band that reads RED gets a working product killed.
  assert.match(text, /overall: YELLOW/);
  assert.doesNotMatch(text, /overall: RED/, 'instrumentation dark must never read RED');
  assert.doesNotMatch(text, /^ +\S.*\bRED +\d/m, 'no band may be verdicted RED off n=0');

  // Still surfaced rather than reimplemented: the verdict vocabulary comes from
  // _lib/activation.mjs. If /measure grew its own band logic these would drift.
  assert.match(text, /YELLOW/);
  assert.match(text, /metric a|install/i);
  assert.match(text, /metric b|second run/i);
});

test('the bands are actually configured, so they are not decorative', () => {
  // They were not, until a later review. activation.mjs read seven keys,
  // gates.yaml declared none of them, every read failed closed, and so every band
  // rendered "thresholds not configured" forever. Fail-closed was the right
  // behaviour and the missing block still made the activation bands useless — which is the quietest
  // way for a metric to die. This asserts the block exists and holds the shape
  // the bands require.
  const gates = loadGates();
  assert.equal(gateValue(gates, 'activation.dark_verdict'), 'yellow',
    'dark must read yellow — this is the whole dark-means-yellow rule');
  assert.equal(gateValue(gates, 'activation.metric_a_install_to_first_run.green_min_pct'), 50);
  assert.equal(gateValue(gates, 'activation.metric_a_install_to_first_run.yellow_min_pct'), 25);
  assert.equal(gateValue(gates, 'activation.metric_a_install_to_first_run.min_n'), 50);
  assert.equal(gateValue(gates, 'activation.metric_b_first_to_second_run.green_min_pct'), 30);
  assert.equal(gateValue(gates, 'activation.metric_b_first_to_second_run.yellow_min_pct'), 15);
  assert.equal(gateValue(gates, 'activation.metric_b_first_to_second_run.min_n'), 30);
  assert.equal(gateValue(gates, 'activation.metric_b_first_to_second_run.window_days'), 7);
});

test('outcomes are self-reported, and the ROI they produce is a range too', () => {
  const p = fixture({ runId: 'run-roi', verifiable: false });
  const outcomes = p.write('outcomes.json', JSON.stringify({ sent: 400, replies: 12, meetings: 4 }));
  measure(p, { OUTCOMES: outcomes });
  const text = reportOf(p);
  assert.match(text, /## Outcomes — self-reported, not observed/);
  assert.match(text, /meetings: 4  \(self-reported\)/);
  assert.match(text, /credits per meeting: between 0 and 2/,
    'a range spend must produce a range ROI, not a single figure');
  assert.match(text, /These counts came from the operator, not from the API/);
});

test('no outcomes supplied means no outcome is inferred', () => {
  const p = fixture({ runId: 'run-noroi', verifiable: false });
  measure(p);
  assert.match(reportOf(p), /None supplied\. The pack cannot see a send, a reply or a meeting/);
});

test('a run with no journal, or an empty one, refuses rather than reporting zero', () => {
  const empty = projectWith({ runId: 'run-empty', journal: [] });
  const r = runMeasure({ ROOT: empty.root, RUN: 'run-empty', NOW, richapi_SKILLS_HOME: home() });
  assert.equal(r.status, 2);
  assert.match(r.out, /is empty/);

  const missing = projectWith({ runId: 'run-x', journal: [jline({ runId: 'run-x', rowId: 'a', status: 'ok' })] });
  const r2 = runMeasure({ ROOT: missing.root, RUN: 'nope', NOW, richapi_SKILLS_HOME: home() });
  assert.equal(r2.status, 2);
  assert.match(r2.out, /no journal for run "nope"/);
});

test('a run with journal lines but no ledger lines says nothing was spent', () => {
  const runId = 'run-noledger';
  const journal = [jline({ runId, rowId: CONTACTS[0], endpoint: 'email_finder', status: 'ok', creditsEstimated: 2, provider: 'provider_a' })];
  const p = projectWith({ runId, journal, ledger: [] });
  assert.equal(measure(p).status, 0);
  assert.match(reportOf(p), /Nothing was spent\./);
});

test('a corrupt journal line is surfaced, and coverage is called a lower bound', () => {
  const runId = 'run-corrupt';
  const good = JSON.stringify(jline({ runId, rowId: CONTACTS[0], endpoint: 'email_finder', status: 'ok', creditsEstimated: 2, provider: 'provider_a' }));
  const p = projectWith({ runId, journal: [] });
  p.write(`gtm/runs/${runId}.jsonl`, good + '\n{"row_id":"' + CONTACTS[1] + '","hop":0,"end');
  p.write('gtm/api-calls.jsonl', JSON.stringify(lline({ runId, endpoint: 'email_finder', estimated: 2 })) + '\n');
  measure(p);
  const text = reportOf(p);
  assert.match(text, /Journal health: 1 unreadable line\(s\)/);
  assert.match(text, /LOWER bound/);
  assert.deepEqual(contactLeaks(text), [], 'a salvaged row_id must not reach the report');
});

test('with no RUN given it measures the newest journal and says which', () => {
  const p = fixture({ runId: 'run-only', verifiable: false });
  const r = runMeasure({ ROOT: p.root, NOW, richapi_SKILLS_HOME: home() });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^run        run-only$/m);
});

test('the report and the share artifact are written under gtm/, which is PII-swept', () => {
  const p = fixture({ runId: 'run-paths', verifiable: false });
  measure(p, { SHARE: '1' });
  assert.ok(p.exists('gtm/measure/run-paths-report.md'));
  assert.ok(p.exists('gtm/measure/run-paths-share.md'));
  const raw = readFileSync(join(p.root, 'gtm', 'measure', 'run-paths-report.md'), 'utf8');
  assert.ok(raw.length > 0);
});
