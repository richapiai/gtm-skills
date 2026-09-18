// tests/skills/gtm-retro/honesty.test.mjs
//
// A retro is the report most likely to be forwarded to whoever controls the budget, so
// it is the report where a friendly rounding does the most damage. Law 4 binds it:
// eleven of twenty-one metered endpoints never report their charge, so a retro that
// reports spend must report a RANGE, never a single figure.
//
// These tests run the script the SKILL.md actually ships, against fixtures whose ledger
// totals are known, and hold the rendered file against them:
//
//   1. Spend is a range whenever any ledger line is unverifiable, and exact only when
//      none is.
//   2. No figure the report claims exceeds what the raw ledger lines can support —
//      checked against the ledger FILE, not against the same totals the report derived
//      its numbers from. A guard that compares a value with itself is not a guard.
//   3. Rows are never deduplicated across runs. Two runs sharing a row_id must count
//      twice, because `(row_id, hop)` is unique within a run only — the exact reason
//      /measure refuses to roll up.
//   4. Decisions fail closed when the gate keys cannot be read, and appear once they
//      can. The keys are merged now, so the closed half is asserted against a gates
//      FILE with `skills.gtm_retro` stripped back out rather than against the real file
//      happening to lack them — a fail-closed test that expires at the merge was never
//      testing the code, only the file's contents on one particular day.
//   5. Nothing row-shaped or contact-shaped reaches the report.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

import {
  CONTACTS, jline, lline, projectWith, runRetro, withRetroKeys, gatesFileWith,
  armLabelFor, claimedCredits,
} from './helpers.mjs';
import { loadGates, hasGate } from '../../../_lib/gates.mjs';

const RETRO_GATE_KEYS = [
  'retro_max_window_days',
  'min_runs_to_compare',
  'min_rows_per_arm_to_decide',
  'max_decisions',
];

/**
 * A copy of the real gates.yaml with `skills.gtm_retro` DELETED — the law-5 input, made
 * rather than found. Throws on a no-op strip, because a fail-closed test fed a gates
 * file that still holds the block passes while proving nothing.
 */
function gatesFileWithoutRetro (dir) {
  const file = gatesFileWith(dir, (doc) => {
    if (!doc.skills || !('gtm_retro' in doc.skills)) {
      throw new Error('gatesFileWithoutRetro: skills.gtm_retro is not present to strip — has the block moved?');
    }
    delete doc.skills.gtm_retro;
  });
  const doc = parseYaml(readFileSync(file, 'utf8'));
  assert.equal('gtm_retro' in (doc.skills ?? {}), false, 'the strip did not take');
  return file;
}

const NOW = '2026-08-28T12:00:00.000Z';
const AT = '2026-08-20T10:00:00.000Z';

/** Two arms: `alpha` runs well and is partly unverifiable; `beta` runs badly. */
function twoArmProject () {
  const runs = {
    'run-a1': [], 'run-a2': [], 'run-b1': [],
  };
  for (let i = 0; i < 4; i += 1) {
    runs['run-a1'].push(jline({
      runId: 'run-a1', rowId: CONTACTS[i], listKey: 'alpha-list', at: AT,
      status: i < 3 ? 'ok' : 'failed', creditsEstimated: 2, creditsActual: i < 3 ? 2 : null,
    }));
    runs['run-a2'].push(jline({
      runId: 'run-a2', rowId: CONTACTS[i], listKey: 'alpha-list', at: AT,
      status: i < 3 ? 'ok' : 'failed', creditsEstimated: 2, creditsActual: null,
    }));
    runs['run-b1'].push(jline({
      runId: 'run-b1', rowId: CONTACTS[i], listKey: 'beta-list', at: AT,
      status: i < 1 ? 'ok' : 'failed', creditsEstimated: 2, creditsActual: i < 1 ? 2 : null,
    }));
  }
  const ledger = [
    ...Array.from({ length: 3 }, () => lline({ runId: 'run-a1', estimated: 2, actual: 2, costStatus: 'actual', at: AT })),
    ...Array.from({ length: 3 }, () => lline({ runId: 'run-a2', estimated: 2, at: AT })),
    ...Array.from({ length: 1 }, () => lline({ runId: 'run-b1', estimated: 2, actual: 2, costStatus: 'actual', at: AT })),
    // A line from a run OUTSIDE the retro. It must never reach any total.
    lline({ runId: 'run-elsewhere', estimated: 500, actual: 500, costStatus: 'actual', at: AT }),
  ];
  return projectWith({ runs, ledger });
}

