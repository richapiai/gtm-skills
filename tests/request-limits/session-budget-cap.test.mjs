// The session budget was a plan-time estimate check, never a runtime cap.
//
// `checkCall` was reachable from exactly two places, both PRE-execution: `gatePlanFor`
// in _lib/run.mjs and `gatePlan` in _lib/enrich.mjs. During execution spend was only
// ever accumulated — `recordSpend(session, ...)` — and nothing in the pack read
// `session.spent_credits` back to make a decision. It was write-only for the life of a
// run, so the only thing that could stop a runaway was the vendor returning 402.
//
// MEASURED: `richapi search lead_search --param title=CTO --pages 20 --budget 500`
// plans at 450 credits using `assumed_results_per_page: 25` (20 x (10 + 0.5 x 25)).
// If the pages return 500 results each the real charge is 20 x (10 + 250) = 5,200 —
// 10.4x the budget the user set, with every gate green.
//
// THE CAP IS NOT A PROMPT. _lib/run.mjs argues correctly that gate fatigue is why
// gating is plan-time: at ~8 credits a contact a 100-row list would ask dozens of
// times. This stops; it does not ask. The remainder is journalled `skipped_budget`,
// which is REPLANNABLE, so a resume after a raise buys exactly what was left.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { okJson, okWithoutBillingField, insufficientCredits, liveEnrichProfile, liveEmailFinder, liveEmailVerifier } from '../helpers/index.mjs';
import { CATALOG, GATES, fixture, apiOver, fakeHttp } from './helpers.mjs';
import { runSearch, runCall } from '../../_lib/run.mjs';
import { runEnrich } from '../../_lib/enrich.mjs';
import { readJournal } from '../../_lib/journal.mjs';
import { BUDGET_STOP } from '../../_lib/batch.mjs';

/** 500 results a page — the measured shape that makes 450 planned cost 5,200. */
const FAT_PAGE = () => okWithoutBillingField({
  elements: Array.from({ length: 500 }, (_, i) => ({ id: i })),
});

function journalLines (tree, runId) {
  const p = path.join(tree.root, 'gtm', 'runs', `${runId}.jsonl`);
  return readJournal(p).lines;
}

/**
 * A response that reports its OWN charge.
 *
 * `_lib/ledger.mjs` promotes any line carrying `credits_charged` to a verified actual,
 * which is the honest case where a plan-time check cannot save anyone: the plan is
 * costed from the catalog and the API is charging something else. It is also what the
 * catalog itself warns about — 16 of 53 endpoints repriced in four months,
 * `phone_finder` 3 -> 25 credits — so this is the shape of a real overrun, not a
 * contrivance.
 */
const charging = (credits, body = {}) => () => okJson({ ...body, credits_charged: credits });

test('the measured runaway: 5,200 credits on a 500 budget becomes 260', async (t) => {
  const { tree } = fixture(t);
  const fake = fakeHttp({ fallback: FAT_PAGE });

  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 20,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 500, confirm: async () => true,
    stopOnShortPage: false, runId: 'f3-s6-a',
  });

  assert.equal(res.plan.totals.credits_estimated, 450,
    '20 pages x (10 base + 0.5 x the 25-result assumption) — the number the user approved');

  // Before the cap: 20 http calls, 5,200 credits, exec.aborted false.
  assert.equal(res.exec.aborted, true);
  assert.equal(res.exec.abort_reason, 'session_budget');
  assert.ok(res.ledger_totals.ledger_total <= 500 + 260,
    `the run must stop within one call of the budget, spent ${res.ledger_totals.ledger_total}`);
  assert.equal(res.ledger_totals.ledger_total, 260,
    'page one costs 10 + 0.5 x 500; the cap then sees that the next page repeats it and '
    + 'stops at 260 rather than walking to 5,200');
  assert.equal(res.http_calls, 1);
});

test('the cap STOPS, it does not ask', async (t) => {
  const { tree } = fixture(t);
  let asked = 0;
  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 20,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: FAT_PAGE })), budget: 500,
    confirm: async () => { asked += 1; return true; },
    stopOnShortPage: false, runId: 'f3-s6-b',
  });
  assert.equal(res.exec.aborted, true);
  assert.equal(asked, 1,
    'exactly one approval, for the PLAN. Per-call prompting is what gate fatigue kills; '
    + 'a 100-row list at ~8 credits a contact would ask dozens of times');
});

