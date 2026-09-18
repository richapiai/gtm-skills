/**
 * _lib/share-render.mjs — share-safe rendering of a run.
 *
 * An evaluator forwards this artifact to their team. It therefore crosses the PII
 * boundary the product advertises, and it must be aggregate-only BY CONSTRUCTION —
 * not by filtering a row-level render, because a filter is one new field away from
 * leaking and a construction is not.
 *
 * How "by construction" is enforced here, in order:
 *   1. The renderer never copies a journal line. It reads only counters off each line
 *      and emits counts, sums, and percentages it computed itself.
 *   2. `row_id` is used solely as a Set key for cardinality. It is never emitted —
 *      row_ids are caller-supplied and are routinely emails or CRM record ids.
 *   3. The two free-text fields that survive into aggregates (`endpoint`, `provider`)
 *      are bucketed through a strict token check; anything unrecognised collapses to
 *      `unknown_endpoint` / `other`, so a poisoned journal cannot smuggle a value out.
 *   4. `assertAggregateOnly` re-inspects the finished object and throws on any
 *      row-shaped key or contact-shaped value. A future regression becomes an
 *      exception, not a disclosure.
 *
 * Interrupted runs label completed and pending work distinctly, so a forwarded plan
 * cannot be mistaken for a finished result.
 */

import { readJournal, summarize } from './journal.mjs';

/**
 * Endpoint and provider names are bare identifiers. Anything with a dot, slash, space,
 * or leading digit is not one — and a domain, a URL and a phone number all fail it, so
 * a poisoned journal cannot ride a name field out of the boundary.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Keys that must never appear anywhere in a shareable object. */
const FORBIDDEN_KEYS = new Set([
  'row_id', 'row_ids', 'rows_detail', 'record', 'records', 'contact', 'contacts',
  'email', 'emails', 'phone', 'phones', 'mobile', 'name', 'full_name', 'first_name',
  'last_name', 'title', 'job_title', 'linkedin', 'linkedin_url', 'profile_url',
  'address', 'company', 'company_name', 'domain', 'website', 'response', 'body',
  'response_hash', 'payload', 'input', 'output',
]);

/** Always checked, on every string in the output. */
const CONTACT_SHAPED_VALUE = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,          // email
  /https?:\/\//i,                                      // any URL
  /linkedin\.com/i,
];

/**
 * Phone shape. Checked on every string except the two whose format is already
 * constrained by their own validator (`run_id`, `generated_at`) — an ISO timestamp
 * and a dated run id are both long digit runs and would otherwise trip it.
 */
const PHONE_SHAPED_VALUE = /(?:\+?\d[\s().+-]{0,2}){8,}\d/;
const NUMERIC_EXEMPT_KEYS = new Set(['run_id', 'generated_at']);

/** A run id must contain at least one letter, which no phone number does. */
const RUN_ID_SAFE = /^(?=.*[A-Za-z])[A-Za-z0-9_.-]{1,64}$/;

export class ShareLeakError extends Error {
  constructor(message) { super(message); this.name = 'ShareLeakError'; }
}

/** Final gate: throws if anything row-shaped or contact-shaped survived. */
export function assertAggregateOnly(value, path = '$', key = null) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertAggregateOnly(item, `${path}[${i}]`, key));
    return value;
  }
  if (typeof value === 'object') {
    for (const [childKey, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(childKey.toLowerCase())) {
        throw new ShareLeakError(`share render leaked a row-level key at ${path}.${childKey}`);
      }
      assertAggregateOnly(item, `${path}.${childKey}`, childKey);
    }
    return value;
  }
  if (typeof value === 'string') {
    for (const pattern of CONTACT_SHAPED_VALUE) {
      if (pattern.test(value)) {
        throw new ShareLeakError(`share render leaked a contact-shaped value at ${path}`);
      }
    }
    // A bare identifier has no separators, so a digit run inside one is not a phone.
    if (!NUMERIC_EXEMPT_KEYS.has(key)
        && !IDENTIFIER.test(value)
        && PHONE_SHAPED_VALUE.test(value)) {
      throw new ShareLeakError(`share render leaked a phone-shaped value at ${path}`);
    }
  }
  return value;
}

