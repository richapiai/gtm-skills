/**
 * Run journal + resume.
 *
 * Verify criterion: kill at row 380 of 500, resume pays for 120 rows,
 * not 500. Plus the five named edge cases, each with its own test:
 *   corrupt/truncated final journal line · two concurrent runs over one list ·
 *   partial multi-hop row · 429 storm with Retry-After · 402 mid-run.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ConcurrentRunError,
  HttpError,
  JournalContractError,
  RunJournal,
  acquireListLock,
  chargedUnits,
  planResume,
  readJournal,
  runWaterfall,
  sha256,
  summarize,
  unitKey,
} from '../../_lib/journal.mjs';
import { catalogFixture } from './fixtures/catalog.fixture.mjs';
import { assertValid, loadSchema } from './fixtures/schema-check.mjs';
import { tmpGtmDir } from './fixtures/tmp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const JOURNAL_SCHEMA = loadSchema(path.join(repoRoot, '_lib/contracts/journal-line.schema.json'));

const PHONE_CREDITS = catalogFixture.endpoints.phone_finder.pricing.credits_per_call; // 25

const rowId = (n) => `row-${String(n).padStart(4, '0')}`;

function phoneUnits(count, { from = 1 } = {}) {
  return Array.from({ length: count }, (_, i) => ({
    row_id: rowId(from + i),
    hop: 0,
    endpoint: 'phone_finder',
    credits_estimated: PHONE_CREDITS,
  }));
}

/** A client that always succeeds and counts its calls. */
function okClient({ provider = 'vendor_a', confidence = 0.91, creditsActual = null } = {}) {
  const calls = [];
  return {
    calls,
    async call(ctx) {
      calls.push(ctx);
      return {
        body: { found: true, for: ctx.row_id },
        provider,
        confidence,
        credits_actual: creditsActual,
      };
    },
  };
}

/**
 * A kill mid-call is exactly this journal state: the BEFORE line is on disk and the
 * AFTER line never arrived. Reproduced directly so the test is deterministic.
 */
function simulateKillDuringCall(journal, unit) {
  journal.appendPending(unit, { attempt: 1 });
}

// ---------------------------------------------------------------------------

test('kill at row 380 of 500 — resume pays for 120 rows, not 500', async () => {
  const dir = tmpGtmDir('t6-resume');
  const plan = phoneUnits(500);
  assert.equal(
    plan.reduce((s, u) => s + u.credits_estimated, 0),
    12500,
    'sanity: a 500-row phone pass is the 12,500-credit case from the plan',
  );

  // --- run 1: dies while calling row 381 ---
  const journal1 = new RunJournal({ runId: 'run-alpha', dir });
  const client1 = okClient();
  await runWaterfall({ journal: journal1, units: plan.slice(0, 380), client: client1 });
  simulateKillDuringCall(journal1, plan[380]);

  assert.equal(client1.calls.length, 380);
  const afterKill = readJournal(journal1.path);
  assert.equal(afterKill.corrupt.length, 0);

  // --- resume ---
  const resume = planResume({ lines: afterKill.lines, corrupt: afterKill.corrupt, units: plan });
  assert.equal(resume.stats.units_done, 380);
  assert.equal(resume.todo.length, 120, 'resume re-plans 120 rows');
  assert.equal(resume.stats.credits_estimated_remaining, 120 * PHONE_CREDITS);
  assert.equal(resume.stats.credits_estimated_remaining, 3000);
  assert.notEqual(resume.stats.credits_estimated_remaining, 12500);
  assert.equal(resume.todo[0].row_id, rowId(381), 'resume restarts at the row that was in flight');

  // The one row that was in flight is disclosed, not hidden.
  assert.equal(resume.stats.suspect_max_double_charge_rows, 1);
  assert.deepEqual(resume.suspect, [
    { row_id: rowId(381), hop: 0, reason: 'orphan_pending_killed_mid_call' },
  ]);

  // --- run 2 executes only the remainder ---
  const journal2 = new RunJournal({ runId: 'run-alpha-resume', dir });
  const client2 = okClient();
  await runWaterfall({ journal: journal2, units: resume.todo, client: client2 });
  assert.equal(client2.calls.length, 120, 'the resume makes 120 calls, not 500');
  assert.equal(chargedUnits(readJournal(journal2.path).lines).credits, 3000);

  // Across both runs every row is done exactly once.
  const combined = [...afterKill.lines, ...readJournal(journal2.path).lines];
  const charged = chargedUnits(combined);
  assert.equal(charged.calls, 500);
  assert.equal(charged.credits, 12500, 'no row is paid for twice');
});