const ALPHA = armLabelFor('alpha-list');
const BETA = armLabelFor('beta-list');

// ---------------------------------------------------------------------------
// 1 + 2. The range, and the ceiling
// ---------------------------------------------------------------------------

test('spend is reported as a range, with a floor and a ceiling that differ', () => {
  const p = twoArmProject();
  const gatesFile = withRetroKeys(p.root);
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: gatesFile, OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);

  // Verified actuals: run-a1 3x2 = 6, run-b1 1x2 = 2  -> floor 8
  // Unverifiable:     run-a2 3x2 = 6                  -> ceiling 14
  assert.match(r.stdout, /spend\s+at least 8, up to 14/,
    'the stdout summary must carry the range, not a single figure:\n' + r.out);

  const md = p.read('gtm/retro/r.md');
  assert.match(md, /at least 8 credits and up to 14/,
    'the report must say both ends of the range');
  assert.match(md, /Do not quote the ceiling as a spend and do not average the two/,
    'the report must say how NOT to read the range, because that is the failure mode');
  assert.ok(!/Spent 14 credits/.test(md), 'the ceiling must never be stated as a spend');
  assert.ok(!/Spent 11 credits/.test(md), 'a midpoint must never appear');
});

test('a run whose every line is verified is reported exactly, with no invented range', () => {
  const runs = { 'run-x': [] };
  for (let i = 0; i < 2; i += 1) {
    runs['run-x'].push(jline({
      runId: 'run-x', rowId: CONTACTS[i], listKey: 'exact-list', at: AT,
      status: 'ok', creditsEstimated: 3, creditsActual: 3,
    }));
  }
  const ledger = Array.from({ length: 2 }, () =>
    lline({ runId: 'run-x', estimated: 3, actual: 3, costStatus: 'actual', at: AT }));
  const p = projectWith({ runs, ledger });
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/x.md' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /spend\s+6\b/, 'a fully verified window is stated exactly:\n' + r.out);
  const md = p.read('gtm/retro/x.md');
  assert.match(md, /Spent 6 credits across 1 run\(s\)/);
  assert.ok(!/at least/.test(md.split('## Spend')[1] ?? ''),
    'do not manufacture a range where every line is verified');
});

test('no figure the report claims exceeds what the raw ledger lines support', () => {
  const p = twoArmProject();
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');

  // Recomputed HERE from the ledger file, not read out of the report.
  const raw = p.read('gtm/api-calls.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const inWindow = raw.filter((l) => ['run-a1', 'run-a2', 'run-b1'].includes(l.run_id));
  const cap = inWindow.reduce((s, l) => s + (l.cost_status === 'actual'
    ? Number(l.credits_actual ?? 0)
    : l.cost_status === 'estimated_unverifiable' ? Number(l.credits_estimated ?? 0) : 0), 0);
  assert.equal(cap, 14);

  for (const claimed of claimedCredits(md)) {
    assert.ok(claimed <= cap + 1e-9,
      `the report claims ${claimed} credits, above the ${cap} its ledger lines can support`);
  }
});

test('a ledger line from a run outside the window never reaches a total', () => {
  const p = twoArmProject();          // carries a 500-credit run-elsewhere line
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root),
    RUNS: 'run-a1,run-a2,run-b1', OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');
  assert.ok(!md.includes('500'), 'a run outside the selection leaked into the report');
  assert.ok(!md.includes('run-elsewhere'), 'an unselected run is named in the report');
  for (const claimed of claimedCredits(md)) assert.ok(claimed <= 14);
});

