/**
 * _lib/dryrun.mjs — the `--dry-run` plan artifact.
 *
 * A cost gate approves a NUMBER. A user needs to approve a PLAN: which rows, which
 * hops, in what order, what each one costs, what is already cached and therefore free,
 * and which rows are dropped by suppression before any of it runs.
 *
 * Rules this module holds:
 *   - ZERO calls. The client is never touched in a dry run; it exists only so the
 *     caller can prove that with an injected client that throws on use.
 *   - Every callable row/hop is journalled `pending` (attempt 0 = "planned, never
 *     attempted"), so the approved plan IS the run's journal and the executor
 *     just fills it in.
 *   - Cache hits are shown as skipped-and-not-charged; suppressed rows as dropped.
 *     Both are journalled with their terminal skip status rather than as `pending`,
 *     because a `pending` suppressed row is one resume away from being enriched.
 *   - Prices come from the catalog (Law 1: no credit number is ever typed by hand).
 *     `pricing.model: unknown` yields a null estimate that is reported as unknown —
 *     never as zero.
 *   - No ETA is published until per-endpoint rate-limit quotas are known; the API does
 *     not document them yet. Injecting `rateLimits` turns the ETA on; until then the plan says why it is absent.
 *   - The plan states the CONDITIONAL-HOP ECONOMICS but never a hit rate. A hop that
 *     fires is billed whether or not it finds anything — only a non-2xx is unbilled —
 *     so the ceiling is also the bill for a run that finds nothing at all. That much
 *     is knowable before the spend and is now said before the spend. The hit rate is
 *     not knowable before the spend, and inventing one here would turn a ceiling into
 *     a forecast, so it is reported only by the receipt, afterwards. Injecting
 *     `priorObservations` (real per-endpoint call/find counts from earlier runs) adds
 *     an OBSERVED rate, labelled as a record of N prior runs and never as a forecast.
 *
 * The planner takes ROW DESCRIPTORS, not rows: { row_id, has, suppressed, cached }.
 * Contact values never reach this module at all — that is the cheapest way to keep
 * them out of the journal and out of the shareable artifact.
 */

import { RunJournal } from './journal.mjs';

/** Keys that mean a caller handed us a contact record instead of a descriptor. */
const PII_SHAPED_KEYS = [
  'email', 'emails', 'work_email', 'personal_email', 'email_address',
  'phone', 'phones', 'mobile', 'mobile_phone', 'phone_number', 'direct_dial',
  'name', 'full_name', 'first_name', 'last_name', 'title', 'job_title',
  'linkedin', 'linkedin_url', 'profile_url', 'address', 'location', 'city',
  'company', 'company_name', 'domain', 'website', 'contact', 'record', 'row',
];

const ALLOWED_DESCRIPTOR_KEYS = ['row_id', 'has', 'suppressed', 'cached', 'segment'];

export class PlanContractError extends Error {
  constructor(message) { super(message); this.name = 'PlanContractError'; }
}

export const ETA_UNAVAILABLE = Object.freeze({
  available: false,
  reason: 'the API publishes no per-endpoint rate-limit quota, so elapsed time cannot be predicted; no ETA is published until it does',
});

/**
 * Reject a full contact record early. The planner has no use for contact values, so
 * accepting them would only create a path for them to reach the journal.
 */
export function assertRowDescriptor(row) {
  if (!row || typeof row !== 'object') {
    throw new PlanContractError('row descriptor must be an object');
  }
  if (typeof row.row_id !== 'string' || row.row_id.length === 0) {
    throw new PlanContractError('row descriptor requires a non-empty string row_id');
  }
  for (const key of Object.keys(row)) {
    if (ALLOWED_DESCRIPTOR_KEYS.includes(key)) continue;
    const reason = PII_SHAPED_KEYS.includes(key.toLowerCase())
      ? 'that is contact data — pass a descriptor, not the row'
      : 'unknown descriptor key';
    throw new PlanContractError(`row descriptor field "${key}": ${reason}`);
  }
  return row;
}

/**
 * Price one call from the catalog. Returns { credits, basis, bounded, known }.
 * An unknown pricing model returns credits: null — an unknown cost is reported as
 * unknown, never silently priced at zero.
 */