test('every line written conforms to the FROZEN journal-line schema', async () => {
  const dir = tmpGtmDir('t6-contract');
  const journal = new RunJournal({ runId: 'run-contract', dir });
  await runWaterfall({
    journal,
    units: [
      ...phoneUnits(2),
      { row_id: 'row-cache', hop: 0, endpoint: 'phone_finder', credits_estimated: 0, skip: 'cache' },
      { row_id: 'row-supp', hop: 0, endpoint: 'phone_finder', credits_estimated: 0, skip: 'suppressed' },
    ],
    client: okClient({ creditsActual: 25 }),
  });
  const { lines, corrupt } = readJournal(journal.path);
  assert.equal(corrupt.length, 0);
  assert.ok(lines.length >= 6);
  for (const line of lines) assertValid(line, JOURNAL_SCHEMA, 'journal line');
});

test('a line is written BEFORE and AFTER each call', async () => {
  const dir = tmpGtmDir('t6-before-after');
  const journal = new RunJournal({ runId: 'run-ba', dir });
  await runWaterfall({ journal, units: phoneUnits(1), client: okClient() });
  const { lines } = readJournal(journal.path);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].status, 'pending');
  assert.equal(lines[0].attempt, 1);
  assert.equal(lines[1].status, 'ok');
  assert.ok(Date.parse(lines[1].ts) >= Date.parse(lines[0].ts));
});

test('provider and confidence are recorded per hop (the input to /learn)', async () => {
  const dir = tmpGtmDir('t6-provider');
  const journal = new RunJournal({ runId: 'run-learn', dir });
  await runWaterfall({
    journal,
    units: [{ row_id: 'r1', hop: 1, endpoint: 'email_finder', credits_estimated: 5 }],
    client: okClient({ provider: 'vendor_b', confidence: 0.42 }),
  });
  const ok = readJournal(journal.path).lines.find((l) => l.status === 'ok');
  assert.equal(ok.provider, 'vendor_b');
  assert.equal(ok.confidence, 0.42);
});

test('the journal stores a response HASH, never the response body', async () => {
  const dir = tmpGtmDir('t6-pii');
  const journal = new RunJournal({ runId: 'run-hash', dir });
  const body = { email: 'ada@example.com', phone: '+1 555 010 9988' };
  await runWaterfall({
    journal,
    units: [{ row_id: 'r1', hop: 0, endpoint: 'email_finder', credits_estimated: 5 }],
    client: { async call() { return { body, provider: 'vendor_a' }; } },
  });
  const raw = fs.readFileSync(journal.path, 'utf8');
  assert.ok(!raw.includes('ada@example.com'), 'no contact value reaches the journal file');
  assert.ok(!raw.includes('555 010 9988'));
  const ok = readJournal(journal.path).lines.find((l) => l.status === 'ok');
  assert.equal(ok.response_hash, sha256(body));
  assert.match(ok.response_hash, /^[a-f0-9]{64}$/);
});

test('append refuses any field the frozen schema does not declare', () => {
  const dir = tmpGtmDir('t6-refuse');
  const journal = new RunJournal({ runId: 'run-refuse', dir });
  const base = { row_id: 'r1', hop: 0, endpoint: 'email_finder', status: 'ok' };
  assert.throws(
    () => journal.append({ ...base, email: 'ada@example.com' }),
    (err) => err instanceof JournalContractError && /not in journal-line.schema.json/.test(err.message),
  );
  // An error MESSAGE could carry a contact, so only short codes are accepted.
  assert.throws(
    () => journal.append({ ...base, status: 'failed', error: 'no email found for ada@example.com' }),
    JournalContractError,
  );
  assert.throws(
    () => journal.append({ ...base, response_hash: JSON.stringify({ email: 'ada@example.com' }) }),
    JournalContractError,
  );
  assert.equal(fs.existsSync(journal.path), false, 'nothing was written');
});

// --- edge case 1 -----------------------------------------------------------

