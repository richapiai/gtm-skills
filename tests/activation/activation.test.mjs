// Activation instrumentation and kill/scale bands.
//
// Two properties matter more than any individual counter:
//
//   1. NO NETWORK CALL, EVER. Asserted twice: at the source level (the module does
//      not contain a client) and at runtime (globalThis.fetch is replaced with a
//      throwing stub for the whole suite).
//   2. INSTRUMENTATION DARK READS YELLOW, NEVER RED. A kill/scale band is a decision
//      to stop building. "We have no data" must never render as "it failed".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackedTmp, makeGtmTree, createFakeHttp, okJson } from '../helpers/index.mjs';
import {
  ACTIVATION_FILE, GATE_KEYS, GREEN, YELLOW, RED,
  activationPath, activationEnabled, readActivation,
  recordInstall, recordRun, createActivationRecorder, nullActivationRecorder,
  snapshot, bandFor, evaluateBands, localCohort, renderActivation,
} from '../../_lib/activation.mjs';
import { loadGates, gateValue } from '../../_lib/gates.mjs';
import { runEnrich, loadCatalog } from '../../_lib/enrich.mjs';
import { RichApiClient } from '../../_lib/client.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const CATALOG = loadCatalog(REPO);
const LIB = path.join(REPO, '_lib', 'activation.mjs');

// A fetch that cannot be called. Any network attempt anywhere in this file is a
// hard failure, not a counter that happens to read zero.
const realFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('NETWORK VIOLATION: activation instrumentation attempted a network call'); };
process.on('exit', () => { globalThis.fetch = realFetch; });

const store = () => path.join(trackedTmp('s5-activation-'), ACTIVATION_FILE);

/**
 * A store path that cannot be created on ANY OS, by ANY user: its parent is a regular
 * FILE, so mkdir fails with ENOTDIR — for root too, which a chmod-based fixture would
 * not survive.
 *
 * NOT a path under /proc. On Linux /proc exists, and `fs.mkdirSync(p, { recursive:
 * true })` under procfs never returns: the child mkdir answers ENOENT, the parent
 * answers EEXIST, and node retries the child forever inside native code where no
 * timeout and no debugger can reach it. On macOS the same call throws at once, which
 * is why this passed locally and hung every CI matrix row for six hours on 2026-09-02.
 */
const unwritableStore = () => {
  const blocker = path.join(trackedTmp('s5-unwritable-'), 'not-a-directory');
  fs.writeFileSync(blocker, '');
  return path.join(blocker, 'deeper', ACTIVATION_FILE);
};
const at = (iso) => () => new Date(iso);

// ---------------------------------------------------------------------------
// 1. The no-network guarantee
// ---------------------------------------------------------------------------

test('the activation module contains no network client at all', () => {
  const src = fs.readFileSync(LIB, 'utf8');
  // Strip comments first: the file talks ABOUT not making network calls, and the
  // prose must not be what makes this pass or fail.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket', 'node:http', 'node:https', 'node:net', 'node:dgram', 'node:dns', 'child_process', 'undici', 'navigator.sendBeacon']) {
    assert.ok(!code.includes(forbidden), `_lib/activation.mjs must not reference ${forbidden}`);
  }
  // And the import list is builtins plus exactly one local module.
  const imports = [...code.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual([...new Set(imports)], ['./ledger.mjs', 'node:crypto', 'node:fs', 'node:path']);
});

test('recording an install and two runs makes no network call', (t) => {
  const file = store();
  recordInstall({ file, now: at('2026-08-01T00:00:00.000Z'), version: '2.0.0-alpha.0' });
  recordRun({ file, mode: 'dry-run', now: at('2026-08-01T02:00:00.000Z') });
  recordRun({ file, mode: 'run', calls: 4, wroteOutput: true, now: at('2026-08-03T02:00:00.000Z') });
  // globalThis.fetch throws for this whole file; reaching here is the assertion.
  assert.ok(fs.existsSync(file));
});

// ---------------------------------------------------------------------------
// 2. Metric A — install -> first run
// ---------------------------------------------------------------------------

