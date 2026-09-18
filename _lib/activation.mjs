// _lib/activation.mjs — activation instrumentation and kill/scale bands.
//
// THIS MODULE MAKES NO NETWORK CALL, EVER.
//
// It imports `node:fs`, `node:path`, `node:os` and `node:crypto` and nothing else.
// There is no fetch, no http, no dns, no child process. `tests/activation/activation.test.mjs`
// asserts that at the source level as well as at runtime, because "telemetry" is a
// word that grows a network client the moment nobody is watching. If this pack ever
// ships a phone-home it will be a separate module behind an explicit opt-in (a
// consent toggle), and it will not be this file.
//
// WHAT IT MEASURES
//
//   Metric A  install -> first run     did the install ever produce a file?
//   Metric B  first run -> second run  did the first run make the second one worth doing?
//
// The activation path itself already exists: `richapi enrich <list> --dry-run` is free
// and a small real run is under 30 credits. So this is plumbing, not product.
//
// WHAT IT STORES (law 7)
//
//   Counts and timestamps. An install id. A pack version. Nothing else.
//
//   No list names, no file paths, no row ids, no contact values, no endpoint payloads.
//   `gtm/` is PII, which is why the store deliberately does NOT live there: it lives
//   in the state dir alongside the balance cache (`~/.richapi-skills`, overridable
//   with `richapi_SKILLS_HOME`). Two reasons. An install metric that a TTL sweep or a
//   `/comply erase` deletes cannot measure install->first-run at all; and a per-project
//   `gtm/` would count one install as many.
//
// WHY THE BANDS LIVE HERE TOO
//
//   A verdict is only as honest as the denominator behind it. Keeping the band
//   arithmetic next to the counter that feeds it is what stops a dashboard reporting
//   RED off n=3. Instrumentation dark reads YELLOW, never RED — absence of data is
//   not evidence of failure, and a red band triggers a kill decision.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// The only non-builtin import. `ledger.stateDir()` is a pure path helper over
// `richapi_SKILLS_HOME`/`$HOME`; it is imported rather than re-derived so the
// activation store and the balance cache can never end up in two different places.
// This module never writes to ledger.mjs's files.
import { stateDir } from './ledger.mjs';

export const ACTIVATION_SCHEMA_VERSION = 1;
export const ACTIVATION_FILE = 'activation.json';

// --- verdicts ---------------------------------------------------------------

export const GREEN = 'green';
export const YELLOW = 'yellow';
export const RED = 'red';

// --- gate keys --------------------------------------------------------------
//
// These are POLICY NUMBERS. Law 1 says no threshold is ever typed by hand into a
// skill or a doc, and a kill/scale band is the most consequential number in the pack
// — it decides whether the project continues. So they are read from gates.yaml by
// key from the `activation` block in gates.yaml.
//
// WHAT HAPPENS WHILE THE KEYS ARE ABSENT. Law 5 says a missing gate key fails closed.
// For a SPEND gate, closed means STOP. For a kill/scale band there is no call to
// stop, and failing to RED would be the exact mistake the bands must never make: it would read
// "we have not configured the thresholds yet" as "kill the project". So the closed
// position here is YELLOW with `thresholds_configured: false` stated on the verdict.
// Nothing is silently defaulted; the numbers below are never substituted.
export const GATE_KEYS = Object.freeze({
  metric_a: {
    green_min_pct: 'activation.metric_a_install_to_first_run.green_min_pct',
    yellow_min_pct: 'activation.metric_a_install_to_first_run.yellow_min_pct',
    min_n: 'activation.metric_a_install_to_first_run.min_n',
  },
  metric_b: {
    green_min_pct: 'activation.metric_b_first_to_second_run.green_min_pct',
    yellow_min_pct: 'activation.metric_b_first_to_second_run.yellow_min_pct',
    min_n: 'activation.metric_b_first_to_second_run.min_n',
    window_days: 'activation.metric_b_first_to_second_run.window_days',
  },
  dark_verdict: 'activation.dark_verdict',
  enabled: 'activation.local_metrics_enabled',
});

// --- where the store lives --------------------------------------------------

/** The install-scoped state dir, from ledger.mjs. Re-exported for callers. */
export { stateDir };

export function activationPath (dir = null) {
  return path.join(dir ?? stateDir(), ACTIVATION_FILE);
}

/**
 * Is local instrumentation on?
 *
 * `richapi_NO_ACTIVATION_METRICS=1` turns it off. `NODE_TEST_CONTEXT` is set by
 * `node --test` in every child process, and turns it off too: the suite must never
 * write into a developer's real state dir, and a test run counted as a "first run"
 * would poison the only metric this file exists to produce. The activation tests
 * inject a recorder explicitly, which bypasses this.
 */