export function priceCall(endpointDef, { expectedResults = null } = {}) {
  const pricing = endpointDef?.pricing;
  if (!pricing) return { credits: null, basis: 'no_pricing_in_catalog', known: false, bounded: false };
  const bounded = pricing.bounded !== false;
  switch (pricing.model) {
    case 'flat':
      return {
        credits: pricing.credits_per_call ?? null,
        basis: 'flat',
        known: pricing.credits_per_call != null,
        bounded,
      };
    case 'per_result': {
      const n = expectedResults;
      if (n == null || pricing.credits_per_result == null) {
        return { credits: null, basis: 'per_result_unknown_count', known: false, bounded };
      }
      return { credits: pricing.credits_per_result * n, basis: `per_result x${n}`, known: true, bounded };
    }
    case 'base_plus_per_result': {
      const n = expectedResults;
      const base = pricing.credits_base ?? 0;
      if (n == null || pricing.credits_per_result == null) {
        return { credits: null, basis: 'base_plus_per_result_unknown_count', known: false, bounded };
      }
      return {
        credits: base + pricing.credits_per_result * n,
        basis: `base ${base} + per_result x${n}`,
        known: true,
        bounded,
      };
    }
    default:
      return { credits: null, basis: 'unknown_pricing_model', known: false, bounded };
  }
}

/**
 * Build the reviewable plan. Pure — makes no calls and writes nothing.
 *
 * waterfall: [{ endpoint, provides?, only_if_missing?, expected_results?, conditional? }]
 *            array position is the hop index.
 */