test('install->first-run is measured, and the install stamp never moves', (t) => {
  const file = store();
  recordInstall({ file, now: at('2026-08-01T00:00:00.000Z') });
  // A second install (an upgrade, a re-run of setup) must not reset the clock, or
  // install->first-run always looks instant and the metric is worthless.
  recordInstall({ file, now: at('2026-08-05T00:00:00.000Z') });
  assert.equal(readActivation(file).installed_at, '2026-08-01T00:00:00.000Z');

  const s0 = snapshot(readActivation(file));
  assert.equal(s0.reached_first_run, false);
  assert.equal(s0.install_to_first_run_hours, null, 'never run is null, not zero');

  recordRun({ file, mode: 'dry-run', now: at('2026-08-01T06:00:00.000Z') });
  const s1 = snapshot(readActivation(file));
  assert.equal(s1.reached_first_run, true);
  assert.equal(s1.install_to_first_run_hours, 6);
  assert.equal(s1.first_run_mode, 'dry-run');
});

test('a first run with no prior install stamp still records, and self-heals', (t) => {
  // Install stamping happens in `setup`, which a user can skip by running the CLI
  // straight out of npx. That must produce a usable record, not a crash.
  const file = store();
  recordRun({ file, mode: 'run', calls: 2, now: at('2026-08-02T00:00:00.000Z') });
  const s = snapshot(readActivation(file));
  assert.equal(s.installed_at, '2026-08-02T00:00:00.000Z');
  assert.equal(s.install_to_first_run_hours, 0);
  assert.equal(s.reached_first_run, true);
});

// ---------------------------------------------------------------------------
// 3. Metric B — first run -> second run
// ---------------------------------------------------------------------------

test('first-run->second-run is measured in days, and only the SECOND run sets it', (t) => {
  const file = store();
  recordInstall({ file, now: at('2026-08-01T00:00:00.000Z') });
  recordRun({ file, mode: 'dry-run', now: at('2026-08-01T01:00:00.000Z') });
  assert.equal(snapshot(readActivation(file)).reached_second_run, false);

  recordRun({ file, mode: 'run', calls: 3, wroteOutput: true, now: at('2026-08-04T01:00:00.000Z') });
  const s = snapshot(readActivation(file));
  assert.equal(s.reached_second_run, true);
  assert.equal(s.first_to_second_run_days, 3);

  // A third run must not move the second-run stamp.
  recordRun({ file, mode: 'run', calls: 1, now: at('2026-08-20T01:00:00.000Z') });
  assert.equal(snapshot(readActivation(file)).first_to_second_run_days, 3);
  assert.equal(snapshot(readActivation(file)).runs_total, 3);
});

test('"ran the CLI" and "got the thing" are counted separately', (t) => {
  const file = store();
  recordRun({ file, mode: 'dry-run', calls: 0, wroteOutput: false, now: at('2026-08-01T00:00:00Z') });
  recordRun({ file, mode: 'blocked', calls: 0, wroteOutput: false, now: at('2026-08-01T01:00:00Z') });
  recordRun({ file, mode: 'run', calls: 6, wroteOutput: true, now: at('2026-08-01T02:00:00Z') });
  const s = snapshot(readActivation(file));
  assert.equal(s.runs_total, 3);
  assert.equal(s.paid_runs_total, 1, 'a dry run and a blocked run spend nothing');
  assert.equal(s.outputs_written, 1, 'the activation event is a FILE, not a command');
  assert.deepEqual(readActivation(file).runs_by_mode, { 'dry-run': 1, blocked: 1, run: 1 });
});

// ---------------------------------------------------------------------------
// 4. Law 7 — counts and timestamps only
// ---------------------------------------------------------------------------

