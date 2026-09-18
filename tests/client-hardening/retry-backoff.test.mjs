/**
 * `Retry-After` was server-controlled and uncapped, and its absence was worse.
 *
 * The old three lines, identical in _lib/journal.mjs and _lib/batch.mjs:
 *
 *   const waitMs = Number(err.retryAfter ?? 0) * 1000;
 *   const ms = Number.isFinite(waitMs) && waitMs > 0 ? waitMs : 0;
 *   await sleep(ms);
 *
 * Two bugs in one expression, pointing opposite ways:
 *
 *   * `Retry-After: 86400` off the wire hung the CLI for 24 hours per attempt, per
 *     unit — a server-controlled denial of service against its own client;
 *   * no header at all meant `sleep(0)`: three immediate re-hammers per unit, which
 *     makes the rate limit that produced the 429 strictly worse.
 *
 * Both directions are asserted here, at the unit level and end to end through both
 * executors, so neither can come back on its own.
 *
 * Also here: the 60-second AbortController timer used to be cleared in a `finally`
 * around the FETCH, before `await res.json()`. `fetch` resolves on headers; the body
 * streams afterwards. A server that sent headers and then trickled bytes therefore
 * had no deadline at all.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HttpError, retryDelayMs, runWaterfall,
  RETRY_AFTER_MAX_MS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
} from '../../_lib/journal.mjs';
import { runBatchedHop } from '../../_lib/batch.mjs';
import { RichApiClient } from '../../_lib/client.mjs';

/** runWaterfall/runBatchedHop only ever call these two. */
const stubJournal = () => ({ appendPending () {}, appendResult () {} });

const units = (n, endpoint = 'phone_finder') => Array.from({ length: n }, (_, i) => ({
  row_id: `row-${i}`, hop: 0, endpoint, credits_estimated: 25,
}));

// ---------------------------------------------------------------------------
// the policy itself
// ---------------------------------------------------------------------------

test('a hostile Retry-After is CLAMPED, not honoured', () => {
  // The exact value from the finding. 86400s = 24h.
  assert.equal(retryDelayMs(86400, 1), RETRY_AFTER_MAX_MS);
  assert.equal(retryDelayMs('86400', 1), RETRY_AFTER_MAX_MS);
  assert.equal(retryDelayMs(Number.MAX_SAFE_INTEGER, 3), RETRY_AFTER_MAX_MS);
  assert.ok(RETRY_AFTER_MAX_MS <= 60_000, 'the ceiling itself drifted upwards');
});

test('a reasonable Retry-After is still honoured to the second', () => {
  // The clamp must not become a blanket override: the server does know its own window.
  assert.equal(retryDelayMs(2, 1), 2000);
  assert.equal(retryDelayMs(30, 1), 30_000);
  assert.equal(retryDelayMs('12', 2), 12_000);
});

test('an ABSENT Retry-After produces real backoff, never sleep(0)', () => {
  for (const absent of [undefined, null, 0, '0', '', 'soon', NaN, -5, Infinity]) {
    const ms = retryDelayMs(absent, 1);
    assert.ok(ms > 0, `retryDelayMs(${JSON.stringify(absent)}) was ${ms} — the sleep(0) bug is back`);
    assert.ok(ms >= BACKOFF_BASE_MS / 2, `${JSON.stringify(absent)} backed off only ${ms}ms`);
    assert.ok(ms <= BACKOFF_BASE_MS, `${JSON.stringify(absent)} overshot the attempt-1 window: ${ms}ms`);
  }
});

test('backoff grows with the attempt, and stops at a ceiling', () => {
  const floor = (n) => retryDelayMs(null, n, { jitter: () => 0 });
  const roof = (n) => retryDelayMs(null, n, { jitter: () => 1 });

  assert.deepEqual([floor(1), roof(1)], [500, 1000]);
  assert.deepEqual([floor(2), roof(2)], [1000, 2000]);
  assert.deepEqual([floor(3), roof(3)], [2000, 4000]);
  for (let n = 1; n < 8; n += 1) {
    assert.ok(roof(n + 1) >= roof(n), `attempt ${n + 1} did not back off further than ${n}`);
  }
  assert.equal(roof(20), BACKOFF_MAX_MS, 'the exponential has no ceiling');
});

test('the backoff is jittered, so N units do not return in one synchronised wave', () => {
  // A fleet that 429s together and retries together turns a rate limit into a storm.
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(retryDelayMs(null, 2));
  assert.ok(seen.size > 10, `only ${seen.size} distinct delays in 200 draws — the jitter is gone`);
});

// ---------------------------------------------------------------------------
// end to end — the single-call executor
// ---------------------------------------------------------------------------