test('edge case: a corrupt / truncated final journal line does not wedge the resume', () => {
  const dir = tmpGtmDir('t6-corrupt');
  const journal = new RunJournal({ runId: 'run-corrupt', dir });
  const plan = phoneUnits(6);
  for (const unit of plan.slice(0, 5)) {
    journal.appendPending(unit, { attempt: 1 });
    journal.appendResult(unit, { status: 'ok', credits_actual: 25, attempt: 1 });
  }
  // A kill during the write of row 6's pending line leaves a partial, newline-less tail.
  const partial = JSON.stringify({
    schema_version: 1, run_id: 'run-corrupt', row_id: rowId(6), hop: 0,
    endpoint: 'phone_finder', status: 'pending', ts: new Date().toISOString(),
  }).slice(0, 90);
  fs.appendFileSync(journal.path, partial);

  const read = readJournal(journal.path);
  assert.equal(read.lines.length, 10, 'the 10 intact lines survive');
  assert.equal(read.corrupt.length, 1);
  assert.equal(read.truncatedTail, true);
  assert.equal(read.corrupt[0].salvaged.row_id, rowId(6), 'the damaged tail still names its row');

  const resume = planResume({ lines: read.lines, corrupt: read.corrupt, units: plan });
  assert.equal(resume.stats.units_done, 5);
  assert.equal(resume.todo.length, 1);
  assert.equal(resume.todo[0].row_id, rowId(6));
  assert.ok(
    resume.suspect.some((s) => s.row_id === rowId(6) && s.reason === 'corrupt_journal_line'),
    'the row touched by corruption is disclosed as a possible double-charge',
  );
});

test('edge case: corruption in the MIDDLE of the journal is skipped, not fatal', () => {
  const dir = tmpGtmDir('t6-corrupt-mid');
  const journal = new RunJournal({ runId: 'run-corrupt2', dir });
  const plan = phoneUnits(3);
  journal.appendPending(plan[0], { attempt: 1 });
  journal.appendResult(plan[0], { status: 'ok', attempt: 1 });
  fs.appendFileSync(journal.path, '{"schema_version":1,"row_id":"row-0002",\n');
  journal.appendPending(plan[2], { attempt: 1 });
  journal.appendResult(plan[2], { status: 'ok', attempt: 1 });

  const read = readJournal(journal.path);
  assert.equal(read.lines.length, 4);
  assert.equal(read.corrupt.length, 1);
  const resume = planResume({ lines: read.lines, corrupt: read.corrupt, units: plan });
  assert.deepEqual(resume.todo.map((u) => u.row_id), [rowId(2)]);
});

// --- edge case 2 -----------------------------------------------------------

test('edge case: two concurrent runs over one list — the second is refused and told what to resume', () => {
  const dir = tmpGtmDir('t6-concurrent');
  const listKey = 'gtm/lists/q3-icp.csv';
  const first = acquireListLock({ dir, listKey, runId: 'run-first' });

  assert.throws(
    () => acquireListLock({ dir, listKey, runId: 'run-second' }),
    (err) => err instanceof ConcurrentRunError
      && err.held_run_id === 'run-first'
      && /double-charge/.test(err.message),
  );

  first.release();
  const third = acquireListLock({ dir, listKey, runId: 'run-third' });
  assert.ok(third.path, 'once the first run releases, a new run may start');
  third.release();

  // A different list is unaffected.
  const other = acquireListLock({ dir, listKey: 'gtm/lists/other.csv', runId: 'run-other' });
  other.release();
});

test('edge case: concurrent appends to one journal file never interleave inside a line', async () => {
  const dir = tmpGtmDir('t6-concurrent-write');
  const a = new RunJournal({ runId: 'run-shared', dir });
  const b = new RunJournal({ runId: 'run-shared', dir });
  assert.equal(a.path, b.path);

  const unitsA = phoneUnits(50, { from: 1 });
  const unitsB = phoneUnits(50, { from: 101 });
  await Promise.all([
    runWaterfall({ journal: a, units: unitsA, client: okClient() }),
    runWaterfall({ journal: b, units: unitsB, client: okClient() }),
  ]);

  const read = readJournal(a.path);
  assert.equal(read.corrupt.length, 0, 'every line is well-formed JSON');
  assert.equal(read.lines.length, 200);
  const units = summarize(read.lines);
  assert.equal(units.size, 100);
  for (const unit of units.values()) assert.equal(unit.status, 'ok');
});

// --- edge case 3 -----------------------------------------------------------

