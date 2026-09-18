// _lib/receipt.mjs — the session receipt.
//
// Receipt FIRST, upsell second. This is the last arrow in the funnel (credits burned
// -> paid), and the fastest way to break it is to overstate what a run bought.
//
// The hard rule, and the reason this module exists rather than a paragraph in the
// router's prompt: A RECEIPT CLAIM MAY NEVER EXCEED LEDGER ACTUALS. Eleven of
// twenty-one metered endpoints do not report their charge, so for those the estimate
// is all we have. A receipt that silently promotes an estimate to "you spent" is the
// same honor-system math the old pack was criticised for, moved into a nicer format.
//
// So the receipt reports a RANGE whenever any line is unverifiable, and says which is
// which. "At least 40, up to 62" is honest. "You spent 62" is not.
//
// It reuses the ledger's own totals rather than recomputing them, so there is exactly
// one cost calculation in the pack and the receipt cannot drift from it.
//
// COST PER CALL IS NOT COST PER RECORD. /enrich-waterfall's chain calls email_finder
// and phone_finder on every eligible row and the API bills every SUCCESSFUL call — a
// 2xx that carries no email is a successful call. So a hop that misses is a hop that
// billed, and the per-call figure above is strictly smaller than what the operator
// spends per record actually found. Two GTM reviewers independently flagged that the
// pack reported the first number everywhere and the second nowhere. `costPerFound`
// below reports the second, per capability, in the same range language and under the
// same never-overstate guard as the spend itself.

import { gateValue } from './gates.mjs';
import { renderMappingAlert, renderUnmappedNote } from './mapping-audit.mjs';
import { RESPONSE_MAPS } from './client.mjs';

export class ReceiptOverstatement extends Error {
  constructor (msg) { super(msg); this.name = 'ReceiptOverstatement'; }
}

/** A receipt that spent money and hid a mapping failure. See _lib/mapping-audit.mjs. */
export class MappingFailureUnreported extends Error {
  constructor (msg) { super(msg); this.name = 'MappingFailureUnreported'; }
}

/**
 * Build the receipt from a ledger. `balance` may be null — `GET /usage` is documented
 * in prose only and is absent from the spec's `paths:`, so an unknown
 * balance is normal and must degrade to estimate language, never to a guess.
 */
export function buildReceipt ({ ledger, balance = null, balanceSource = 'unknown', gates = null, runLabel = null, mapping = null }) {
  const t = ledger.totals();          // the single cost calculation, not a fork of it
  const lines = ledger.lines ?? [];

  // One pass over the raw lines, reused by both the per-endpoint table and the
  // per-capability cost-per-found block, so the two can never disagree about what a
  // single endpoint cost.
  const spend = spendByEndpoint(lines);
  const byEndpoint = {};
  for (const [ep, e] of Object.entries(spend)) {
    byEndpoint[ep] = {
      calls: e.lines, verified: e.actual, unverifiable: e.estimated, known_zero: e.known_zero_lines,
      provider_error: e.provider_error_lines,
    };
  }

  const floor = t.credits_actual;                                   // what we can prove
  const ceiling = t.credits_actual + t.credits_estimated_unverifiable; // the honest upper bound
  const exact = t.unverifiable_lines === 0;

  // Plan fit uses the session-budget suggestion from gates.yaml rather than a number
  // typed here. Law 1 applies to this file too.
  let tier = null;
  try { tier = gates ? gateValue(gates, 'session_budget.suggestion_credits') : null; } catch { tier = null; }

  return {
    run: runLabel,
    calls: lines.length,
    credits_floor: round(floor),
    credits_ceiling: round(ceiling),
    exact,
    verified_lines: t.verified_lines,
    unverifiable_lines: t.unverifiable_lines,
    known_zero_lines: t.known_zero_lines ?? 0,
    // A 2xx whose body said `billed: false`. Not a charge, and NOT a not-found:
    // the provider errored and the row still needs asking.
    provider_error_lines: t.provider_error_lines ?? 0,
    by_endpoint: byEndpoint,
    balance,
    balance_source: balanceSource,
    balance_known: balance !== null && Number.isFinite(balance),
    tier_credits: Number.isFinite(tier) ? tier : null,

    // --- the empty-column tripwire ---
    //
    // A receipt reports what a run BOUGHT. Credits are only half of that; the other
    // half is whether any of it arrived as a column. A run whose fields all mapped to nothing was invisible precisely
    // because the receipt could only speak about money.
    //
    // `mapping` is null when the caller ran no audit (a dry run, a hand-built
    // receipt). Null means "not measured", which is NOT the same as "clean", so
    // the flags below stay false and renderReceipt says nothing rather than
    // implying a green result it did not observe.
    mapping: mapping ?? null,
    mapping_failures: mapping?.mapping_failures ?? 0,
    // Delivered raw because the endpoint has no map. NOT a failure — see
    // _lib/mapping-audit.mjs. Reported separately so a coverage gap is visible
    // without borrowing the word that means "we lost data you paid for".
    mapping_unmapped: mapping?.unmapped_responses ?? 0,
    unmapped_endpoints: mapping?.unmapped_endpoints ?? [],
    columns_delivered: mapping?.columns_delivered ?? null,
    // Paid for calls, delivered no columns. The empty-mapping failure, named.
    mapping_blackout: Boolean(mapping?.total_blackout),

    // --- the miss-billing surface ---
    //
    // Empty on any run that touched neither capability hop, which is why the
    // existing per-call receipt is unchanged for every other skill in the pack.
    cost_per_found: costPerFound({ lines, mapping, spend }),
  };
}

