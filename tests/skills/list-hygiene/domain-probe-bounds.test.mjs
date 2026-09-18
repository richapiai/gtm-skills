// tests/skills/list-hygiene/domain-probe-bounds.test.mjs
//
// Domain liveness is a network probe, not a paid call — so no cost gate sees it and
// nothing else in the pack bounds it. A 5k-row list at a 10s timeout is a 14-hour run.
// Its only bounds are three gate keys, and this file asserts all three of them:
//
//   1. they resolve, and a missing one is STOP rather than "no bound" (law 5)
//   2. their values are usable as bounds at all (finite, positive, ordered)
//   3. the SKILL.md cites every one of them, and states no bound as a bare number
//   4. a scheduler parameterised from the real gate values actually holds the bound —
//      concurrency is never exceeded and a hung probe cannot outlive the timeout

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates, gateValue, hasGate, MissingGateKey, scanForBareNumbers }
  from '../../../_lib/gates.mjs';
import { skillBody } from './helpers.mjs';

const GATES = loadGates();
const NS = 'skills.list_hygiene';
const BOUND_KEYS = [
  `${NS}.domain_probe_timeout_ms`,
  `${NS}.domain_probe_concurrency`,
  `${NS}.max_rows_per_run`,
];

// --- 1 + 2: the bounds exist and are usable --------------------------------

test('every domain-probe bound resolves in the real gates.yaml', () => {
  for (const key of BOUND_KEYS) {
    assert.ok(hasGate(GATES, key), `${key} does not resolve — the probe would read STOP`);
  }
});

test('the bounds are finite positive numbers, so the worst case is computable', () => {
  const timeout = gateValue(GATES, `${NS}.domain_probe_timeout_ms`);
  const conc    = gateValue(GATES, `${NS}.domain_probe_concurrency`);
  const maxRows = gateValue(GATES, `${NS}.max_rows_per_run`);
  for (const [name, v] of [['timeout_ms', timeout], ['concurrency', conc], ['max_rows', maxRows]]) {
    assert.equal(typeof v, 'number', `${name} must be a number`);
    assert.ok(Number.isFinite(v) && v > 0, `${name} must be finite and positive, got ${v}`);
  }
  assert.ok(Number.isInteger(conc) && conc >= 1, 'concurrency must be at least one probe');
  assert.ok(Number.isInteger(maxRows), 'max_rows_per_run must be a whole number of rows');
  // The bound the skill tells the user about: rows / concurrency * timeout.
  const worstCaseMs = Math.ceil(maxRows / conc) * timeout;
  assert.ok(Number.isFinite(worstCaseMs) && worstCaseMs > 0,
    'the stated worst-case wall clock must be computable from the gates alone');
});

test('a dropped bound reads as STOP, never as "unbounded"', () => {
  // Law 5, mechanically: gateValue throws rather than defaulting. A merge that loses
  // the hunk wedges the probe; it does not silently unbound it.
  const partial = { skills: { list_hygiene: { domain_probe_concurrency: 8 } } };
  assert.throws(() => gateValue(partial, `${NS}.domain_probe_timeout_ms`), MissingGateKey);
  assert.throws(() => gateValue(partial, `${NS}.max_rows_per_run`), MissingGateKey);
  assert.equal(hasGate(partial, `${NS}.domain_probe_timeout_ms`), false);
  // An unloadable gates file fails every lookup rather than returning a default.
  const broken = { __unloadable: 'gates.yaml: file not found' };
  for (const key of BOUND_KEYS) assert.throws(() => gateValue(broken, key), MissingGateKey);
});

// --- 3: the skill cites them, and never types one --------------------------

test('the SKILL.md cites all three bounds by their gate key', () => {
  const body = skillBody();
  for (const key of BOUND_KEYS) {
    assert.ok(body.includes(`gates.yaml:${key}`), `SKILL.md does not cite gates.yaml:${key}`);
  }
});

test('every gate key the SKILL.md cites resolves against the real file', () => {
  const body = skillBody();
  const cited = [...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= BOUND_KEYS.length, 'expected the skill to cite its thresholds');
  for (const key of cited) {
    assert.ok(hasGate(GATES, key), `SKILL.md cites gates.yaml:${key}, which does not resolve`);
  }
});

test('the SKILL.md carries no hand-typed threshold anywhere', () => {
  const findings = scanForBareNumbers(skillBody(), { file: 'skills/list-hygiene/SKILL.md' });
  assert.deepEqual(findings, [], findings.map(f => `line ${f.line}: ${f.message}`).join('\n'));
});