function bucketToken(value, fallback) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) return fallback;
  for (const pattern of CONTACT_SHAPED_VALUE) {
    if (pattern.test(value)) return fallback;
  }
  return value;
}

function bucketRunId(value) {
  if (typeof value !== 'string' || !RUN_ID_SAFE.test(value)) return 'unknown';
  for (const pattern of CONTACT_SHAPED_VALUE) {
    if (pattern.test(value)) return 'unknown';
  }
  return value;
}

function pct(numerator, denominator) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/**
 * Render a run as a shareable aggregate.
 *
 * Accepts journal lines, or a path to a journal file. `catalog` is optional; when
 * given, endpoint names are additionally checked against it, so only endpoints the
 * catalog knows about are ever named in a shared artifact.
 */
export function renderShareable(source, {
  catalog = null,
  now = () => new Date().toISOString(),
  runIdLabel = null,
} = {}) {
  const read = typeof source === 'string' ? readJournal(source) : { lines: source, corrupt: [] };
  const lines = read.lines ?? [];
  const corruptCount = (read.corrupt ?? []).length;

  const knownEndpoints = catalog?.endpoints ? new Set(Object.keys(catalog.endpoints)) : null;
  const safeEndpoint = (name) => {
    const token = bucketToken(name, 'unknown_endpoint');
    if (knownEndpoints && !knownEndpoints.has(token)) return 'unknown_endpoint';
    return token;
  };

  const units = summarize(lines);

  // --- per-hop aggregation (counters only; no line is ever copied) -------------
  const hops = new Map();
  const hopKey = (hop, endpoint) => `${hop}:${endpoint}`;
  const rowState = new Map(); // row_id -> flags. Keys are never emitted.

  for (const unit of units.values()) {
    const endpoint = safeEndpoint(unit.endpoint);
    const key = hopKey(unit.hop, endpoint);
    let bucket = hops.get(key);
    if (!bucket) {
      bucket = {
        hop: unit.hop,
        endpoint,
        planned: 0,
        ok: 0,
        failed: 0,
        in_flight: 0,
        not_started: 0,
        skipped_cache: 0,
        skipped_suppressed: 0,
        skipped_budget: 0,
        retries: 0,
        credits_estimated: 0,
        credits_actual: 0,
        credits_unverifiable_calls: 0,
      };
      hops.set(key, bucket);
    }
    bucket.planned += 1;
    bucket.credits_estimated += unit.credits_estimated ?? 0;
    if (unit.max_attempt > 1) bucket.retries += unit.max_attempt - 1;

    let flags = rowState.get(unit.row_id);
    if (!flags) {
      flags = { ok: 0, failed: 0, inFlight: 0, notStarted: 0, suppressed: 0, cached: 0, budget: 0, total: 0 };
      rowState.set(unit.row_id, flags);
    }
    flags.total += 1;

    switch (unit.status) {
      case 'ok':
        bucket.ok += 1;
        flags.ok += 1;
        if (typeof unit.credits_actual === 'number') bucket.credits_actual += unit.credits_actual;
        else bucket.credits_unverifiable_calls += 1;
        break;
      case 'failed':
        bucket.failed += 1;
        // The row the 402 landed on was stopped by the budget, not by a bad request.
        // Labelling it "failed" would misdescribe the run to whoever it is forwarded to.
        if (unit.error === 'http_402') flags.budget += 1;
        else flags.failed += 1;
        break;
      case 'skipped_cache':
        bucket.skipped_cache += 1;
        flags.cached += 1;
        break;
      case 'skipped_suppressed':
        bucket.skipped_suppressed += 1;
        flags.suppressed += 1;
        break;
      case 'skipped_budget':
        bucket.skipped_budget += 1;
        flags.budget += 1;
        break;
      case 'pending':
        if (unit.max_attempt >= 1) { bucket.in_flight += 1; flags.inFlight += 1; }
        else { bucket.not_started += 1; flags.notStarted += 1; }
        break;
      default:
        break;
    }
  }

  // --- provider hit-rates, the input to /learn --------------------------------
  const providers = new Map();
  for (const unit of units.values()) {
    if (unit.status !== 'ok' && unit.status !== 'failed') continue;
    const provider = bucketToken(unit.provider ?? 'unattributed', 'other');
    let bucket = providers.get(provider);
    if (!bucket) { bucket = { provider, attempts: 0, ok: 0, confidence_samples: 0, confidence_sum: 0 }; providers.set(provider, bucket); }
    bucket.attempts += 1;
    if (unit.status === 'ok') bucket.ok += 1;
    if (typeof unit.confidence === 'number') {
      bucket.confidence_samples += 1;
      bucket.confidence_sum += unit.confidence;
    }
  }

  // --- row buckets: completed vs pending, labelled distinctly ------------------
  const rows = {
    total: rowState.size,
    completed: 0,
    partial: 0,
    in_flight: 0,
    not_started: 0,
    failed: 0,
    dropped_suppressed: 0,
    halted_budget: 0,
  };
  let rowsWithAnyOk = 0;
  for (const flags of rowState.values()) {
    if (flags.ok > 0) rowsWithAnyOk += 1;
    if (flags.suppressed === flags.total) { rows.dropped_suppressed += 1; continue; }
    if (flags.inFlight > 0) { rows.in_flight += 1; continue; }
    if (flags.budget > 0) { rows.halted_budget += 1; continue; }
    if (flags.notStarted === flags.total) { rows.not_started += 1; continue; }
    const done = flags.ok + flags.cached + flags.suppressed;
    if (done === flags.total) { rows.completed += 1; continue; }
    if (flags.failed > 0 && done === 0) { rows.failed += 1; continue; }
    rows.partial += 1;
  }

  const totals = {
    units_planned: units.size,
    calls_ok: 0,
    calls_failed: 0,
    retries: 0,
    skipped_cache: 0,
    skipped_suppressed: 0,
    skipped_budget: 0,
    credits_estimated: 0,
    credits_actual: 0,
    credits_unverifiable_calls: 0,
  };
  for (const bucket of hops.values()) {
    totals.calls_ok += bucket.ok;
    totals.calls_failed += bucket.failed;
    totals.retries += bucket.retries;
    totals.skipped_cache += bucket.skipped_cache;
    totals.skipped_suppressed += bucket.skipped_suppressed;
    totals.skipped_budget += bucket.skipped_budget;
    totals.credits_estimated += bucket.credits_estimated;
    totals.credits_actual += bucket.credits_actual;
    totals.credits_unverifiable_calls += bucket.credits_unverifiable_calls;
  }

  const state = deriveState({ units, totals, rows });

  // Law 4: never present an estimate as an actual.
  const costStatus = totals.credits_unverifiable_calls > 0 ? 'estimated_unverifiable' : 'actual';

  const out = {
    schema: 'gtm.share_summary.v1',
    run_id: bucketRunId(runIdLabel ?? lines[0]?.run_id ?? 'unknown'),
    generated_at: now(),
    state,
    rows,
    coverage_pct: pct(rowsWithAnyOk, rows.total),
    per_hop: [...hops.values()]
      .sort((a, b) => a.hop - b.hop)
      .map((bucket) => ({
        hop: bucket.hop,
        endpoint: bucket.endpoint,
        planned: bucket.planned,
        completed: bucket.ok,
        failed: bucket.failed,
        in_flight: bucket.in_flight,
        not_started: bucket.not_started,
        skipped_cache: bucket.skipped_cache,
        skipped_suppressed: bucket.skipped_suppressed,
        skipped_budget: bucket.skipped_budget,
        retries: bucket.retries,
        credits_estimated: bucket.credits_estimated,
        credits_actual: bucket.credits_actual,
        cost_status: bucket.credits_unverifiable_calls > 0 ? 'estimated_unverifiable' : 'actual',
        hit_rate_pct: pct(bucket.ok, bucket.ok + bucket.failed),
      })),
    providers: [...providers.values()]
      .sort((a, b) => b.attempts - a.attempts)
      .map((bucket) => ({
        provider: bucket.provider,
        attempts: bucket.attempts,
        ok: bucket.ok,
        hit_rate_pct: pct(bucket.ok, bucket.attempts),
        mean_confidence: bucket.confidence_samples
          ? Math.round((bucket.confidence_sum / bucket.confidence_samples) * 1000) / 1000
          : null,
      })),
    totals: { ...totals, cost_status: costStatus },
    journal_health: { corrupt_lines: corruptCount },
    eta: {
      available: false,
      reason: 'the API publishes no per-endpoint rate-limit quota, so elapsed time cannot be predicted; no ETA is published until it does',
    },
    disclosure: 'Aggregate-only. No row identifiers, contact fields, or response bodies are included by construction.',
  };

  return assertAggregateOnly(out);
}