/**
 * Per-endpoint spend, split exactly the way the ledger splits it.
 * `actual` and `estimated` are CREDITS; the `_lines` fields are COUNTS.
 */
function spendByEndpoint (lines) {
  const by = {};
  for (const l of lines ?? []) {
    const e = (by[l.endpoint] ??= {
      lines: 0, actual: 0, estimated: 0,
      verified_lines: 0, unverifiable_lines: 0, known_zero_lines: 0, provider_error_lines: 0,
    });
    e.lines += 1;
    if (l.not_billed_reason === 'provider_error') e.provider_error_lines += 1;
    if (l.cost_status === 'actual') { e.actual += Number(l.credits_actual ?? 0); e.verified_lines += 1; }
    else if (l.cost_status === 'known_zero') { e.known_zero_lines += 1; }
    else { e.estimated += Number(l.credits_estimated ?? 0); e.unverifiable_lines += 1; }
  }
  return by;
}

/**
 * The capabilities an operator actually buys, and the hop that buys each one.
 *
 * `column` is the output column that PROVES the capability arrived. It is asserted
 * against client.mjs's RESPONSE_MAPS by `capabilityColumnIsMapped` and by
 * tests/cli/cost-per-found.test.mjs, so renaming a mapped column fails there rather
 * than silently reporting every run as a total miss.
 *
 * email_verifier is deliberately absent even though its map also carries `email`: it
 * verifies an address an earlier hop already bought, so counting its responses as
 * email finds would count one email twice and halve the reported unit cost.
 */
export const FOUND_CAPABILITIES = Object.freeze([
  Object.freeze({ capability: 'email', endpoint: 'email_finder', column: 'email' }),
  Object.freeze({ capability: 'phone', endpoint: 'phone_finder', column: 'phone' }),
]);

/** True when the capability's finder endpoint really maps the column named above. */
export function capabilityColumnIsMapped (cap) {
  const map = Object.prototype.hasOwnProperty.call(RESPONSE_MAPS, cap?.endpoint)
    ? RESPONSE_MAPS[cap.endpoint]
    : null;
  return Boolean(map) && Object.values(map).includes(cap.column);
}

/**
 * Cost per FOUND record, per capability — the unit /enrich-waterfall actually spends
 * in, and the one nothing in the pack used to print.
 *
 * The find/miss counts come from the mapping audit, which is the only per-response
 * classification the run keeps: `mapped` is a response that produced at least one
 * column, `empty` is a genuine not-found, `failures` is a paid response the field map
 * could not read. All three billed. Only the first is a find.
 *
 * WHAT THIS CANNOT SEE, stated rather than papered over: the audit records how many
 * responses mapped, not WHICH columns each one carried, so `found` is "responses that
 * delivered at least one of this endpoint's columns" and not "responses that carried
 * `column`". For email_finder and phone_finder those coincide on every recorded
 * fixture — their maps are the address/number plus its own metadata — but a response
 * carrying only `email_confidence` would be counted as a find. Closing that gap needs
 * `createMappingAudit().record` to keep the per-response column list, and
 * createExecClient in enrich.mjs already hands it the inspection that carries one.
 *
 * A capability with zero finds returns null for both per-found figures. There is no
 * number to print, and printing one is exactly the arithmetic this module exists to
 * refuse.
 */