test('the SKILL.md refuses an oversized list rather than truncating it', () => {
  const body = skillBody();
  assert.match(body, /refused,\s*\n?\s*not truncated|not truncated/i,
    'a silently truncated list is a list the user believes was cleaned');
});

test('the SKILL.md keeps a timeout distinguishable from a dead domain', () => {
  const body = skillBody();
  assert.match(body, /\bunknown\b/, 'the probe needs a third outcome');
  assert.match(body, /slow is not dead/i,
    'a timeout is a fact about the probe, not about the company');
});

// --- 4: the bound is actually implementable at those values ----------------

/**
 * The documented scheduler, parameterised from the real gates. Kept in the test
 * rather than in _lib because /list-hygiene ships no runtime file — its purpose is to
 * prove the stated bounds hold, not to ship a probe.
 */
async function runBoundedProbe(domains, { concurrency, timeoutMs, probe, clock }) {
  let inFlight = 0, peak = 0;
  const results = new Map();
  const queue = [...domains];
  async function worker() {
    while (queue.length) {
      const d = queue.shift();
      inFlight += 1; peak = Math.max(peak, inFlight);
      const started = clock.now();
      let verdict;
      try {
        verdict = await Promise.race([
          probe(d),
          clock.after(timeoutMs).then(() => 'unknown'), // deadline, never 'dead'
        ]);
      } catch { verdict = 'unknown'; }
      results.set(d, { verdict, ms: clock.now() - started });
      inFlight -= 1;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { results, peak };
}

/** A clock that resolves timers by fast-forwarding, so the test is instant. */
function fakeClock() {
  let t = 0;
  const pending = [];
  const c = {
    now: () => t,
    after(ms) { return new Promise(res => pending.push({ at: t + ms, res })); },
    advance() {
      if (!pending.length) return false;
      const next = Math.min(...pending.map(p => p.at));
      t = next;
      for (const p of pending.splice(0).sort((a, b) => a.at - b.at)) {
        if (p.at <= t) p.res(); else pending.push(p);
      }
      return true;
    },
  };
  return c;
}

test('the probe honours concurrency and the timeout at the real gate values', async () => {
  const concurrency = gateValue(GATES, `${NS}.domain_probe_concurrency`);
  const timeoutMs   = gateValue(GATES, `${NS}.domain_probe_timeout_ms`);
  const clock = fakeClock();

  // Every third domain hangs forever. Without a deadline the run never ends.
  const domains = Array.from({ length: concurrency * 5 }, (_, i) => `d${i}.example`);
  const probe = d => (Number(d.slice(1).split('.')[0]) % 3 === 0
    ? new Promise(() => {})               // hangs
    : Promise.resolve('live'));

  const run = runBoundedProbe(domains, { concurrency, timeoutMs, probe, clock });
  // Drain the fake clock until the run settles. Capped so a broken scheduler fails
  // the assertions below instead of hanging the suite.
  let settled = false;
  run.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; i < 10000 && !settled; i++) {
    await new Promise(r => setImmediate(r));
    clock.advance();
  }
  const { results, peak } = await run;

  assert.equal(results.size, domains.length, 'every domain got a verdict');
  assert.ok(peak <= concurrency,
    `peak in-flight ${peak} exceeded gates.yaml:${NS}.domain_probe_concurrency (${concurrency})`);
  for (const [d, r] of results) {
    assert.ok(r.ms <= timeoutMs, `${d} ran ${r.ms}ms, past the ${timeoutMs}ms deadline`);
    assert.ok(['live', 'unknown'].includes(r.verdict));
  }
  // A hung probe becomes `unknown`, never `dead`.
  const hung = [...results.values()].filter(r => r.verdict === 'unknown');
  assert.ok(hung.length > 0, 'the fixture must actually exercise the deadline');
  assert.ok([...results.values()].every(r => r.verdict !== 'dead'),
    'a timeout must never be recorded as a dead domain');
});

test('a list over max_rows_per_run is refused, not truncated', () => {
  const maxRows = gateValue(GATES, `${NS}.max_rows_per_run`);
  // The documented guard, expressed executably.
  const guard = n => (n > maxRows
    ? { decision: 'stop', reason: `${n} rows exceeds gates.yaml:${NS}.max_rows_per_run` }
    : { decision: 'allow', rows: n });
  assert.equal(guard(maxRows).decision, 'allow');
  assert.equal(guard(maxRows).rows, maxRows, 'a list at the ceiling runs whole');
  assert.equal(guard(maxRows + 1).decision, 'stop');
  // Refusal must not be a silent truncation to the ceiling.
  assert.equal(guard(maxRows + 1).rows, undefined);
});