test('the remainder is journalled skipped_budget, not failed, and is replannable', async (t) => {
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 20,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: FAT_PAGE })), budget: 500, confirm: async () => true,
    stopOnShortPage: false, runId: 'f3-s6-c',
  });

  const results = journalLines(tree, 'f3-s6-c').filter((l) => l.status);
  const skipped = results.filter((l) => l.status === 'skipped_budget');
  assert.equal(skipped.length, 19, 'the nineteen pages that were never bought');
  assert.equal(results.filter((l) => l.status === 'failed').length, 0,
    'nothing FAILED — the run was stopped, and a failure would send the user debugging');

  for (const l of skipped) {
    assert.equal(l.error, BUDGET_STOP,
      'the pack\'s own cap must not masquerade as the vendor\'s http_402 — that sends the '
      + 'user to top up an account with plenty in it');
    assert.equal(l.credits_actual, 0);
  }
  assert.equal(res.budget_stop.budget, 500);
  assert.equal(res.exec.skipped_budget, 19);
});

test('a resume after a raise buys exactly the remainder, and nothing twice', async (t) => {
  const { tree } = fixture(t);
  const first = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 4,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: FAT_PAGE })), budget: 500, confirm: async () => true,
    stopOnShortPage: false, runId: 'f3-s6-d',
  });
  assert.equal(first.http_calls, 1);
  assert.equal(first.exec.skipped_budget, 3);

  const fake = fakeHttp({ fallback: FAT_PAGE });
  const second = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 4,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 5000, confirm: async () => true,
    // The resume states the page size the first run was surprised by. Without it the
    // page-size over-delivery stop (25 planned, 500 delivered) would stop the walk at
    // page one again, which is correct and is tested in page-overdelivery.test.mjs —
    // but it is not what THIS test is about, and re-approving the real size is the
    // action the stop's own note tells the user to take.
    pageSize: 500,
    stopOnShortPage: false, runId: 'f3-s6-d', resume: 'f3-s6-d',
  });
  assert.equal(second.http_calls, 3,
    'the three pages the cap stopped, and only those — the first page is TERMINAL_DONE');
  assert.equal(second.exec.aborted, false);
});

test('the run says what stopped it, in words', async (t) => {
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 20,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: FAT_PAGE })), budget: 500, confirm: async () => true,
    stopOnShortPage: false, runId: 'f3-s6-e',
  });
  const note = res.notes.find((n) => n.includes('session budget'));
  assert.ok(note, `expected a budget note, got ${JSON.stringify(res.notes)}`);
  assert.match(note, /BEFORE this call/, 'the point is that nothing else was bought');
  assert.match(note, /260 of 500/);
  assert.match(note, /19 unit\(s\) journalled skipped_budget/);
  assert.match(note, /raise the budget and resume/,
    'a stop the user cannot act on is just a failure');
});

test('the forward estimate learns from what the last call actually cost', async (t) => {
  // THE REASON THE CAP BINDS AT ALL, shown by contrast.
  //
  // The plan prices a lead_search page at 22.5 (10 base + 0.5 x the 25-result
  // assumption). Twenty of those is 450, which FITS a 500 budget — so a cap that only
  // ever forecast 22.5 would wave all twenty through and the run would still cost
  // 5,200. Taking the larger of the plan price and what the LAST call actually cost is
  // what turns the cap from arithmetic into a control.
  // Two separate project trees: the read-through cache is shared per tree, and a
  // second run over the same params in the same tree would be free rather than fat.
  const { tree } = fixture(t);
  const { tree: tree2 } = fixture(t);

  const thin = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 20,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: () => okWithoutBillingField({ elements: Array.from({ length: 25 }, (_, i) => ({ id: i })) }) })),
    budget: 500, confirm: async () => true, stopOnShortPage: false, runId: 'f3-s6-f1',
  });
  assert.equal(thin.exec.aborted, false, 'pages that cost what the plan said run to the end');
  assert.equal(thin.http_calls, 20);
  assert.equal(thin.ledger_totals.ledger_total, 450);

  const fat = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 20,
    root: tree2.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: FAT_PAGE })),
    budget: 500, confirm: async () => true, stopOnShortPage: false, runId: 'f3-s6-f2',
  });
  assert.equal(fat.http_calls, 1,
    'the identical plan, the identical budget — and one call, because the first page '
    + 'proved the forecast wrong. Forecasting 22.5 forever is how 450 becomes 5,200');
  assert.equal(fat.ledger_totals.ledger_total, 260);
});

test('a run comfortably inside its budget is untouched', async (t) => {
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 3,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: () => okWithoutBillingField({ elements: [{ id: 1 }] }) })),
    budget: 5000, confirm: async () => true, stopOnShortPage: false, runId: 'f3-s6-g',
  });
  assert.equal(res.exec.aborted, false);
  assert.equal(res.http_calls, 3);
  assert.equal(res.budget_stop, null);
  assert.equal(res.notes.filter((n) => n.includes('session budget')).length, 0);
});

test('with NO budget set there is nothing to cap, and the run is unchanged', async (t) => {
  // The plan gate already asked for a budget and the user approved the plan without
  // naming one. Refusing every call here would turn "no budget" into "no runs".
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 3,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: FAT_PAGE })), budget: null,
    // Priced at the size the pages really are, so the only thing that could stop this
    // run is a budget — and there is none. See the resume test above.
    pageSize: 500,
    confirm: async () => true, stopOnShortPage: false, runId: 'f3-s6-h',
  });
  assert.equal(res.exec.aborted, false);
  assert.equal(res.http_calls, 3);
});