export function costPerFound ({ lines = [], mapping = null, spend = null }) {
  const by = spend ?? spendByEndpoint(lines);
  const out = [];
  for (const cap of FOUND_CAPABILITIES) {
    const e = by[cap.endpoint];
    const audited = mapping?.by_endpoint?.[cap.endpoint] ?? null;
    if (!e && !audited) continue;                 // this run never touched the hop
    const s = e ?? { lines: 0, actual: 0, estimated: 0, verified_lines: 0, unverifiable_lines: 0, known_zero_lines: 0, provider_error_lines: 0 };
    const floor = round(s.actual);
    const ceiling = round(s.actual + s.estimated);
    const exact = s.unverifiable_lines === 0;
    const measured = audited !== null;
    const calls = measured ? Number(audited.calls ?? 0) : null;
    const found = measured ? Number(audited.mapped ?? 0) : null;
    out.push({
      capability: cap.capability,
      endpoint: cap.endpoint,
      column: cap.column,
      billed_calls: s.lines - s.known_zero_lines,
      free_calls: s.known_zero_lines,
      calls,
      found,
      // The mapping audit sees a provider-error body as an empty response and
      // counts it `empty`, i.e. a genuine not-found. It is not one: nothing was
      // billed and the row was never actually looked up. Subtract them here (the
      // audit itself cannot tell the two apart — see _lib/mapping-audit.mjs).
      provider_errors: s.provider_error_lines,
      not_found: measured ? Math.max(0, Number(audited.empty ?? 0) - s.provider_error_lines) : null,
      unreadable: measured ? Number(audited.failures ?? 0) : null,
      hit_rate_pct: measured && calls > 0 ? round1((found / calls) * 100) : null,
      credits_floor: floor,
      credits_ceiling: ceiling,
      verified_lines: s.verified_lines,
      unverifiable_lines: s.unverifiable_lines,
      exact,
      // Divide by zero renders as a sentence, never as a number: null here, and
      // costPerFoundPhrase says "0 found, N credits spent" in words.
      cost_per_found_floor: found > 0 ? round(floor / found) : null,
      cost_per_found_ceiling: found > 0 ? round(ceiling / found) : null,
      // `measured` is reserved for a figure whose every ledger line the API confirmed.
      // Anything resting on an unverifiable line is `estimated` and says so.
      basis: !measured ? 'unmeasured' : (found > 0 ? (exact ? 'measured' : 'estimated') : 'no_finds'),
    });
  }
  return out;
}

const round = (n) => Math.round((Number(n) || 0) * 1000) / 1000;
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

/**
 * The overstatement guard: a receipt may never claim more than the ledger can
 * support. Throws rather than returning false, because a silently-wrong receipt is
 * the failure this is here to prevent.
 */