test('the store holds counts and timestamps, never row-level data', (t) => {
  const file = store();
  recordRun({ file, mode: 'run', calls: 3, wroteOutput: true, now: at('2026-08-01T00:00:00Z') });
  const raw = readActivation(file);
  const blob = JSON.stringify(raw);

  // Every leaf is a number, a boolean, null, an ISO timestamp, a mode name, the
  // install uuid, or the pack version. Nothing else is allowed in.
  const allowedStrings = new Set([...Object.keys(raw.runs_by_mode ?? {}), raw.install_id, raw.pack_version].filter(Boolean));
  const walk = (v) => {
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(v) || allowedStrings.has(v),
        `unexpected string in the activation store: ${JSON.stringify(v)}`);
      return;
    }
    for (const x of Object.values(v)) walk(x);
  };
  walk(raw);

  for (const f of ['@', 'linkedin.com', '.csv', '/Users/', 'acme']) {
    assert.ok(!blob.includes(f), `possible PII in the activation store: ${f}`);
  }
});

test('the store is NOT under gtm/, because gtm/ is erased and TTL-swept', () => {
  assert.equal(activationPath('/tmp/example-state'), path.join('/tmp/example-state', ACTIVATION_FILE));
  // The real default follows the ledger's state dir, which is install-scoped.
  const def = activationPath();
  assert.ok(!def.split(path.sep).includes('gtm'),
    'an install metric that /comply erase deletes cannot measure install->first-run');
  assert.equal(path.basename(def), ACTIVATION_FILE);
});

// ---------------------------------------------------------------------------
// 5. Robustness — telemetry must never wedge a run
// ---------------------------------------------------------------------------

test('a corrupt store is treated as absent and rewritten, never thrown', (t) => {
  const file = store();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json at all');
  assert.equal(readActivation(file), null);
  const s = recordRun({ file, mode: 'run', now: at('2026-08-01T00:00:00Z') });
  assert.equal(s.runs_total, 1);
});

test('an unwritable store cannot fail a run', () => {
  const rec = createActivationRecorder({ file: unwritableStore(), enabled: true });
  assert.equal(rec.run({ mode: 'run', calls: 1 }), null, 'a failed write returns null');
  assert.ok(rec.errors.length > 0, 'and is reported, not hidden');
});

test('instrumentation is off under `node --test` and behind an explicit kill switch', () => {
  assert.equal(activationEnabled({ NODE_TEST_CONTEXT: 'child-v8' }), false,
    'the suite must never write into a developer real state dir');
  assert.equal(activationEnabled({ richapi_NO_ACTIVATION_METRICS: '1' }), false);
  assert.equal(activationEnabled({}), true);
  const off = nullActivationRecorder();
  assert.equal(off.enabled, false);
  assert.equal(off.run({ mode: 'run' }), null);
});

// ---------------------------------------------------------------------------
// 6. kill/scale bands
// ---------------------------------------------------------------------------

const A = { green_min_pct: 50, yellow_min_pct: 25, min_n: 50 };
const B = { green_min_pct: 30, yellow_min_pct: 15, min_n: 30 };

test('Metric A bands at n>=50: green >=50%, yellow 25-50%, red <25%', () => {
  assert.equal(bandFor({ n: 100, converted: 60, thresholds: A }).verdict, GREEN);
  assert.equal(bandFor({ n: 100, converted: 50, thresholds: A }).verdict, GREEN, '50% is green, not yellow');
  assert.equal(bandFor({ n: 100, converted: 40, thresholds: A }).verdict, YELLOW);
  assert.equal(bandFor({ n: 100, converted: 25, thresholds: A }).verdict, YELLOW, '25% is yellow, not red');
  assert.equal(bandFor({ n: 100, converted: 24, thresholds: A }).verdict, RED);
});

test('Metric B bands at n>=30: green >=30%, yellow 15-30%, red <15%', () => {
  assert.equal(bandFor({ n: 60, converted: 20, thresholds: B }).verdict, GREEN);
  assert.equal(bandFor({ n: 60, converted: 18, thresholds: B }).verdict, GREEN);
  assert.equal(bandFor({ n: 60, converted: 12, thresholds: B }).verdict, YELLOW);
  assert.equal(bandFor({ n: 60, converted: 9, thresholds: B }).verdict, YELLOW);
  assert.equal(bandFor({ n: 60, converted: 8, thresholds: B }).verdict, RED);
});