test('the never-overstate guard is called per run and is NOT wrapped in a try', async () => {
  // The guard recomputes from raw ledger lines and throws. A caught throw is a report
  // that ships anyway, which is the failure the guard exists to prevent.
  const src = (await import('./helpers.mjs')).RETRO_SCRIPT();
  assert.match(src, /assertNeverOverstates\(receipt, ledger\)/,
    'the pack guard must be called, not reimplemented');
  const at = src.indexOf('assertNeverOverstates(receipt, ledger)');
  const before = src.slice(Math.max(0, at - 400), at);
  assert.ok(!/try\s*\{[^}]*$/.test(before),
    'assertNeverOverstates must not sit inside a try — a report that cannot be proven is not printed');
});

// ---------------------------------------------------------------------------
// 3. Rows are never deduplicated across runs
// ---------------------------------------------------------------------------

test('two runs sharing a row_id count twice — attempts, never distinct people', () => {
  // This is the exact defect /measure names when it refuses a cross-run rollup. Both
  // runs enrich the SAME four contacts, so a naive dedupe reports 4 and the honest
  // figure is 8 attempts.
  const p = twoArmProject();
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');

  const armRow = md.split('\n').find((l) => l.startsWith('| ' + ALPHA + ' |'));
  assert.ok(armRow, `no table row for arm ${ALPHA}:\n${md}`);
  const cells = armRow.split('|').map((c) => c.trim());
  assert.equal(cells[2], '2', 'the alpha arm holds two runs');
  assert.equal(cells[3], '8',
    'run-a1 and run-a2 enriched the SAME four row_ids. Deduplicating them across runs '
    + 'would report 4 and hand the reader a confident wrong denominator — `(row_id, hop)` '
    + 'is unique within a run only.');
});

test('the report labels the row figure as attempts and says why', () => {
  const p = twoArmProject();
  runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  const md = p.read('gtm/retro/r.md');
  assert.match(md, /row-attempts/, 'the column must not be called contacts or people');
  assert.match(md, /unique within a run only/,
    'the reason must travel with the number, or the next reader deduplicates it');
});

// ---------------------------------------------------------------------------
// 4. Decisions: fail closed, then decide
// ---------------------------------------------------------------------------