test('edge case: a partial multi-hop row (email found, phone failed) re-plans only the failed hop', async () => {
  const dir = tmpGtmDir('t6-partial');
  const journal = new RunJournal({ runId: 'run-partial', dir });
  const units = [
    { row_id: 'r1', hop: 1, endpoint: 'email_finder', credits_estimated: 5 },
    { row_id: 'r1', hop: 2, endpoint: 'phone_finder', credits_estimated: 25 },
  ];
  await runWaterfall({
    journal,
    units,
    client: {
      async call(ctx) {
        if (ctx.endpoint === 'phone_finder') throw new HttpError(404);
        return { body: { ok: true }, provider: 'vendor_a', confidence: 0.9 };
      },
    },
  });

  const read = readJournal(journal.path);
  const resume = planResume({ lines: read.lines, units });
  assert.equal(resume.done.length, 1);
  assert.equal(resume.done[0].hop, 1, 'the email hop is done and is never re-charged');
  assert.equal(resume.todo.length, 1);
  assert.equal(resume.todo[0].hop, 2, 'only the phone hop is re-planned');
  assert.equal(
    resume.stats.credits_estimated_remaining, 25,
    'the resume costs 25 credits, not the 30 a full re-run would',
  );
  assert.equal(chargedUnits(read.lines).credits, 5, 'the failed phone hop is charged nothing');
});

// --- edge case 4 -----------------------------------------------------------