export function buildPlan({
  runId,
  rows,
  waterfall,
  catalog,
  rateLimits = null,
  allowDisabled = false,
  // Real per-endpoint {endpoint, calls, found, run_id} counts from earlier runs.
  // Null (the default) means no observed rate is available, which the plan says
  // out loud rather than filling with a plausible-looking number.
  priorObservations = null,
  now = () => new Date().toISOString(),
}) {
  if (!catalog?.endpoints) throw new PlanContractError('catalog with endpoints is required');
  if (!Array.isArray(waterfall) || waterfall.length === 0) {
    throw new PlanContractError('waterfall must be a non-empty array of hops');
  }

  for (const hop of waterfall) {
    const def = catalog.endpoints[hop.endpoint];
    if (!def) throw new PlanContractError(`endpoint "${hop.endpoint}" is not in the catalog`);
    if (def.pricing?.disabled_by_default && !allowDisabled) {
      // Fail closed. post_keyword_search is the live example: worst case 60,000 credits.
      throw new PlanContractError(
        `endpoint "${hop.endpoint}" is disabled_by_default (${def.pricing.disabled_reason ?? 'no reason recorded'})`,
      );
    }
  }

  const planRows = [];
  const units = [];

  /**
   * Why a row costs nothing.
   *
   *   suppressed                        do-not-contact; never call, never output
   *   fully_cached                      every hop answered from cache
   *   partially_cached_no_callable_hop  some hops cached, the rest not runnable
   *   no_callable_hop                   nothing cached, nothing runnable
   *   has_work                          at least one paid call planned
   *
   * These are four different messages to a user and they used to be two. "You
   * already have this" and "I cannot do anything with this row" both rendered as
   * "fully cached", which is the more comfortable of the two and therefore the
   * wrong default: a list where every row lacks a usable input read as a list
   * that was entirely free to enrich, and the user learned nothing about why
   * they got no data.
   *
   * The middle case is the one that only exists once a cache does. A row can be
   * half-answered from cache and stuck on the rest — reporting that as
   * "fully cached" overstates coverage, and reporting it as "no callable hop"
   * hides the data already held.
   *
   *          any hop callable?
   *                 │
   *        ┌── yes ─┴─ no ──┐
   *     has_work            │
   *                  any hop cached?
   *                         │
   *                ┌─ yes ──┴── no ─┐
   *          all hops cached?   no_callable_hop
   *                 │
   *        ┌─ yes ──┴── no ─┐
   *   fully_cached   partially_cached_no_callable_hop
   */
  function rowOutcome (row, rowHops) {
    if (row.suppressed) return 'suppressed';
    if (rowHops.some((h) => h.action === 'call')) return 'has_work';
    const cached = rowHops.filter((h) => h.action === 'skipped_cache').length;
    if (cached === 0) return 'no_callable_hop';
    return cached === rowHops.length ? 'fully_cached' : 'partially_cached_no_callable_hop';
  }
  const perHop = waterfall.map((hop, index) => ({
    hop: index,
    endpoint: hop.endpoint,
    capability_group: catalog.endpoints[hop.endpoint].capability_group,
    conditional: Boolean(hop.conditional),
    calls_planned: 0,
    skipped_cache: 0,
    skipped_suppressed: 0,
    not_applicable: 0,
    credits_estimated: 0,
    credits_unknown_calls: 0,
    unit_credits: null,
    bounded: true,
  }));

  let creditsCeiling = 0;
  let creditsFloor = 0;
  let unknownCalls = 0;
  let rowsSuppressed = 0;
  let rowsFullyCached = 0;
  let rowsPartiallyCached = 0;
  let rowsNoCallableHop = 0;

  for (const raw of rows) {
    const row = assertRowDescriptor(raw);
    const has = new Set(row.has ?? []);
    const cached = new Set(row.cached ?? []);
    const rowHops = [];
    let rowCredits = 0;
    let rowUnknown = 0;

    for (let hopIndex = 0; hopIndex < waterfall.length; hopIndex += 1) {
      const hop = waterfall[hopIndex];
      const def = catalog.endpoints[hop.endpoint];
      const price = priceCall(def, { expectedResults: hop.expected_results ?? null });
      perHop[hopIndex].unit_credits = price.credits;
      perHop[hopIndex].bounded = price.bounded;

      if (hop.only_if_missing && has.has(hop.only_if_missing)) {
        perHop[hopIndex].not_applicable += 1;
        rowHops.push({
          hop: hopIndex, endpoint: hop.endpoint, action: 'not_applicable',
          reason: `row already has ${hop.only_if_missing}`, credits_estimated: 0,
        });
        continue;
      }

      if (row.suppressed) {
        perHop[hopIndex].skipped_suppressed += 1;
        rowHops.push({
          hop: hopIndex, endpoint: hop.endpoint, action: 'skipped_suppressed',
          reason: 'suppression list — dropped before any call', credits_estimated: 0,
        });
        units.push({
          row_id: row.row_id, hop: hopIndex, endpoint: hop.endpoint,
          credits_estimated: 0, skip: 'suppressed',
        });
        continue;
      }

      if (cached.has(hop.endpoint)) {
        perHop[hopIndex].skipped_cache += 1;
        rowHops.push({
          hop: hopIndex, endpoint: hop.endpoint, action: 'skipped_cache',
          reason: 'read-through cache hit — not charged', credits_estimated: 0,
        });
        units.push({
          row_id: row.row_id, hop: hopIndex, endpoint: hop.endpoint,
          credits_estimated: 0, skip: 'cache',
        });
        continue;
      }

      perHop[hopIndex].calls_planned += 1;
      if (price.credits == null) {
        perHop[hopIndex].credits_unknown_calls += 1;
        unknownCalls += 1;
        rowUnknown += 1;
      } else {
        perHop[hopIndex].credits_estimated += price.credits;
        rowCredits += price.credits;
        creditsCeiling += price.credits;
        if (!hop.conditional) creditsFloor += price.credits;
      }
      rowHops.push({
        hop: hopIndex,
        endpoint: hop.endpoint,
        action: 'call',
        basis: price.basis,
        conditional: Boolean(hop.conditional),
        credits_estimated: price.credits,
      });
      units.push({
        row_id: row.row_id, hop: hopIndex, endpoint: hop.endpoint,
        credits_estimated: price.credits ?? 0,
      });
    }

    const outcome = rowOutcome(row, rowHops);
    if (outcome === 'suppressed') rowsSuppressed += 1;
    else if (outcome === 'fully_cached') rowsFullyCached += 1;
    else if (outcome === 'partially_cached_no_callable_hop') rowsPartiallyCached += 1;
    else if (outcome === 'no_callable_hop') rowsNoCallableHop += 1;

    planRows.push({
      row_id: row.row_id,
      suppressed: Boolean(row.suppressed),
      outcome,
      hops: rowHops,
      credits_estimated: rowCredits,
      credits_unknown_calls: rowUnknown,
    });
  }

  const callsPlanned = perHop.reduce((sum, h) => sum + h.calls_planned, 0);

  return {
    schema: 'gtm.dryrun_plan.v1',
    run_id: runId,
    generated_at: now(),
    dry_run: true,
    waterfall: waterfall.map((h, i) => ({ hop: i, endpoint: h.endpoint, conditional: Boolean(h.conditional) })),
    rows: planRows,
    per_hop: perHop,
    totals: {
      rows_total: planRows.length,
      rows_suppressed: rowsSuppressed,
      rows_fully_cached: rowsFullyCached,
      rows_partially_cached: rowsPartiallyCached,
      rows_no_callable_hop: rowsNoCallableHop,
      // Kept as the sum of the two no-work-and-not-cached-clean cases, because
      // consumers already read it. Add-only: renaming a totals key silently
      // zeroes any reader that has not been updated.
      rows_no_work: rowsPartiallyCached + rowsNoCallableHop,
      calls_planned: callsPlanned,
      skipped_cache: perHop.reduce((s, h) => s + h.skipped_cache, 0),
      skipped_suppressed: perHop.reduce((s, h) => s + h.skipped_suppressed, 0),
      not_applicable: perHop.reduce((s, h) => s + h.not_applicable, 0),
      credits_estimated: creditsCeiling,
      credits_estimated_floor: creditsFloor,
      credits_unknown_calls: unknownCalls,
      estimate_is_ceiling: waterfall.some((h) => h.conditional),
    },
    eta: estimateEta({ callsPlanned, perHop, rateLimits }),
    conditional_economics: conditionalEconomics({ perHop, priorObservations }),
    units,
    catalog_provenance: {
      spec_sha256: catalog.spec_sha256 ?? null,
      spec_version: catalog.spec_version ?? null,
      generated_at: catalog.generated_at ?? null,
    },
  };
}