test('INSTRUMENTATION DARK READS YELLOW, NEVER RED', () => {
  // Three separate ways of being dark. None of them may produce a kill signal.
  const noData = bandFor({ n: 0, converted: 0, thresholds: A });
  assert.equal(noData.verdict, YELLOW);
  assert.match(noData.reason, /instrumentation dark/);

  const tooFew = bandFor({ n: 10, converted: 0, thresholds: A });
  assert.equal(tooFew.verdict, YELLOW, '0% at n=10 is not evidence of failure');
  assert.match(tooFew.reason, /below the minimum sample/);

  const unconfigured = bandFor({ n: 500, converted: 1, thresholds: {} });
  assert.equal(unconfigured.verdict, YELLOW);
  assert.equal(unconfigured.thresholds_configured, false);
  assert.match(unconfigured.reason, /thresholds not configured/);

  // The property, stated as a property: nothing below min_n can ever be RED.
  for (let n = 0; n < A.min_n; n++) {
    assert.notEqual(bandFor({ n, converted: 0, thresholds: A }).verdict, RED, `n=${n} must not be RED`);
  }
});

test('thresholds come from gates.yaml by key, never from a number typed here', () => {
  const gates = loadGates();
  const bands = evaluateBands({
    cohort: { installs: 200, first_runs: 10, second_runs_within_window: 0 },
    gates, gateValue,
  });

  // The keys are cited whether or not they resolve yet, so the request is legible.
  assert.equal(bands.metric_a.gate_keys.green_min_pct, 'activation.metric_a_install_to_first_run.green_min_pct');
  assert.equal(bands.metric_b.gate_keys.min_n, 'activation.metric_b_first_to_second_run.min_n');

  const present = bands.metric_a.thresholds_configured;
  if (present) {
    // The gate keys are now declared in gates.yaml. 5% at n=200 is RED.
    assert.equal(bands.metric_a.verdict, RED, 'with thresholds in place, 5% at n=200 is a real red');
    assert.equal(bands.metric_a.green_min_pct, gateValue(gates, GATE_KEYS.metric_a.green_min_pct));
  } else {
    // The keys are not in gates.yaml yet. That must read YELLOW, and no number may
    // be substituted from this file.
    assert.equal(bands.metric_a.verdict, YELLOW);
    assert.equal(bands.metric_a.green_min_pct, null, 'an absent gate key must NOT be defaulted to a hard-coded band');
    assert.equal(bands.overall, YELLOW);
  }
});

test('the local cohort is honest: one machine is n=1, therefore YELLOW', (t) => {
  const file = store();
  recordInstall({ file, now: at('2026-08-01T00:00:00Z') });
  recordRun({ file, mode: 'dry-run', now: at('2026-08-01T01:00:00Z') });
  recordRun({ file, mode: 'run', calls: 2, now: at('2026-08-02T01:00:00Z') });

  const cohort = localCohort(readActivation(file), { windowDays: 7 });
  assert.deepEqual(
    { installs: cohort.installs, first_runs: cohort.first_runs, second: cohort.second_runs_within_window },
    { installs: 1, first_runs: 1, second: 1 });

  const bands = evaluateBands({ cohort, gates: loadGates(), gateValue });
  assert.equal(bands.metric_a.verdict, YELLOW, 'a single install can never justify a kill decision');
  assert.equal(bands.metric_b.verdict, YELLOW);
});

test('a second run outside the window does not count towards Metric B', (t) => {
  const file = store();
  recordInstall({ file, now: at('2026-08-01T00:00:00Z') });
  recordRun({ file, mode: 'run', now: at('2026-08-01T00:00:00Z') });
  recordRun({ file, mode: 'run', now: at('2026-09-01T00:00:00Z') });   // 31 days later
  assert.equal(localCohort(readActivation(file), { windowDays: 7 }).second_runs_within_window, 0);
  assert.equal(localCohort(readActivation(file), { windowDays: 60 }).second_runs_within_window, 1);
});