export function assertNeverOverstates (receipt, ledger) {
  // Recompute from the RAW LINES, not from ledger.totals(). buildReceipt derives its
  // floor and ceiling from totals(), so checking against totals() again compared a
  // value with itself: the guard could not fire on any receipt the code actually
  // produces, only on a hand-built one, and nothing hand-builds them.
  let actual = 0, estimated = 0;
  const perEndpoint = {};
  for (const l of ledger.lines ?? []) {
    const e = (perEndpoint[l.endpoint] ??= { actual: 0, estimated: 0, unverifiable: 0 });
    if (l.cost_status === 'actual') { actual += Number(l.credits_actual ?? 0); e.actual += Number(l.credits_actual ?? 0); }
    else if (l.cost_status === 'estimated_unverifiable') {
      estimated += Number(l.credits_estimated ?? 0);
      e.estimated += Number(l.credits_estimated ?? 0);
      e.unverifiable += 1;
    }
  }
  const t = { credits_actual: round(actual), credits_estimated_unverifiable: round(estimated), unverifiable_lines: (ledger.lines ?? []).filter(l => l.cost_status === 'estimated_unverifiable').length };
  const ceiling = t.credits_actual + t.credits_estimated_unverifiable;
  if (receipt.credits_floor > t.credits_actual + 1e-9) {
    throw new ReceiptOverstatement(
      `receipt floor ${receipt.credits_floor} exceeds verified ledger actuals ${t.credits_actual}`);
  }
  if (receipt.credits_ceiling > ceiling + 1e-9) {
    throw new ReceiptOverstatement(
      `receipt ceiling ${receipt.credits_ceiling} exceeds what the ledger can support (${ceiling})`);
  }
  if (receipt.exact && t.unverifiable_lines > 0) {
    throw new ReceiptOverstatement(
      `receipt claims an exact figure while ${t.unverifiable_lines} ledger line(s) are unverifiable`);
  }

  // --- the same discipline, one level down: cost per found record ---
  //
  // A per-capability figure may never claim more than that endpoint's own raw lines
  // support, may never be called `measured` while resting on an unverifiable line,
  // and may never render a divide-by-zero as a number. Recomputed from perEndpoint
  // above — the raw lines, not the fields costPerFound derived — so it can actually
  // fire on a receipt the code produces, unlike a guard
  // that re-reads the fields it is checking.
  for (const c of receipt.cost_per_found ?? []) {
    const e = perEndpoint[c.endpoint] ?? { actual: 0, estimated: 0, unverifiable: 0 };
    const epActual = round(e.actual);
    const epCeiling = round(e.actual + e.estimated);
    const where = `${c.capability} (${c.endpoint})`;
    if (c.credits_floor > epActual + 1e-9) {
      throw new ReceiptOverstatement(
        `${where}: claims ${c.credits_floor} verified credits, ledger actuals are ${epActual}`);
    }
    if (c.credits_ceiling > epCeiling + 1e-9) {
      throw new ReceiptOverstatement(
        `${where}: claims a ceiling of ${c.credits_ceiling}, the ledger supports ${epCeiling}`);
    }
    if ((c.exact || c.basis === 'measured') && e.unverifiable > 0) {
      throw new ReceiptOverstatement(
        `${where}: presented as measured while ${e.unverifiable} of its ledger line(s) do not report a charge`);
    }
    for (const key of ['cost_per_found_floor', 'cost_per_found_ceiling', 'hit_rate_pct']) {
      const v = c[key];
      if (v !== null && !Number.isFinite(v)) {
        throw new ReceiptOverstatement(
          `${where}: ${key} is ${v} — a divide by zero is not a figure, it is "0 found"`);
      }
    }
    if (c.hit_rate_pct !== null && c.hit_rate_pct > 100 + 1e-9) {
      throw new ReceiptOverstatement(`${where}: hit rate ${c.hit_rate_pct}% exceeds the calls made`);
    }
    if (!(c.found > 0)) {
      if (c.cost_per_found_floor !== null || c.cost_per_found_ceiling !== null) {
        throw new ReceiptOverstatement(
          `${where}: states a cost per found record while ${c.found === null ? 'no finds were measured' : '0 were found'}`);
      }
    } else {
      if (c.cost_per_found_ceiling === null || c.cost_per_found_floor === null) {
        throw new ReceiptOverstatement(
          `${where}: ${c.found} found but no cost per found record — the operator's unit was dropped`);
      }
      if (c.cost_per_found_floor > (epActual / c.found) + 1e-9) {
        throw new ReceiptOverstatement(
          `${where}: ${c.cost_per_found_floor}/found exceeds verified ${epActual} over ${c.found} found`);
      }
      if (c.cost_per_found_ceiling > (epCeiling / c.found) + 1e-9) {
        throw new ReceiptOverstatement(
          `${where}: ${c.cost_per_found_ceiling}/found exceeds ${epCeiling} over ${c.found} found`);
      }
    }
  }
  return true;
}

/**
 * The delivery guard, the twin of assertNeverOverstates.
 *
 * A receipt may never report a spend without reporting that the spend bought
 * nothing readable. The same lesson applies: this recomputes from the AUDIT's raw
 * per-endpoint counters rather than from the same fields buildReceipt derived its
 * flags from, so it can actually fire on a receipt the code produces — a guard that
 * compares a value with itself is not a guard.
 *
 * Pass the audit summary explicitly. Called with no summary it is a no-op, because
 * "not measured" must not masquerade as "verified clean".
 */