test('edge case: a 429 storm with Retry-After — a retried row is not double-counted', async () => {
  const dir = tmpGtmDir('t6-429');
  const journal = new RunJournal({ runId: 'run-429', dir });
  const waits = [];
  let attempts = 0;
  const client = {
    async call() {
      attempts += 1;
      if (attempts <= 2) throw new HttpError(429, { retryAfter: 2 });
      return { body: { ok: true }, provider: 'vendor_a', credits_actual: 25 };
    },
  };

  const result = await runWaterfall({
    journal,
    units: phoneUnits(1),
    client,
    maxAttempts: 3,
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(result.retries, 2);
  assert.equal(result.ok, 1);
  assert.deepEqual(waits, [2000, 2000], 'Retry-After is honoured, in seconds');

  const { lines } = readJournal(journal.path);
  assert.deepEqual(
    lines.map((l) => [l.status, l.attempt, l.error]),
    [
      ['pending', 1, null], ['failed', 1, 'http_429'],
      ['pending', 2, null], ['failed', 2, 'http_429'],
      ['pending', 3, null], ['ok', 3, null],
    ],
  );
  const charged = chargedUnits(lines);
  assert.equal(charged.calls, 1, 'three HTTP attempts, one charged unit');
  assert.equal(charged.credits, 25, 'not 75');
});

test('edge case: a 429 storm that never clears charges nothing and stays resumable', async () => {
  const dir = tmpGtmDir('t6-429-storm');
  const journal = new RunJournal({ runId: 'run-429-storm', dir });
  const units = phoneUnits(10);
  const result = await runWaterfall({
    journal,
    units,
    client: { async call() { throw new HttpError(429, { retryAfter: 1 }); } },
    maxAttempts: 3,
    sleep: async () => {},
  });

  assert.equal(result.ok, 0);
  assert.equal(result.failed, 10);
  const { lines } = readJournal(journal.path);
  assert.equal(chargedUnits(lines).credits, 0, 'a 429 is never a charge');

  // maxAttempts is per (row, hop) and survives the process boundary: after three
  // attempts on disk, a fresh resume reports the row exhausted rather than looping.
  const resume = planResume({ lines, units, maxAttempts: 3 });
  assert.equal(resume.todo.length, 0);
  assert.equal(resume.exhausted.length, 10);
  assert.equal(resume.exhausted[0].error, 'http_429');
  const lenient = planResume({ lines, units, maxAttempts: 5 });
  assert.equal(lenient.todo.length, 10, 'raising maxAttempts re-plans them');
});

// --- edge case 5 -----------------------------------------------------------

test('edge case: a 402 mid-run aborts, journals the remainder as skipped_budget, and resumes after a top-up', async () => {
  const dir = tmpGtmDir('t6-402');
  const journal = new RunJournal({ runId: 'run-402', dir });
  const units = phoneUnits(10);
  let n = 0;
  const client = {
    async call() {
      n += 1;
      if (n === 4) throw new HttpError(402, { body: { balance: 12, reserved: 0 } });
      return { body: { ok: true }, credits_actual: 25, provider: 'vendor_a' };
    },
  };

  const result = await runWaterfall({ journal, units, client });
  assert.equal(result.aborted, true);
  assert.equal(result.abort_reason, 'insufficient_credits');
  assert.equal(result.balance, 12, 'the 402 body yields the balance for free');
  assert.equal(result.calls_made, 4, 'no call is attempted after the 402');
  assert.equal(result.skipped_budget, 6);

  const { lines } = readJournal(journal.path);
  const state = summarize(lines);
  assert.equal(state.get(unitKey(rowId(4), 0)).status, 'failed');
  assert.equal(state.get(unitKey(rowId(4), 0)).error, 'http_402');
  assert.equal(state.get(unitKey(rowId(10), 0)).status, 'skipped_budget');
  assert.equal(chargedUnits(lines).credits, 75, 'only the three rows that succeeded are charged');

  // After a top-up: the failed row and every budget-skipped row come back.
  const resume = planResume({ lines, units });
  assert.equal(resume.stats.units_done, 3);
  assert.equal(resume.todo.length, 7);
  assert.equal(resume.stats.credits_estimated_remaining, 175);

  const journal2 = new RunJournal({ runId: 'run-402-resume', dir });
  const client2 = okClient({ creditsActual: 25 });
  await runWaterfall({ journal: journal2, units: resume.todo, client: client2 });
  assert.equal(client2.calls.length, 7, 'the resume pays for 7 rows, not 10');
});

// --- resume semantics, stated explicitly -----------------------------------

test('resume semantics: ok / skipped_cache / skipped_suppressed are terminal; failed / skipped_budget / orphan pending are not', () => {
  const dir = tmpGtmDir('t6-semantics');
  const journal = new RunJournal({ runId: 'run-sem', dir });
  const cases = [
    ['ok', false],
    ['skipped_cache', false],
    ['skipped_suppressed', false],
    ['failed', true],
    ['skipped_budget', true],
  ];
  const units = cases.map(([status], i) => ({
    row_id: `r${i}`, hop: 0, endpoint: 'phone_finder', credits_estimated: 25, status,
  }));
  cases.forEach(([status], i) => {
    journal.append({
      row_id: `r${i}`, hop: 0, endpoint: 'phone_finder', status, credits_estimated: 25, attempt: 1,
    });
  });
  const resume = planResume({ lines: readJournal(journal.path).lines, units, maxAttempts: 3 });
  const replanned = new Set(resume.todo.map((u) => u.row_id));
  cases.forEach(([status, shouldReplan], i) => {
    assert.equal(replanned.has(`r${i}`), shouldReplan, `${status} replanned=${shouldReplan}`);
  });
});

// ---------------------------------------------------------------------------
// A 200 that says it was not billed is not a success.
//
// Live 2026-09-17 (post-call-follow-up): email_finder returned HTTP 200 with
// {ok:false, billed:false, why:"2/5 providers returned an error — retry later"}.
// runWaterfall journalled `ok`, which is TERMINAL_DONE — so a resume never retried
// those rows and the run reported them as genuine not-founds. `failed` with the
// short code `provider_error` is REPLANNABLE, which is what "retry later" asks for.
// ---------------------------------------------------------------------------

test('a 200 whose body says billed:false is a provider error, and a resume RETRIES it', async () => {
  const dir = tmpGtmDir('t6-provider-error');
  const plan = phoneUnits(3);

  const journal1 = new RunJournal({ runId: 'run-pe-1', dir });
  const res = await runWaterfall({
    journal: journal1,
    units: plan,
    client: {
      async call(ctx) {
        return ctx.row_id === rowId(2)
          ? { body: { found: true, for: ctx.row_id } }
          : { body: { ok: false, result: null, billed: false, why: '2/5 providers returned an error — retry later' } };
      },
    },
  });

  assert.equal(res.provider_error, 2, 'counted apart from a genuine failure');
  assert.equal(res.ok, 1, 'only the row the provider actually answered');
  assert.equal(res.failed, 2);

  const { lines } = readJournal(journal1.path);
  for (const line of lines) assertValid(JOURNAL_SCHEMA, line);
  const terminal = lines.filter((l) => l.status !== 'pending');
  assert.equal(terminal.filter((l) => l.error === 'provider_error').length, 2);
  // Nothing was billed, so nothing may be charged for those rows.
  for (const l of terminal.filter((l) => l.error === 'provider_error')) {
    assert.equal(l.credits_actual, 0);
  }
  assert.equal(chargedUnits(lines).calls, 1, 'one unit was actually answered and billed');

  // The point of the fix: the two rows come back on a resume.
  const resume = planResume({ ...readJournal(journal1.path), units: plan });
  assert.deepEqual(resume.todo.map((u) => u.row_id).sort(), [rowId(1), rowId(3)]);
  assert.equal(resume.done.length, 1);
  assert.equal(resume.stats.credits_estimated_remaining, PHONE_CREDITS * 2);
});