/**
 * Aggregate an OBSERVED hit rate out of real prior runs. Returns null when there is
 * nothing real to aggregate — never a default, never a plausible-looking number.
 *
 * `priorObservations` is [{ endpoint, calls, found, run_id? }]. Counts only; no row
 * ids, no contact values, so this stays on the right side of the planner's PII line.
 * `found` is clamped to `calls` because a rate above full is not an observation, it
 * is a bad input, and the plan must not launder one into a percentage.
 */
export function observedHitRates(priorObservations) {
  if (!Array.isArray(priorObservations) || priorObservations.length === 0) return null;
  const byEndpoint = {};
  const runs = new Set();
  let usable = 0;
  for (const o of priorObservations) {
    if (!o || typeof o.endpoint !== 'string') continue;
    const calls = Number(o.calls);
    const found = Number(o.found);
    if (!Number.isFinite(calls) || !Number.isFinite(found) || calls <= 0 || found < 0) continue;
    const e = (byEndpoint[o.endpoint] ??= { runs: 0, calls: 0, found: 0, hit_rate_pct: null });
    e.runs += 1;
    e.calls += calls;
    e.found += Math.min(found, calls);
    usable += 1;
    if (typeof o.run_id === 'string' && o.run_id) runs.add(o.run_id);
  }
  if (usable === 0) return null;
  let maxRuns = 0;
  for (const e of Object.values(byEndpoint)) {
    e.hit_rate_pct = Math.round((e.found / e.calls) * 1000) / 10;
    if (e.runs > maxRuns) maxRuns = e.runs;
  }
  return {
    basis: 'observed_from_prior_runs',
    is_forecast: false,
    runs_observed: runs.size || maxRuns,
    by_endpoint: byEndpoint,
  };
}

/**
 * What the plan CAN honestly say about misses before a single call is made.
 *
 * The billing rule is the spec's own and the ledger already encodes it in
 * `resolveActual`: only a non-2xx deducts no credits. So a 2xx that found nothing is
 * a successful call, charged in full, and the total this plan prints is not only the
 * ceiling on spend — it is exactly the bill for a run in which every call misses.
 *
 * The hop that most needs saying is the conditional one. `conditional: true` means
 * the hop fires only because an EARLIER hop found something; it does not mean the hop
 * is refunded when it finds nothing itself. `estimate_is_ceiling` already told the
 * user the total might not all be spent. It never told them that all of it can be
 * spent for no records at all.
 */