test('runWaterfall clamps a 24-hour Retry-After off the wire', async () => {
  const waits = [];
  const result = await runWaterfall({
    journal: stubJournal(),
    units: units(1),
    client: { async call () { throw new HttpError(429, { retryAfter: 86400 }); } },
    maxAttempts: 3,
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(waits.length, 2, 'expected two retries before the unit was given up on');
  for (const w of waits) {
    assert.ok(w <= RETRY_AFTER_MAX_MS, `slept ${w}ms — an 86400s Retry-After reached sleep()`);
  }
  assert.equal(result.waited_ms, waits.reduce((a, b) => a + b, 0), 'waited_ms lied about the wait');
  assert.ok(result.waited_ms <= 2 * RETRY_AFTER_MAX_MS);
});

test('runWaterfall backs off for real when the 429 carries no Retry-After', async () => {
  const waits = [];
  await runWaterfall({
    journal: stubJournal(),
    units: units(1),
    client: { async call () { throw new HttpError(429, {}); } },  // no retryAfter at all
    maxAttempts: 3,
    sleep: async (ms) => { waits.push(ms); },
  });

  assert.equal(waits.length, 2);
  assert.deepEqual(waits.filter(w => w === 0), [], 'sleep(0) — the burst-hammer bug is back');
  assert.ok(waits[1] >= waits[0] / 2, 'the second attempt did not back off further');
});

test('Retry-After: 0 is treated as no guidance, not as "hammer me now"', async () => {
  const waits = [];
  await runWaterfall({
    journal: stubJournal(),
    units: units(1),
    client: { async call () { throw new HttpError(429, { retryAfter: 0 }); } },
    maxAttempts: 2,
    sleep: async (ms) => { waits.push(ms); },
  });
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0, `a 429 with Retry-After: 0 slept ${waits[0]}ms`);
});

// ---------------------------------------------------------------------------
// end to end — the batched executor (the same three lines lived here too)
// ---------------------------------------------------------------------------

async function batched429 ({ retryAfter }) {
  const waits = [];
  const err = Object.assign(new Error('429'), { status: 429, retryAfter });
  await runBatchedHop({
    journal: stubJournal(),
    units: units(4, 'enrich_profiles_bulk'),
    client: { async callBulk () { throw err; } },
    bulk: { endpoint: 'enrich_profiles_bulk', maxBatch: 50 },
    maxAttempts: 3,
    sleep: async (ms) => { waits.push(ms); },
  });
  return waits;
}

test('runBatchedHop clamps a hostile Retry-After too', async () => {
  const waits = await batched429({ retryAfter: 86400 });
  assert.equal(waits.length, 2);
  for (const w of waits) assert.ok(w <= RETRY_AFTER_MAX_MS, `batch slept ${w}ms`);
});

test('runBatchedHop backs off for real with no Retry-After', async () => {
  const waits = await batched429({ retryAfter: undefined });
  assert.equal(waits.length, 2);
  assert.deepEqual(waits.filter(w => w === 0), [], 'the batch path still sleeps 0');
});

test('both executors share one policy, so they cannot drift apart', async () => {
  const single = [];
  await runWaterfall({
    journal: stubJournal(),
    units: units(1),
    client: { async call () { throw new HttpError(429, { retryAfter: 45 }); } },
    maxAttempts: 2,
    sleep: async (ms) => { single.push(ms); },
  });
  const batch = await batched429({ retryAfter: 45 });
  assert.equal(single[0], 45_000);
  assert.equal(batch[0], single[0], 'the batched and single paths disagree about Retry-After');
});

// ---------------------------------------------------------------------------
// the unbounded response body
// ---------------------------------------------------------------------------

test('a response whose BODY never arrives is bounded by the client timeout', async () => {
  // Before the fix, clearTimeout ran in a `finally` around the fetch, so the abort
  // timer was already cancelled by the time `await res.json()` started. This test
  // would hang forever rather than fail.
  const client = new RichApiClient({
    apiKey: 'k',
    timeoutMs: 200,
    env: {},
    fetchImpl: (_url, init) => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      // Headers are here; the body never is, until the signal aborts.
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      }),
    }),
  });

  const started = Date.now();
  const raced = await Promise.race([
    client.post('enrich_profile', { url: 'x' }).then(() => 'resolved', (e) => e),
    new Promise((r) => { setTimeout(() => r('HUNG'), 5000); }),
  ]);

  assert.notEqual(raced, 'HUNG', 'the response body was read with no deadline');
  assert.notEqual(raced, 'resolved', 'a timed-out body was returned as a successful empty response');
  assert.ok(raced instanceof HttpError, `expected HttpError, got ${raced?.name}`);
  assert.equal(raced.status, 0);
  assert.ok(Date.now() - started < 4000, 'the timeout fired, but far too late');
});

test('an unparseable but COMPLETE body still degrades to null, as before', () => {
  // The deadline must not turn every non-JSON 200 into an error.
  const client = new RichApiClient({
    apiKey: 'k',
    timeoutMs: 5000,
    env: {},
    fetchImpl: () => Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
    }),
  });
  return client.post('enrich_profile', { url: 'x' }).then((res) => {
    assert.equal(res.status, 200);
    assert.equal(res.body, null);
  });
});