export function assertMappingSurfaced (receipt, summary = null) {
  if (!summary) return true;
  let calls = 0, failures = 0, unmapped = 0, providerError = 0;
  const columns = new Set();
  for (const e of Object.values(summary.by_endpoint ?? {})) {
    calls += Number(e.calls ?? 0);
    failures += Number(e.failures ?? 0);
    unmapped += Number(e.unmapped ?? 0);
    providerError += Number(e.provider_error ?? 0);
    for (const c of e.columns ?? []) columns.add(c);
  }
  // Same rule as mapping-audit's `summary()`, and it has to stay the same rule: a run
  // whose every call went to an endpoint with NO map delivered the raw body and lost
  // nothing, so zero columns is the correct answer rather than a hidden blackout. This
  // guard recomputing a different predicate is how it threw on a healthy run.
  // A call the API says it did not bill is not a billed call that delivered nothing.
  // Counting provider errors here crashed the CLI on every run whose only calls were
  // unbilled (live, 2026-09-17): the guard threw, so no receipt and no server message
  // reached the user at all.
  const blackout = calls > 0 && columns.size === 0 && (unmapped + providerError) < calls;
  if (failures > 0 && !(receipt.mapping_failures > 0)) {
    throw new MappingFailureUnreported(
      `${failures} mapping failure(s) occurred but the receipt reports ${receipt.mapping_failures ?? 0}`);
  }
  if (blackout && !receipt.mapping_blackout) {
    throw new MappingFailureUnreported(
      `${calls - unmapped - providerError} billed call(s) delivered 0 columns and the receipt does not say so`);
  }
  return true;
}

/** How the spend should be spoken about. One place, so no caller invents wording. */
export function spendPhrase (r) {
  if (r.calls === 0) return 'Nothing was spent.';
  if (r.exact) return `Spent ${r.credits_floor} credits.`;
  if (r.credits_floor === 0) {
    return `Spent up to ${r.credits_ceiling} credits — none of these endpoints report their charge, so this is an estimate.`;
  }
  return `Spent at least ${r.credits_floor} credits, up to ${r.credits_ceiling}. `
    + `${r.unverifiable_lines} call(s) do not report a charge, so the rest is estimated.`;
}

/**
 * The range language, factored out so a per-found figure cannot invent its own.
 * `spendPhrase` above and every phrase below speak in exactly these three shapes:
 * an exact figure, an "up to" when nothing is verified, and a "between" otherwise.
 */
function rangeWords (floor, ceiling, exact, unverifiableLines, unit) {
  if (exact) return `${floor} ${unit}`;
  if (floor === 0) {
    return `up to ${ceiling} ${unit} — ${unverifiableLines} call(s) do not report a charge, so this is an estimate`;
  }
  return `between ${floor} and ${ceiling} ${unit}; `
    + `${unverifiableLines} call(s) do not report a charge, so the upper half is estimated`;
}

/**
 * One capability's line. Never prints a division that did not happen: the zero-find
 * case is a sentence about credits spent, and the unmeasured case says it is unknown
 * rather than implying it is low.
 */
export function costPerFoundPhrase (c) {
  const cap = c.capability;
  if (c.basis === 'unmeasured') {
    return `${cap}: ${c.billed_calls} billed call(s) on ${c.endpoint}, and this run recorded no `
      + `find/miss data — cost per ${cap} found is unknown, which is not the same as low.`;
  }
  const providerNote = c.provider_errors > 0
    ? ` ${c.provider_errors} of those call(s) returned a provider error and were not billed — retry, not a miss.`
    : '';
  if (c.found === 0) {
    // The qualifier trails the sentence rather than splitting "credits ... spent",
    // so the amount and the word "spent" stay adjacent and the line reads once.
    const spent = c.exact
      ? `${c.credits_floor} credits spent regardless`
      : (c.credits_floor === 0
        ? `up to ${c.credits_ceiling} credits spent regardless (estimated — `
          + `${c.unverifiable_lines} call(s) do not report a charge)`
        : `between ${c.credits_floor} and ${c.credits_ceiling} credits spent regardless `
          + `(${c.unverifiable_lines} call(s) do not report a charge, so the upper half is estimated)`);
    return `${cap}: 0 found from ${c.calls} call(s); ${spent}. `
      + `Cost per ${cap} found is undefined — every one of those calls billed on a miss.${providerNote}`;
  }
  return `${cap}: ${c.found} found from ${c.calls} call(s), ${c.hit_rate_pct}% hit rate — `
    + `${rangeWords(c.cost_per_found_floor, c.cost_per_found_ceiling, c.exact, c.unverifiable_lines, `credits per ${cap} found`)}.${providerNote}`;
}