export function conditionalEconomics({ perHop, priorObservations = null }) {
  const billed = perHop
    .filter((h) => h.calls_planned > 0)
    .map((h) => ({
      hop: h.hop,
      endpoint: h.endpoint,
      conditional: h.conditional,
      calls_planned: h.calls_planned,
      unit_credits: h.unit_credits,
      credits_if_all_miss: h.credits_estimated,
      credits_unknown_calls: h.credits_unknown_calls,
    }));
  // WHICH HOPS ACTUALLY FIRE WHEN EVERYTHING MISSES.
  //
  // A `conditional` hop fires only because an EARLIER hop found something. So in the
  // run where every call misses, a conditional hop is never reached — and summing it
  // into "if every call misses you still pay X" contradicted the line directly above
  // it, which said the floor was the unconditional total. Live 2026-09-17: "floor 0 if
  // no conditional hop fires" printed two lines above "if every one of those calls
  // misses you still pay 14". Both were rendered from this plan; one of them was wrong.
  //
  // The floor and this number are now the SAME arithmetic — the unconditional hops —
  // and the conditional hops are reported separately, as what they are: the difference
  // between the floor and the ceiling.
  const unconditional = billed.filter((h) => !h.conditional);
  const conditional = billed.filter((h) => h.conditional);
  return {
    billing_rule: 'only a non-2xx is unbilled — a 2xx that found nothing is a successful '
      + 'call and is charged in full',
    bills_on_miss: billed,
    credits_if_every_call_misses: unconditional.reduce((sum, h) => sum + h.credits_if_all_miss, 0),
    calls_billed_on_miss: unconditional.reduce((sum, h) => sum + h.calls_planned, 0),
    // What the conditional hops add IF they fire and then miss on their own account.
    credits_conditional_if_fired_and_missed: conditional.reduce((sum, h) => sum + h.credits_if_all_miss, 0),
    calls_conditional: conditional.reduce((sum, h) => sum + h.calls_planned, 0),
    // A plan cannot know this run's hit rate and must not invent one. Cost per found
    // record is reported by the receipt, after the run, from the ledger and the
    // mapping audit.
    hit_rate_is_forecast: false,
    hit_rate_available_before_run: false,
    observed: observedHitRates(priorObservations),
  };
}

/**
 * An ETA is publishable only once per-endpoint rate-limit quotas are known, which
 * the API does not document yet. Until `rateLimits` is injected this returns "unavailable, and here is why" rather
 * than an invented number.
 */
export function estimateEta({ callsPlanned, perHop, rateLimits }) {
  if (!rateLimits) return { ...ETA_UNAVAILABLE, calls_planned: callsPlanned };
  let seconds = 0;
  let complete = true;
  for (const hop of perHop) {
    const rpm = rateLimits[hop.endpoint]?.requests_per_minute ?? rateLimits.default?.requests_per_minute;
    if (!rpm) { complete = false; continue; }
    seconds += (hop.calls_planned / rpm) * 60;
  }
  if (!complete) {
    return {
      available: false,
      reason: 'rate-limit quota missing for at least one endpoint in this waterfall',
      calls_planned: callsPlanned,
    };
  }
  return {
    available: true,
    seconds: Math.ceil(seconds),
    basis: 'sum over hops of calls / requests_per_minute',
    calls_planned: callsPlanned,
  };
}

/**
 * Write the plan into the run journal and make ZERO calls.
 *
 * `client` is accepted only so a caller can inject one that throws on any use and
 * prove the zero-call property. It is never invoked.
 */