export function activationEnabled (env = process.env) {
  if (env.richapi_NO_ACTIVATION_METRICS === '1') return false;
  if (env.NODE_TEST_CONTEXT) return false;
  return true;
}

// --- the store --------------------------------------------------------------

const blank = (nowIso, version) => ({
  schema_version: ACTIVATION_SCHEMA_VERSION,
  // Local-only. Never transmitted; there is nothing here that can transmit it. It
  // exists so a future opt-in aggregation has a stable unit, and so a re-install
  // into a fresh state dir is distinguishable from a second run.
  install_id: randomUUID(),
  pack_version: version ?? null,
  installed_at: nowIso,
  first_run_at: null,
  first_run_mode: null,
  second_run_at: null,
  last_run_at: null,
  runs_total: 0,
  runs_by_mode: {},
  paid_runs_total: 0,        // runs that actually issued >=1 HTTP call
  first_paid_run_at: null,
  outputs_written: 0,        // runs that produced a file — the activation event
  first_output_at: null,
});

export function readActivation (file = activationPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return raw;
  } catch {
    // Missing, unreadable, or corrupt. A metric file must never wedge a run, so a
    // damaged store is treated as absent and rewritten on the next record.
    return null;
  }
}

export function writeActivation (state, file = activationPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, file);   // atomic-ish: a killed run cannot leave a half file
  return file;
}

/**
 * Stamp the install. Idempotent: `installed_at` is written once and never moved, or
 * install->first-run would reset itself on every upgrade and always look instant.
 */
export function recordInstall ({ file = activationPath(), now = () => new Date(), version = null } = {}) {
  const nowIso = now().toISOString();
  const prior = readActivation(file);
  const state = prior ?? blank(nowIso, version);
  if (!state.installed_at) state.installed_at = nowIso;
  if (version && !state.pack_version) state.pack_version = version;
  writeActivation(state, file);
  return state;
}

/**
 * Record one run.
 *
 * `mode` is the runEnrich mode ('dry-run' | 'run' | 'resume' | 'blocked' | 'declined').
 * `calls` is the HTTP call count and `wroteOutput` whether a file was produced —
 * both are counts, both are the difference between "ran the CLI" and "got the thing".
 *
 * A blocked or declined run still counts as a run: the user showed up. It is NOT a
 * first PAID run, which is tracked separately, because conflating them would let a
 * pack that gates everyone out report perfect activation.
 */
export function recordRun ({
  file = activationPath(),
  mode = 'run',
  calls = 0,
  wroteOutput = false,
  now = () => new Date(),
  version = null,
} = {}) {
  const d = now();
  const nowIso = d.toISOString();
  const state = readActivation(file) ?? blank(nowIso, version);

  state.schema_version = ACTIVATION_SCHEMA_VERSION;
  if (!state.installed_at) state.installed_at = nowIso;

  state.runs_total = Number(state.runs_total ?? 0) + 1;
  state.runs_by_mode ??= {};
  state.runs_by_mode[mode] = Number(state.runs_by_mode[mode] ?? 0) + 1;
  state.last_run_at = nowIso;

  if (!state.first_run_at) {
    state.first_run_at = nowIso;
    state.first_run_mode = mode;
  } else if (!state.second_run_at) {
    state.second_run_at = nowIso;
  }

  if (Number(calls) > 0) {
    state.paid_runs_total = Number(state.paid_runs_total ?? 0) + 1;
    state.first_paid_run_at ??= nowIso;
  }
  if (wroteOutput) {
    state.outputs_written = Number(state.outputs_written ?? 0) + 1;
    state.first_output_at ??= nowIso;
  }

  writeActivation(state, file);
  return state;
}

/**
 * A recorder that never throws and never blocks a run.
 *
 * Telemetry that can fail a paid enrichment is worse than no telemetry. Every write
 * is wrapped; a failure is swallowed and reported on the returned object so a caller
 * can surface it if it wants to, and the run continues either way.
 */
export function createActivationRecorder ({
  file = null,
  enabled = null,
  now = () => new Date(),
  version = null,
} = {}) {
  const on = enabled === null ? activationEnabled() : Boolean(enabled);
  const target = file ?? activationPath();
  const errors = [];
  const guard = (fn) => {
    if (!on) return null;
    try { return fn(); } catch (e) { errors.push(String(e?.message ?? e)); return null; }
  };
  return {
    enabled: on,
    file: target,
    errors,
    install: () => guard(() => recordInstall({ file: target, now, version })),
    run: (opts = {}) => guard(() => recordRun({ file: target, now, version, ...opts })),
    read: () => (on ? readActivation(target) : null),
    snapshot: () => (on ? snapshot(readActivation(target)) : snapshot(null)),
  };
}