function deriveState({ units, totals, rows }) {
  if (units.size === 0) return 'empty';
  let dryRunPending = 0;
  let inFlight = 0;
  for (const unit of units.values()) {
    if (unit.status !== 'pending') continue;
    if (unit.max_attempt >= 1) inFlight += 1; else dryRunPending += 1;
  }
  const anyExecuted = totals.calls_ok + totals.calls_failed + inFlight > 0;
  if (!anyExecuted && dryRunPending > 0) return 'dry_run_plan';
  if (inFlight > 0 || totals.skipped_budget > 0) return 'interrupted';
  if (dryRunPending > 0) return 'in_progress';
  if (rows.failed > 0 || rows.partial > 0) return 'complete_with_failures';
  return 'complete';
}

/** Markdown rendering of the aggregate. Re-checked before it is returned. */
export function renderShareableText(summary) {
  assertAggregateOnly(summary);
  const out = [];
  const stateLabel = {
    dry_run_plan: 'DRY RUN — plan only, nothing has been charged',
    interrupted: 'INTERRUPTED — completed and pending work are listed separately below',
    in_progress: 'IN PROGRESS',
    complete: 'COMPLETE',
    complete_with_failures: 'COMPLETE (with failures)',
    empty: 'EMPTY',
  }[summary.state] ?? summary.state;

  out.push(`# Run summary — ${summary.run_id}`);
  out.push('');
  out.push(`**${stateLabel}**`);
  out.push('');
  out.push(`- Rows: ${summary.rows.total}`);
  out.push(`  - completed: ${summary.rows.completed}`);
  out.push(`  - partial: ${summary.rows.partial}`);
  out.push(`  - in flight at interrupt: ${summary.rows.in_flight}`);
  out.push(`  - not started: ${summary.rows.not_started}`);
  out.push(`  - failed: ${summary.rows.failed}`);
  out.push(`  - halted on budget: ${summary.rows.halted_budget}`);
  out.push(`  - dropped by suppression: ${summary.rows.dropped_suppressed}`);
  out.push(`- Coverage: ${summary.coverage_pct == null ? 'n/a' : `${summary.coverage_pct}%`}`);
  out.push('');
  out.push('| hop | endpoint | planned | done | failed | cached | suppressed | credits |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const hop of summary.per_hop) {
    const credits = hop.cost_status === 'actual'
      ? `${hop.credits_actual}`
      : `~${hop.credits_estimated} (est.)`;
    out.push(
      `| ${hop.hop} | ${hop.endpoint} | ${hop.planned} | ${hop.completed} | ${hop.failed} `
      + `| ${hop.skipped_cache} | ${hop.skipped_suppressed} | ${credits} |`,
    );
  }
  out.push('');
  if (summary.providers.length) {
    out.push('| provider | attempts | hits | hit rate |');
    out.push('|---|---|---|---|');
    for (const p of summary.providers) {
      out.push(`| ${p.provider} | ${p.attempts} | ${p.ok} | ${p.hit_rate_pct == null ? 'n/a' : `${p.hit_rate_pct}%`} |`);
    }
    out.push('');
  }
  const total = summary.totals.cost_status === 'actual'
    ? `${summary.totals.credits_actual} credits`
    : `~${summary.totals.credits_estimated} credits (estimated_unverifiable — the response carries no billing field)`;
  out.push(`**Total: ${total}**`);
  out.push(`ETA: unavailable — ${summary.eta.reason}`);
  if (summary.journal_health.corrupt_lines > 0) {
    out.push(`Journal health: ${summary.journal_health.corrupt_lines} unreadable line(s) recovered around.`);
  }
  out.push('');
  out.push(`_${summary.disclosure}_`);
  return out.join('\n');
}