export function writeDryRun({ plan, journal, dir = 'gtm', client = null }) {
  void client; // deliberately unused: a dry run makes no calls
  const target = journal ?? new RunJournal({ runId: plan.run_id, dir });
  let pending = 0;
  let skipped = 0;
  for (const unit of plan.units) {
    if (unit.skip === 'suppressed' || unit.skip === 'cache') {
      // Terminal at plan time, not `pending`: a suppressed row written `pending` is one
      // resume away from being enriched, and a cache hit is already answered.
      target.appendResult(unit, {
        status: unit.skip === 'cache' ? 'skipped_cache' : 'skipped_suppressed',
        credits_actual: 0,
        attempt: 0,
      });
      skipped += 1;
    } else {
      // dry_run is the contract's own flag now. attempt 0 is kept alongside it so an
      // older journal, written before the field existed, still reads correctly.
      target.append({
        row_id: unit.row_id, hop: unit.hop, endpoint: unit.endpoint, status: 'pending',
        credits_estimated: unit.credits_estimated ?? null, attempt: 0, dry_run: true,
      });
      pending += 1;
    }
  }
  return { journal: target, path: target.path, pending_written: pending, skipped_written: skipped };
}

/**
 * Reconcile a plan against the ledger (ledger-line.schema.json — read only).
 * `tolerance` is stated, not implied: the caller sees the number it was judged against.
 *
 * Never upgrades an estimate to an actual: if any ledger line for the run is
 * `estimated_unverifiable`, the reconciliation says so.
 */
export function reconcile({ plan, ledgerLines, tolerance = 0.10 }) {
  const mine = ledgerLines.filter((l) => l.run_id === plan.run_id);
  let actual = 0;
  let unverifiable = 0;
  let notBilled = 0;
  for (const line of mine) {
    // A NON-2xx DEDUCTS NO CREDITS — the spec's own billing rule, already encoded by
    // `ledger.resolveActual` as `cost_status: 'known_zero'`. The line still carries the
    // pre-call estimate it was written with (a failed email_finder keeps
    // `credits_estimated: 5` beside `credits_actual: 0`), and summing that estimate
    // booked spend for a call nobody was charged for: eight 503s on the 2026-09-17 runs
    // reconciled as 40 credits of drift that never left the account.
    if (line.cost_status === 'known_zero') { notBilled += 1; continue; }
    if (line.cost_status === 'actual' && typeof line.credits_actual === 'number') {
      actual += line.credits_actual;
    } else {
      actual += line.credits_estimated;
      unverifiable += 1;
    }
  }
  const planned = plan.totals.credits_estimated;
  const drift = actual - planned;
  const driftPct = planned === 0 ? (actual === 0 ? 0 : Infinity) : drift / planned;
  return {
    planned,
    actual,
    drift,
    drift_pct: driftPct,
    tolerance,
    within_tolerance: Math.abs(driftPct) <= tolerance,
    ledger_lines: mine.length,
    cost_status: unverifiable > 0 ? 'estimated_unverifiable' : 'actual',
    unverifiable_lines: unverifiable,
    // Named, not silent: the reader can see WHY the ledger sum is below the plan.
    not_billed_lines: notBilled,
    not_billed_rule: notBilled > 0
      ? `${notBilled} call(s) returned a non-2xx and deduct no credits — their pre-call `
        + 'estimates are excluded from this total'
      : null,
  };
}

/**
 * The block that tells the user what a miss costs BEFORE they approve, rather than
 * leaving them to discover it in the receipt afterwards. Returns [] when nothing is
 * planned, so an all-cached plan grows no section.
 */
export function renderConditionalEconomics(ce) {
  if (!ce || ce.bills_on_miss.length === 0) return [];
  const out = ['', 'Billed on a miss:'];
  out.push(`  ${ce.billing_rule}.`);
  for (const h of ce.bills_on_miss) {
    const unit = h.unit_credits == null ? 'unknown' : `${h.unit_credits}cr`;
    out.push(
      `  hop ${h.hop}  ${h.endpoint.padEnd(24)} ${String(h.calls_planned).padStart(5)} calls @ ${unit}`
      + `  = ${h.credits_if_all_miss}cr charged even if none of them finds anything`
      + (h.conditional ? '  | conditional: fires on an earlier hop\'s find, bills on its own miss' : ''),
    );
  }
  out.push(`  If every one of those ${ce.calls_billed_on_miss} unconditional calls misses you still `
    + `pay ${ce.credits_if_every_call_misses} credits and get 0 records — that is the FLOOR.`);
  if (ce.calls_conditional > 0) {
    out.push(`  The ${ce.calls_conditional} conditional call(s) are not reached in that run at all. `
      + `Every one that DOES fire and then misses adds to it, up to ${ce.credits_conditional_if_fired_and_missed} `
      + 'credits more — that is the gap between the floor and the ceiling above.');
  }
  if (ce.observed) {
    const parts = Object.entries(ce.observed.by_endpoint)
      .map(([ep, e]) => `${ep} ${e.found}/${e.calls} = ${e.hit_rate_pct}%`);
    out.push(`  Observed over ${ce.observed.runs_observed} prior run(s) — a record, NOT a forecast `
      + `for this list: ${parts.join('; ')}.`);
  } else {
    out.push('  No observed hit rate is available, and this plan does not forecast one.');
  }
  out.push('  Cost per found record is reported by the receipt, after the run.');
  return out;
}