/** A recorder that records nothing. For callers that want instrumentation off. */
export function nullActivationRecorder (reason = 'activation metrics disabled') {
  return {
    enabled: false, file: null, reason, errors: [],
    install: () => null, run: () => null, read: () => null, snapshot: () => snapshot(null),
  };
}

// --- derived view -----------------------------------------------------------

const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Derived, never stored: the two intervals the metrics are defined over. */
export function snapshot (state) {
  if (!state) {
    return {
      instrumented: false,
      reached_first_run: false,
      reached_second_run: false,
      install_to_first_run_hours: null,
      first_to_second_run_days: null,
      runs_total: 0,
      outputs_written: 0,
    };
  }
  const ms = (a, b) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
  const a = ms(state.installed_at, state.first_run_at);
  const b = ms(state.first_run_at, state.second_run_at);
  return {
    instrumented: true,
    install_id: state.install_id ?? null,
    pack_version: state.pack_version ?? null,
    reached_first_run: Boolean(state.first_run_at),
    reached_second_run: Boolean(state.second_run_at),
    install_to_first_run_hours: a === null ? null : round(a / HOUR),
    first_to_second_run_days: b === null ? null : round(b / DAY),
    first_run_mode: state.first_run_mode ?? null,
    runs_total: Number(state.runs_total ?? 0),
    paid_runs_total: Number(state.paid_runs_total ?? 0),
    outputs_written: Number(state.outputs_written ?? 0),
    installed_at: state.installed_at ?? null,
    first_run_at: state.first_run_at ?? null,
    second_run_at: state.second_run_at ?? null,
    last_run_at: state.last_run_at ?? null,
  };
}

const round = (n) => Math.round(Number(n) * 100) / 100;

// --- kill/scale bands -------------------------------------------------------

/** Read a gate key without letting a miss become a STOP. Returns null when absent. */
function optionalGate (gates, key, gateValue) {
  try { const v = gateValue(gates, key); return Number.isFinite(Number(v)) ? Number(v) : v; }
  catch { return null; }
}

/**
 * Band one metric.
 *
 * @param {object} p
 * @param {number} p.n           denominator — installs (A) or first-runs (B)
 * @param {number} p.converted   numerator
 * @param {object} p.thresholds  { green_min_pct, yellow_min_pct, min_n } — any may be null
 *
 * The three ways this returns YELLOW rather than RED, all deliberate:
 *   1. thresholds absent      — nothing to compare against
 *   2. n below min_n          — the sample cannot support a kill decision
 *   3. n is 0 / not measured  — instrumentation dark
 */
export function bandFor ({ n = 0, converted = 0, thresholds = {} } = {}) {
  const { green_min_pct = null, yellow_min_pct = null, min_n = null } = thresholds ?? {};
  const configured = Number.isFinite(green_min_pct) && Number.isFinite(yellow_min_pct);
  const denom = Number(n) || 0;
  const num = Number(converted) || 0;
  const pct = denom > 0 ? round((num / denom) * 100) : null;

  const base = {
    n: denom, converted: num, pct,
    thresholds_configured: configured,
    min_n: Number.isFinite(min_n) ? min_n : null,
    green_min_pct: Number.isFinite(green_min_pct) ? green_min_pct : null,
    yellow_min_pct: Number.isFinite(yellow_min_pct) ? yellow_min_pct : null,
  };

  if (!configured) {
    return { ...base, verdict: YELLOW, reason: 'thresholds not configured in gates.yaml — reporting YELLOW, never RED' };
  }
  if (denom === 0) {
    return { ...base, verdict: YELLOW, reason: 'instrumentation dark (n=0) — absence of data is not evidence of failure' };
  }
  if (Number.isFinite(min_n) && denom < min_n) {
    return { ...base, verdict: YELLOW, reason: `n=${denom} is below the minimum sample of ${min_n} — too small to support a kill decision` };
  }
  if (pct >= green_min_pct) return { ...base, verdict: GREEN, reason: `${pct}% >= ${green_min_pct}%` };
  if (pct >= yellow_min_pct) return { ...base, verdict: YELLOW, reason: `${pct}% is between ${yellow_min_pct}% and ${green_min_pct}%` };
  return { ...base, verdict: RED, reason: `${pct}% is below ${yellow_min_pct}% at n=${denom}` };
}