test('no cohort at all still renders, and still says YELLOW', () => {
  const bands = evaluateBands({});
  assert.equal(bands.overall, YELLOW);
  assert.match(bands.measured_from, /instrumentation dark/);
  assert.equal(bands.metric_a.verdict, YELLOW);
  assert.equal(bands.metric_b.verdict, YELLOW);
  const text = renderActivation(snapshot(null), bands);
  assert.match(text, /not instrumented/);
  assert.match(text, /YELLOW/);
  // No verdict column may read RED. (The reason text deliberately says the words
  // "never RED", so match the verdict positions rather than the whole blob.)
  assert.ok(!/\bRED\b\s+\S+%?\s+at n=/.test(text), 'a dark metric rendered as RED');
  assert.equal(bands.overall, YELLOW);
});

// ---------------------------------------------------------------------------
// 7. Wiring — runEnrich records, and cannot be broken by the recorder
// ---------------------------------------------------------------------------

function listFixture (t) {
  const tree = makeGtmTree({ prefix: 's5-act-run-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, 'first_name,last_name,company_domain,linkedin_url\nA,B,acme.example,https://linkedin.com/in/a\n');
  return { tree, input };
}

test('a dry run counts as a first run, and spends nothing', async (t) => {
  const { tree, input } = listFixture(t);
  const file = store();
  const rec = createActivationRecorder({ file, enabled: true, now: at('2026-08-01T00:00:00Z') });

  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, dryRun: true, budget: 500,
    api: new Proxy({}, { get () { throw new Error('ZERO-CALL VIOLATION'); } }),
    activation: rec,
  });
  assert.equal(res.mode, 'dry-run');
  const s = snapshot(readActivation(file));
  assert.equal(s.reached_first_run, true);
  assert.equal(s.first_run_mode, 'dry-run');
  assert.equal(s.paid_runs_total, 0, 'a dry run is free — it must never count as a paid run');
  assert.equal(s.outputs_written, 0);
});

test('a real run that writes a file records the activation event', async (t) => {
  const { tree, input } = listFixture(t);
  const file = store();
  const http = createFakeHttp({ fallback: okJson({ email: 'a@acme.example', credits_charged: 5 }) });
  const api = new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch });

  await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, api, verify: false,
    confirm: async () => true, output: 'out.csv',
    activation: createActivationRecorder({ file, enabled: true, now: at('2026-08-02T00:00:00Z') }),
  });

  const s = snapshot(readActivation(file));
  assert.equal(s.runs_total, 1);
  assert.equal(s.paid_runs_total, 1);
  assert.equal(s.outputs_written, 1);
  assert.equal(readActivation(file).first_output_at, '2026-08-02T00:00:00.000Z');
});

test('a recorder that explodes cannot fail the enrichment', async (t) => {
  const { tree, input } = listFixture(t);
  const exploding = {
    enabled: true, file: null, errors: [],
    install: () => { throw new Error('boom'); },
    run: () => { throw new Error('boom'); },
    read: () => null, snapshot: () => null,
  };
  // The default recorder is guarded; this one is not, which is the point — the
  // guard must live in the recorder factory, so prove the factory-made one holds.
  const safe = createActivationRecorder({ file: unwritableStore(), enabled: true });
  const res = await runEnrich({
    input, root: tree.root, catalog: CATALOG, dryRun: true, budget: 500,
    api: new Proxy({}, { get () { throw new Error('ZERO-CALL VIOLATION'); } }),
    activation: safe,
  });
  assert.equal(res.mode, 'dry-run', 'an unwritable metric store must not stop a run');
  assert.ok(safe.errors.length > 0);
  assert.throws(() => exploding.run(), /boom/);   // sanity: the guard is what saved us
});

test('by default runEnrich does not write into a real state dir during tests', async (t) => {
  // Belt and braces on hermeticity: with no `activation` injected, the default
  // recorder must be disabled under node --test.
  const { tree, input } = listFixture(t);
  const before = fs.existsSync(activationPath()) ? fs.readFileSync(activationPath(), 'utf8') : null;
  await runEnrich({
    input, root: tree.root, catalog: CATALOG, dryRun: true, budget: 500,
    api: new Proxy({}, { get () { throw new Error('ZERO-CALL VIOLATION'); } }),
  });
  const after = fs.existsSync(activationPath()) ? fs.readFileSync(activationPath(), 'utf8') : null;
  assert.equal(after, before, 'the suite wrote into the real activation store');
});