/**
 * The human-reviewable plan. ROW-LEVEL and therefore LOCAL ONLY — this render carries
 * row_ids, which are caller-supplied and may themselves be identifiers. The shareable
 * form is `share-render.mjs`, which is aggregate-only by construction.
 */
export function renderPlanText(plan, { maxRows = 20 } = {}) {
  const t = plan.totals;
  const out = [];
  out.push(`DRY RUN — plan for run ${plan.run_id} (no calls made)`);
  out.push('');
  out.push(`Waterfall: ${plan.waterfall.map((h) => `${h.hop}:${h.endpoint}${h.conditional ? '?' : ''}`).join(' -> ')}`);
  out.push('');
  out.push('Per hop:');
  for (const hop of plan.per_hop) {
    const unit = hop.unit_credits == null ? 'unknown' : `${hop.unit_credits}cr`;
    out.push(
      `  hop ${hop.hop}  ${hop.endpoint.padEnd(24)} ${String(hop.calls_planned).padStart(5)} calls @ ${unit}`
      + `  = ${hop.credits_estimated}cr`
      + (hop.skipped_cache ? `  | ${hop.skipped_cache} cached (not charged)` : '')
      + (hop.skipped_suppressed ? `  | ${hop.skipped_suppressed} suppressed (dropped)` : '')
      + (hop.not_applicable ? `  | ${hop.not_applicable} n/a` : '')
      + (hop.bounded ? '' : '  | UNBOUNDED — page-gated'),
    );
  }
  out.push('');
  out.push('Rows:');
  for (const row of plan.rows.slice(0, maxRows)) {
    const detail = row.hops
      .map((h) => `${h.endpoint}=${h.action === 'call' ? `${h.credits_estimated ?? '?'}cr` : h.action}`)
      .join(', ');
    out.push(`  ${row.row_id.padEnd(20)} ${detail}  => ${row.credits_estimated}cr`);
  }
  if (plan.rows.length > maxRows) out.push(`  ... ${plan.rows.length - maxRows} more rows`);
  out.push('');
  // Each zero-cost reason is named separately. "Nothing to do" and "already
  // have it" are opposite news for the person reading the plan: one means the
  // list is cheap, the other means the list is unusable and no credits will
  // tell them so.
  const why = [`${t.rows_suppressed} suppressed/dropped`, `${t.rows_fully_cached} fully cached`];
  if (t.rows_partially_cached) why.push(`${t.rows_partially_cached} part-cached, rest not runnable`);
  if (t.rows_no_callable_hop) why.push(`${t.rows_no_callable_hop} with no usable input`);
  out.push(`Rows:        ${t.rows_total} (${why.join(', ')})`);
  out.push(`Calls:       ${t.calls_planned} (${t.skipped_cache} cache hits skipped, not charged)`);
  out.push(
    `TOTAL:       ${t.credits_estimated} credits`
    + (t.estimate_is_ceiling ? ` (ceiling; floor ${t.credits_estimated_floor} if no conditional hop fires)` : ''),
  );
  if (t.credits_unknown_calls > 0) {
    out.push(`WARNING:     ${t.credits_unknown_calls} calls have no usable price in the catalog — cost UNKNOWN, not zero`);
  }
  out.push(...renderConditionalEconomics(plan.conditional_economics));
  out.push(`ETA:         ${plan.eta.available ? `~${plan.eta.seconds}s` : `unavailable — ${plan.eta.reason}`}`);
  out.push('');
  out.push('Approve this plan to run it. Resume re-plans only rows not already done.');
  return out.join('\n');
}