/**
 * Plan-fit, stated only when it can be stated honestly.
 *
 * Without a balance there is no arithmetic to do, so it says what it does not know
 * instead of inventing a number (the undocumented /usage endpoint is exactly this gap).
 */
export function planFit (r) {
  if (r.tier_credits === null) return null;
  const cost = r.exact ? r.credits_floor : r.credits_ceiling;
  if (!cost) return null;
  const perTier = Math.floor(r.tier_credits / cost);
  const about = r.exact ? '' : ' (using the upper bound, so this is conservative)';
  const lines = [`A run this size fits about ${perTier}x in ${r.tier_credits} credits${about}.`];
  if (r.balance_known) {
    lines.push(`Balance ${r.balance} — roughly ${Math.floor(r.balance / cost)} more runs like this one.`);
  } else {
    lines.push('Balance unknown, so that is a plan-size estimate rather than a remaining-runs figure.');
  }
  return lines;
}

/** Render. Receipt first; the upgrade pointer is last and only when it is warranted. */
export function renderReceipt (r, { upgradeUrl = null } = {}) {
  const out = [];

  // The tripwire goes FIRST, above the money. A user who paid for 42 calls and got
  // no columns needs to read that before anything else in the receipt; buried under
  // a spend table it is the same silent failure with extra steps.
  const alert = renderMappingAlert(r.mapping);
  if (alert) { out.push(alert); out.push(''); }

  out.push(spendPhrase(r));

  if (r.calls > 0) {
    out.push('');
    const width = Math.max(...Object.keys(r.by_endpoint).map(k => k.length), 8);
    for (const [ep, e] of Object.entries(r.by_endpoint).sort((a, b) => b[1].calls - a[1].calls)) {
      const cost = e.verified + e.unverifiable;
      const mark = e.unverifiable > 0 ? ' (est)' : '';
      out.push(`  ${ep.padEnd(width)} ${String(e.calls).padStart(4)} call(s)  ${String(round(cost)).padStart(7)} cr${mark}`);
    }
    const providerErrors = r.provider_error_lines ?? 0;
    const nonTwoXx = (r.known_zero_lines ?? 0) - providerErrors;
    if (nonTwoXx > 0) {
      out.push(`  ${nonTwoXx} call(s) cost nothing (a non-2xx is not billed).`);
    }
    if (providerErrors > 0) {
      out.push(`  ${providerErrors} call(s) cost nothing: the provider errored and the response `
        + 'said billed: false. Those rows were NOT looked up — retry them, they are not not-founds.');
    }
    // What the money bought, stated in columns rather than in calls. Only when it
    // was actually measured — a null audit says nothing at all.
    if (r.mapping) {
      const m = r.mapping;
      out.push(`  delivered ${m.columns_delivered} distinct column(s) from ${m.mapped_responses} readable response(s); `
        + `${m.empty_responses} genuine not-found.`);
      // The calm note sits HERE, in the body, not above the money: raw delivery is a
      // coverage gap worth naming and is not an alarm.
      const note = renderUnmappedNote(m);
      if (note) out.push(note);
    }
  }

  // Cost per found record. The table above is cost per CALL; a hop that misses is a
  // hop that billed, so at any hit rate under full these are different numbers and
  // the second one is what the operator actually spends.
  if (r.cost_per_found?.length) {
    out.push('');
    out.push('Cost per found record — the unit you spend in, not the unit you are charged in:');
    for (const c of r.cost_per_found) out.push(`  ${costPerFoundPhrase(c)}`);
    out.push('  A conditional hop bills on a miss: only a non-2xx is unbilled, and a 2xx that');
    out.push('  found nothing is a successful call.');
  }

  const fit = planFit(r);
  if (fit) { out.push(''); out.push(...fit); }

  // The upgrade pointer is shown when the balance is known AND low. Never on a 200,
  // and never when we cannot tell — an upsell built on an unknown balance is a guess.
  if (upgradeUrl && r.balance_known && r.tier_credits && r.balance < r.credits_ceiling) {
    out.push('');
    out.push(`Balance is below this run's cost. Top up: ${upgradeUrl}`);
  }
  return out.join('\n');
}