/**
 * Both bands, thresholds read from gates.yaml by key.
 *
 * `gates` and `gateValue` are injected rather than imported so this module has no
 * hard dependency on gate loading and ledger.mjs stays untouched. Pass
 * `loadGates()` and `gateValue` from `_lib/gates.mjs`.
 *
 * `cohort` is the aggregate the bands are computed over:
 *   { installs, first_runs, second_runs_within_window }
 * On one machine that is n=1 by construction, which is exactly why every band
 * below min_n reads YELLOW. Real numbers need an opt-in aggregation that does not
 * exist yet and is not built here.
 */
export function evaluateBands ({ cohort = null, gates = null, gateValue = null } = {}) {
  const read = (key) => (gates && gateValue ? optionalGate(gates, key, gateValue) : null);

  const aThresholds = {
    green_min_pct: read(GATE_KEYS.metric_a.green_min_pct),
    yellow_min_pct: read(GATE_KEYS.metric_a.yellow_min_pct),
    min_n: read(GATE_KEYS.metric_a.min_n),
  };
  const bThresholds = {
    green_min_pct: read(GATE_KEYS.metric_b.green_min_pct),
    yellow_min_pct: read(GATE_KEYS.metric_b.yellow_min_pct),
    min_n: read(GATE_KEYS.metric_b.min_n),
  };
  const windowDays = read(GATE_KEYS.metric_b.window_days);

  const c = cohort ?? {};
  const a = bandFor({ n: c.installs ?? 0, converted: c.first_runs ?? 0, thresholds: aThresholds });
  const b = bandFor({ n: c.first_runs ?? 0, converted: c.second_runs_within_window ?? 0, thresholds: bThresholds });

  const worst = [a.verdict, b.verdict].includes(RED) ? RED
    : [a.verdict, b.verdict].includes(YELLOW) ? YELLOW
      : GREEN;

  return {
    metric_a: { ...a, name: 'install -> first run', gate_keys: GATE_KEYS.metric_a },
    metric_b: { ...b, name: 'first run -> second run', window_days: windowDays, gate_keys: GATE_KEYS.metric_b },
    overall: worst,
    measured_from: cohort ? 'supplied cohort' : 'no cohort supplied — instrumentation dark',
    gates_present: Boolean(gates && gateValue),
  };
}

/**
 * The single-install cohort. Honest by construction: n is 1 (or 0), so both bands
 * come back YELLOW under any sane min_n. It exists so `evaluateBands` has something
 * real to read locally and so the shape of a fleet cohort is written down.
 */
export function localCohort (state, { windowDays = null, now = () => new Date() } = {}) {
  if (!state || !state.installed_at) return { installs: 0, first_runs: 0, second_runs_within_window: 0, source: 'local', dark: true };
  const first = state.first_run_at ? 1 : 0;
  let second = 0;
  if (state.first_run_at && state.second_run_at) {
    const gap = new Date(state.second_run_at).getTime() - new Date(state.first_run_at).getTime();
    second = (!Number.isFinite(windowDays) || gap <= windowDays * DAY) ? 1 : 0;
  }
  return { installs: 1, first_runs: first, second_runs_within_window: second, source: 'local', dark: false, as_of: now().toISOString() };
}

/** Render for a human. Never invents a number the store does not hold. */
export function renderActivation (snap, bands = null) {
  const L = [];
  if (!snap?.instrumented) {
    L.push('activation: not instrumented on this machine (no store yet, or metrics disabled).');
  } else {
    L.push(`activation  install ${snap.installed_at}`);
    L.push(`  first run      ${snap.first_run_at ?? 'never'}`
      + (snap.install_to_first_run_hours === null ? '' : `  (+${snap.install_to_first_run_hours}h)`));
    L.push(`  second run     ${snap.second_run_at ?? 'never'}`
      + (snap.first_to_second_run_days === null ? '' : `  (+${snap.first_to_second_run_days}d)`));
    L.push(`  runs           ${snap.runs_total} total, ${snap.paid_runs_total} that spent, ${snap.outputs_written} that wrote a file`);
  }
  if (bands) {
    L.push('');
    for (const key of ['metric_a', 'metric_b']) {
      const m = bands[key];
      L.push(`  ${m.name.padEnd(24)} ${m.verdict.toUpperCase().padEnd(7)} ${m.pct === null ? 'n/a' : m.pct + '%'} at n=${m.n}`);
      L.push(`    ${m.reason}`);
    }
    L.push(`  overall: ${bands.overall.toUpperCase()}`);
  }
  return L.join('\n');
}

export default {
  ACTIVATION_SCHEMA_VERSION, ACTIVATION_FILE, GATE_KEYS, GREEN, YELLOW, RED,
  activationPath, activationEnabled, readActivation, writeActivation,
  recordInstall, recordRun, createActivationRecorder, nullActivationRecorder,
  snapshot, bandFor, evaluateBands, localCohort, renderActivation,
};