test('with skills.gtm_retro stripped the decision half fails closed and names every key', () => {
  // Was: run with no GATES_FILE, back when the real gates.yaml carried no
  // skills.gtm_retro block. It carries one now, so the input is MADE by deleting that
  // block from a copy. Same law-5 path, but it survives this merge and every future one.
  //
  // The exit code is the load-bearing half. A retro that cannot read its floors must
  // exit NON-ZERO: this report is the one most likely to be forwarded to whoever holds
  // the budget, and a zero exit is what a wrapper script reads as "these decisions are
  // safe to act on". Suppressing the decisions while still exiting 0 would be the
  // quietest possible way to hand someone unfounded advice.
  const p = twoArmProject();
  const r = runRetro({ ROOT: p.root, NOW, OUT: 'gtm/retro/r.md',
    GATES_FILE: gatesFileWithoutRetro(p.root) });
  assert.equal(r.status, 3, 'a failed-closed retro exits 3, not 0:\n' + r.out);
  assert.match(r.stdout, /decisions\s+NOT PRODUCED/, r.out);
  const md = p.read('gtm/retro/r.md');
  assert.match(md, /failed closed/i);
  for (const key of RETRO_GATE_KEYS) {
    assert.ok(md.includes(`skills.gtm_retro.${key}`),
      `the missing key skills.gtm_retro.${key} must be named in the report`);
  }
  assert.match(md, /reads as STOP, never/,
    'law 5 must be stated as the reason, so nobody "fixes" it by typing a number in');
  // And the comparison still stands: failing closed suppresses the DECISION, not the report.
  assert.match(md, /## Spend across the window/);
});

test('and on the SHIPPED gates.yaml the same retro no longer fails closed', () => {
  // The counterpart, on the default path with no GATES_FILE at all: the four keys are
  // merged, so the run completes and the report is not a law-5 refusal. Without this
  // the STOP above could be any refusal rather than the missing block specifically.
  const gates = loadGates();
  for (const k of RETRO_GATE_KEYS) {
    assert.ok(hasGate(gates, `skills.gtm_retro.${k}`), `skills.gtm_retro.${k} does not resolve`);
  }
  const p = twoArmProject();
  const r = runRetro({ ROOT: p.root, NOW, OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');
  assert.doesNotMatch(md, /failed closed/i);
  assert.match(md, /## Spend across the window/);
  // Law 4 still binds the merged path. Three of the seven in-window ledger lines are
  // unverifiable, so the spend stays a RANGE rather than hardening into one figure, and
  // no figure it claims may exceed what those lines support. A merged gate key must not
  // become licence to round a spend upward — that is the whole point of this file.
  assert.match(md, /at least 8 credits and up to 14/);
  assert.ok(!/Spent 14 credits/.test(md), 'the ceiling must never be stated as a spend');
  for (const claimed of claimedCredits(md)) {
    assert.ok(claimed <= 14 + 1e-9,
      `the report claims ${claimed} credits, above the 14 its ledger lines can support`);
  }
});

test('with the keys applied, the coverage floor produces a STOP nobody had to type', () => {
  const p = twoArmProject();
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');
  // beta covered 1 of 4 = 25%, below quality_stops.coverage_min_pct.
  assert.match(md, new RegExp('\\*\\*STOP `' + BETA + '`\\*\\*'),
    `the under-covering arm must be stopped:\n${md}`);
  assert.match(md, /gates\.yaml:quality_stops\.coverage_min_pct/,
    'the verdict must cite the key it rests on, not restate the percentage');
  assert.ok(!new RegExp('\\*\\*STOP `' + ALPHA + '`').test(md),
    'the arm above the floor must not be stopped');
});

test('two overlapping cost-per-outcome ranges produce NO winner', () => {
  const p = twoArmProject();
  p.write('outcomes.json', { [ALPHA]: { meetings: 4 }, [BETA]: { meetings: 1 } });
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root),
    OUTCOMES: p.path('outcomes.json'), OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');
  // alpha: 6-12 over 4 meetings = 1.5-3.  beta: 2-2 over 1 = 2.  They overlap.
  assert.match(md, /Not separable/, md);
  assert.match(md, /ranges overlap/, 'say that the ranges overlap, which is the reason');
  assert.ok(!new RegExp('\\*\\*SCALE `' + ALPHA + '`').test(md),
    'an overlapping range is not an ordering, however much it looks like one');
});

test('disjoint ranges DO produce a SCALE and a STOP, so the rule is not vacuous', () => {
  const runs = { 'run-cheap': [], 'run-dear': [] };
  for (let i = 0; i < 3; i += 1) {
    runs['run-cheap'].push(jline({
      runId: 'run-cheap', rowId: CONTACTS[i], listKey: 'cheap-list', at: AT,
      status: 'ok', creditsEstimated: 1, creditsActual: 1,
    }));
    runs['run-dear'].push(jline({
      runId: 'run-dear', rowId: CONTACTS[i], listKey: 'dear-list', at: AT,
      status: 'ok', creditsEstimated: 30, creditsActual: 30,
    }));
  }
  const ledger = [
    ...Array.from({ length: 3 }, () => lline({ runId: 'run-cheap', estimated: 1, actual: 1, costStatus: 'actual', at: AT })),
    ...Array.from({ length: 3 }, () => lline({ runId: 'run-dear', estimated: 30, actual: 30, costStatus: 'actual', at: AT })),
  ];
  const p = projectWith({ runs, ledger });
  const cheap = armLabelFor('cheap-list');
  const dear = armLabelFor('dear-list');
  p.write('outcomes.json', { [cheap]: { meetings: 3 }, [dear]: { meetings: 1 } });

  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root),
    OUTCOMES: p.path('outcomes.json'), OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');
  assert.match(md, new RegExp('\\*\\*SCALE `' + cheap + '`\\*\\*'), md);
  assert.match(md, new RegExp('\\*\\*STOP `' + dear + '`\\*\\*'), md);
  assert.match(md, /SELF-REPORTED/,
    'an outcome the operator typed must never be presented as something the pack observed');
});

test('an arm below the sample floors is never decided, only named', () => {
  const p = twoArmProject();
  const gatesFile = withRetroKeys(p.root, { min_runs_to_compare: 5, min_rows_per_arm_to_decide: 500 });
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: gatesFile, OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  const md = p.read('gtm/retro/r.md');
  assert.match(md, /## Decisions\n\nNone\./, 'no arm clears the floors, so no verdict:\n' + md);
  assert.match(md, /Run it again before judging it/,
    'the honest next step is more sample, and it must be stated');
  assert.match(md, /gates\.yaml:skills\.gtm_retro\.min_runs_to_compare/,
    'name the floor that was not cleared');
});

test('the decision cap is read from the gate file, not from a number in the script', () => {
  const p = twoArmProject();
  const one = withRetroKeys(p.root, { max_decisions: 1 });
  runRetro({ ROOT: p.root, NOW, GATES_FILE: one, OUT: 'gtm/retro/one.md' });
  const md = p.read('gtm/retro/one.md');
  const verdicts = [...md.matchAll(/^- \*\*(STOP|SCALE)/gm)];
  assert.ok(verdicts.length <= 1, `the cap of one was not honoured: ${verdicts.length} verdicts`);

  const zero = gatesFileWith(p.root, (doc) => {
    doc.skills.gtm_retro = { retro_max_window_days: 90, min_runs_to_compare: 1,
      min_rows_per_arm_to_decide: 1, max_decisions: 0 };
  });
  runRetro({ ROOT: p.root, NOW, GATES_FILE: zero, OUT: 'gtm/retro/zero.md' });
  assert.match(p.read('gtm/retro/zero.md'), /## Decisions\n\nNone\./,
    'a cap of zero must suppress every verdict — proof the cap is read, not decorative');
});

// ---------------------------------------------------------------------------
// 5. Nothing row-shaped or contact-shaped reaches the report
// ---------------------------------------------------------------------------

test('no contact from the fixtures appears anywhere in the report', () => {
  const p = twoArmProject();
  runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  const md = p.read('gtm/retro/r.md');
  for (const c of CONTACTS) {
    assert.ok(!md.includes(c), `the contact ${c} reached the report`);
    assert.ok(!md.includes(c.split('@')[1]), `the domain of ${c} reached the report`);
  }
  assert.ok(!/@/.test(md.replace(/[^@]/g, '')) || !/[\w.]+@[\w.]+/.test(md),
    'an email-shaped value reached the report');
});

test('the arm label carries no raw list key and no digit run', () => {
  const p = twoArmProject();
  runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  const md = p.read('gtm/retro/r.md');
  assert.ok(md.includes(ALPHA) && md.includes(BETA), 'the arms must be labelled');
  assert.ok(!md.includes('alpha-list') && !md.includes('beta-list'),
    'the raw list key must never be emitted — it is caller-supplied and routinely a file path');
  for (const label of [ALPHA, BETA]) {
    assert.match(label, /^[A-Za-z][A-Za-z0-9_]{0,63}$/, 'the label must be a bare identifier');
    assert.ok(!/\d/.test(label),
      'a hex label can carry a ten-digit run, which the pack\'s share guard rejects as '
      + 'phone-shaped; the label is mapped onto letters for exactly that reason');
  }
});

test('a journal with no list_key still produces a report, under one honest label', () => {
  const runs = { 'run-nokey': [jline({ runId: 'run-nokey', rowId: CONTACTS[0], at: AT, status: 'ok', creditsEstimated: 1, creditsActual: 1 })] };
  const p = projectWith({ runs, ledger: [lline({ runId: 'run-nokey', estimated: 1, actual: 1, costStatus: 'actual', at: AT })] });
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root), OUT: 'gtm/retro/r.md' });
  assert.equal(r.status, 0, r.out);
  assert.match(p.read('gtm/retro/r.md'), /unassigned/,
    'a run the pack cannot group is labelled unassigned, not silently dropped');
});

test('nothing to compare exits 2 rather than rendering an empty verdict', () => {
  const p = projectWith({ runs: {}, ledger: [] });
  const r = runRetro({ ROOT: p.root, NOW, GATES_FILE: withRetroKeys(p.root) });
  assert.equal(r.status, 2, r.out);
  assert.match(r.stderr, /no run journals to compare/);
});