test('a 402 still aborts as a 402, and is still told apart from the cap', async (t) => {
  const { tree } = fixture(t);
  const res = await runSearch({
    endpoint: 'lead_search', params: { title: 'CTO' }, pages: 5,
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: () => insufficientCredits({ balance: 2 }) })),
    budget: 5000, confirm: async () => true, stopOnShortPage: false, runId: 'f3-s6-i',
  });
  assert.equal(res.exec.aborted, true);
  assert.equal(res.exec.abort_reason, 'insufficient_credits',
    'the vendor saying "you are out" is a different fact from us saying "you said 500"');
  assert.equal(res.budget_stop, null);
  const skipped = journalLines(tree, 'f3-s6-i').filter((l) => l.status === 'skipped_budget');
  assert.ok(skipped.length > 0);
  for (const l of skipped) assert.equal(l.error, 'http_402');
});

test('the cap also binds an enrichment waterfall, hop by hop', async (t) => {
  // The other executor, and the case a plan-time check cannot reach: the plan is costed
  // at the CATALOG's 8 credits a contact, the plan gate passes, and the API then reports
  // 20 credits for the first hop alone.
  const rows = Array.from({ length: 10 }, (_, i) => ({ linkedin_url: `https://linkedin.com/in/p${i}` }));
  const { tree, input } = fixture(t, { rows });
  const fake = fakeHttp({
    routes: [
      ['enrich_profile', charging(20, liveEnrichProfile({ firstname: 'A', lastname: 'B' }))],
      ['email_finder', charging(5, liveEmailFinder({ result: { email: 'a@b.example' } }))],
      ['email_verifier', charging(2, { status: 'valid' })],
    ],
  });

  const res = await runEnrich({
    input, root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 100, confirm: async () => true, runId: 'f3-s6-j',
  });

  assert.equal(res.plan.totals.credits_estimated, 80, '10 contacts x the catalog\'s 8 credits');
  assert.equal(res.exec.aborted, true, 'the plan fitted the budget; the actual charges did not');
  assert.equal(res.exec.abort_reason, 'session_budget');
  assert.equal(res.ledger_totals.ledger_total, 100,
    'stopped ON the budget, not 170 credits past it (10 x 20 for hop one alone, before '
    + 'email_finder and email_verifier were even reached)');
  assert.ok(res.budget_stop, 'the result must say the budget is what stopped it');
  assert.ok(res.exec.skipped_budget > 0);

  const skipped = journalLines(tree, 'f3-s6-j').filter((l) => l.status === 'skipped_budget');
  assert.ok(skipped.length > 0);
  for (const l of skipped) assert.equal(l.error, BUDGET_STOP);
});

test('a row call over many rows is capped too, and stops mid-list', async (t) => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ email: `p${i}@b.example` }));
  const { tree, input } = fixture(t, { rows });
  const fake = fakeHttp({ fallback: charging(10, liveEmailVerifier()) });

  const res = await runCall({
    endpoint: 'email_verifier', input: path.basename(input),
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fake), budget: 100, confirm: async () => true, runId: 'f3-s6-k',
  });

  assert.equal(CATALOG.endpoints.email_verifier.pricing.credits_per_call, 2);
  assert.equal(res.plan.totals.credits_estimated, 80, 'the catalog says 2 a row');
  assert.equal(res.exec.aborted, true);
  assert.equal(res.http_calls, 10, 'the API is charging 10 a row, so 100 credits is ten rows');
  assert.equal(res.ledger_totals.ledger_total, 100);
  assert.equal(res.exec.skipped_budget, 30);
});

test('the output list still holds what the capped run did buy', async (t) => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ email: `p${i}@b.example` }));
  const { tree, input } = fixture(t, { rows });
  const res = await runCall({
    endpoint: 'email_verifier', input: path.basename(input), output: 'out.jsonl',
    root: tree.root, dir: 'gtm', catalog: CATALOG, gates: GATES,
    api: apiOver(fakeHttp({ fallback: charging(10, liveEmailVerifier({ result: { status: 'valid' } })) })),
    budget: 100, confirm: async () => true, runId: 'f3-s6-l',
  });
  assert.equal(res.exec.aborted, true);
  const written = fs.readFileSync(path.join(tree.root, 'out.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(written.length, 40, 'every input row is still written; the un-bought ones are just unenriched');
  // `email_verification_status`, not `email_status`: the verifier's verdict and the
  // finder's ESP status are different facts and stopped sharing a column on 2026-09-02.
  assert.equal(written.filter((r) => r.email_verification_status === 'valid').length, res.http_calls,
    'and exactly the rows that were paid for carry the answer');
});
