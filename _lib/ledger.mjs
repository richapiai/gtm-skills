// _lib/ledger.mjs — the honest cost record.
//
// Writes gtm/api-calls.jsonl, one line per paid call, per the FROZEN
// _lib/contracts/ledger-line.schema.json.
//
// LAW 4 — NEVER FABRICATE AN ACTUAL. 11 of the 21 metered endpoints do not
// let us verify what we were charged: 10 declare the synthetic result-count
// field `_list_count`, which appears in zero responses, and profile_activities
// bills on `totalElements` while returning only `elements`. For those the line
// is written cost_status:"estimated_unverifiable" with credits_actual:null.
// An estimate echoed back as an actual is the old honor-system math moved
// into JavaScript, and it is exactly what this file exists to prevent.
//
// A 402 body carries `reserved` + `balance` (as STRINGS) and, per the spec's
// billing rules, costs nothing — "a non-2xx response deducts no credits". So
// a 402 is a free balance refresh; it populates the cache the BALANCE
// preflight key reads.

import { readFileSync, appendFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export const LEDGER_SCHEMA_VERSION = 1;
export const LEDGER_FILE = 'api-calls.jsonl';

export function stateDir () {
  return process.env.richapi_SKILLS_HOME || join(homedir(), '.richapi-skills');
}

/**
 * Where the cached credit balance lives, SCOPED TO THE API KEY.
 *
 * It used to be one machine-global file. That crossed every boundary the pack
 * promises: LIMITATIONS.md §6 says state isolation is per-directory and "one checkout
 * is one book of business", and a single `.balance-cache` meant a run in one client's
 * checkout reported the balance last seen in another's. It also survived the key
 * changing, so switching accounts showed the old account's number.
 *
 * The right scope is neither the directory nor the machine: a balance is a fact about
 * an ACCOUNT. Keying the file by a truncated SHA-256 of the API key gives one cache per
 * account, shared correctly across that account's checkouts and never across accounts.
 *
 * The key itself never reaches the filename — only a digest of it — so the cache path
 * cannot leak a credential into a directory listing, a backup or a crash dump.
 * With no key set there is no account, so there is nothing to cache and nothing to read.
 */
export function balanceCachePath (apiKey = process.env.richapi_API_KEY) {
  if (!apiKey) return join(stateDir(), '.balance-cache-nokey');
  const digest = createHash('sha256').update(String(apiKey)).digest('hex').slice(0, 16);
  return join(stateDir(), `.balance-cache-${digest}`);
}

// --- estimation ------------------------------------------------------------

/**
 * Pre-call estimate, from the catalog's x-pricing shape
 * (api-catalog.schema.json). Returns { credits, basis, verifiable }.
 * `credits` is null when the pricing model is unknown — the caller must STOP
 * rather than guess (gates.checkCall does).
 */
export function estimate (catalogEntry, { resultCount = null, batchSize = null } = {}) {
  const p = catalogEntry?.pricing;
  if (!p || !p.model || p.model === 'unknown') {
    return { credits: null, basis: 'unknown_pricing_model', verifiable: false, model: p?.model ?? null };
  }
  const verifiable = p.billing_field_present_in_response === true;
  const n = firstFinite(resultCount, batchSize);

  switch (p.model) {
    case 'flat': {
      const per = num(p.credits_per_call);
      if (per === null) return { credits: null, basis: 'flat_missing_credits_per_call', verifiable, model: p.model };
      // A flat price is per CALL. `resultCount` (rows returned, or a page's expected
      // size) must never multiply it: post_activities is 3 credits a page, and pricing
      // it by its 10 rows booked 30 and refused a budget the run fit inside.
      // Only `batchSize` — an explicit number of calls — scales a flat price.
      const b = firstFinite(batchSize);
      const units = b === null ? 1 : Math.max(1, b);
      return { credits: round(per * units), basis: units > 1 ? `flat ${per} x ${units}` : `flat ${per}`, verifiable, model: p.model };
    }
    case 'per_result': {
      const per = num(p.credits_per_result);
      if (per === null || n === null) {
        return { credits: null, basis: 'per_result_needs_a_result_count', verifiable, model: p.model };
      }
      return { credits: round(per * n), basis: `${per}/result x ${n}`, verifiable, model: p.model };
    }
    case 'base_plus_per_result': {
      const base = num(p.credits_base) ?? 0;
      const per = num(p.credits_per_result);
      if (per === null || n === null) {
        return { credits: null, basis: 'base_plus_per_result_needs_a_result_count', verifiable, model: p.model };
      }
      return { credits: round(base + per * n), basis: `${base} base + ${per}/result x ${n}`, verifiable, model: p.model };
    }
    default:
      return { credits: null, basis: `unhandled pricing model ${p.model}`, verifiable, model: p.model };
  }
}

/**
 * WAS THIS CALL BILLED? The single answer the whole pack reads.
 *
 * Two ways a call costs nothing:
 *
 *   non_2xx        the billing rule: "a non-2xx response deducts no credits".
 *   provider_error a 2xx whose BODY says it was not billed. Recorded live on
 *                  2026-09-17: email_finder answered HTTP 200 with
 *                  `{ok:false, result:null, billed:false, why:"2/5 providers
 *                  returned an error — retry later"}`. The pack booked ~20
 *                  credits at full price for those and reported the rows as
 *                  genuine not-founds.
 *
 * Only `billed: false` is treated as the signal — that is the one key a real
 * recording shows (law 2: never invent a response key). `ok: false` on its own
 * is a not-found, which IS billed and must keep costing.
 *
 * `billed: null` means UNKNOWN: http_status 0 is a response we never saw, and a
 * request the server may well have processed and billed must not be booked at zero.
 *
 * @returns {{billed: boolean|null, reason: string|null}}
 */
export function billingVerdict (responseBody, httpStatus = 200) {
  if (httpStatus === 0) return { billed: null, reason: null };
  if (Number.isInteger(httpStatus) && (httpStatus < 200 || httpStatus >= 300)) {
    return { billed: false, reason: 'non_2xx' };
  }
  const body = responseBody && typeof responseBody === 'object' ? responseBody : null;
  if (body && body.billed === false) return { billed: false, reason: 'provider_error' };
  return { billed: true, reason: null };
}

/**
 * The ONLY place an actual may come from. Returns null whenever the charge
 * cannot be read back out of the real response — which is the common case.
 */
export function resolveActual (catalogEntry, responseBody, httpStatus = 200) {
  // Billing rule: "Only successful calls are billed. A non-2xx response
  // deducts no credits." A non-2xx actual of 0 is known, not guessed.
  // Status 0 means the response was NEVER SEEN (timeout, socket error). The billing
  // rule "a non-2xx deducts no credits" cannot be applied to a request the server may
  // well have processed and billed. Returning null keeps the line
  // `estimated_unverifiable` instead of claiming a known zero we cannot know.
  const verdict = billingVerdict(responseBody, httpStatus);
  if (verdict.billed === false) {
    return { credits: 0, source: verdict.reason === 'non_2xx' ? 'non_2xx_not_billed' : 'provider_error_not_billed' };
  }
  if (httpStatus === 0) return null;
  const body = responseBody && typeof responseBody === 'object' ? responseBody : null;

  // If the response ever starts carrying credits_charged, that is
  // an actual outright, whatever the catalog says.
  const charged = num(body?.credits_charged);
  if (charged !== null) return { credits: charged, source: 'credits_charged' };

  const p = catalogEntry?.pricing;
  if (!p) return null;
  // The catalog is the authority on whether the charge is readable at all.
  if (p.billing_field_present_in_response !== true) return null;

  // A flat catalog price is a deterministic ESTIMATE, not a charge read back from the
  // response. The schema's own enum says "actual = a real charge was read from the
  // response", and returning `actual` here made the entire happy path report
  // fabricated actuals - the honor-system arithmetic Law 4 forbids. Only
  // `credits_charged` (checked above) promotes a line to actual.
  if (p.model === 'flat') return null;
  if (p.model === 'per_result' || p.model === 'base_plus_per_result') {
    const field = p.result_count_field;
    if (!field || !body) return null;
    const count = num(readPath(body, field));
    if (count === null) return null;         // field promised, field absent
    const per = num(p.credits_per_result);
    if (per === null) return null;
    const base = p.model === 'base_plus_per_result' ? (num(p.credits_base) ?? 0) : 0;
    return { credits: round(base + per * count), source: `billed_on:${field}=${count}` };
  }
  return null;
}

export function resultCountOf (catalogEntry, responseBody) {
  const field = catalogEntry?.pricing?.result_count_field;
  const body = responseBody && typeof responseBody === 'object' ? responseBody : null;
  if (field && body) {
    const v = num(readPath(body, field));
    if (v !== null) return Math.trunc(v);
  }
  for (const k of ['elements', 'results', 'data', 'items']) {
    if (Array.isArray(body?.[k])) return body[k].length;
  }
  return null;
}

// --- the ledger ------------------------------------------------------------

export class Ledger {
  constructor ({ dir = 'gtm', runId = null, clock = () => new Date() } = {}) {
    this.dir = dir;
    this.path = join(dir, LEDGER_FILE);
    this.runId = runId;
    this.clock = clock;
    this.lines = [];
    this.balance = null;
    this.balanceSource = 'unknown';
    // A resume builds a fresh Ledger for a run that already spent money. Without
    // adopting those lines the receipt reports only the resumed slice - "Spent 800
    // credits" for a run that cost 4,000 - and reconcile reports a phantom underspend.
    if (runId) this.#adoptExistingLines();
  }

  #adoptExistingLines () {
    try {
      const raw = readFileSync(this.path, 'utf8');
      for (const l of raw.split('\n')) {
        if (!l.trim()) continue;
        try { const o = JSON.parse(l); if (o.run_id === this.runId) this.lines.push(o); } catch { /* skip */ }
      }
    } catch { /* no prior ledger */ }
  }

  #write (line) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(line) + '\n', 'utf8');
    this.lines.push(line);
    return line;
  }

  /**
   * Record one call. `estimated` is what the pre-call estimate said; the
   * actual is resolved from the real response or left null forever.
   */
  record ({
    endpoint,
    catalogEntry = null,
    estimatedCredits = null,
    estimateBasis = null,
    rowId = null,
    hop = null,
    responseBody = null,
    httpStatus = 200,
    resultCount = undefined,
    balanceAfter = undefined,
    balanceSource = undefined
  }) {
    const est = num(estimatedCredits);
    const actual = resolveActual(catalogEntry, responseBody, httpStatus);
    const verdict = billingVerdict(responseBody, httpStatus);
    const notBilled = verdict.billed === false;

    // `known_zero` separates "we verified a charge" from "the rule says there was
    // none". A non-2xx deducts no credits, which is a fact about the billing rule,
    // not a reading off the response. Overloading `actual` for it made a 429 storm
    // look like a pile of verified charges.
    const costStatus = !actual ? 'estimated_unverifiable'
      : (actual.source === 'non_2xx_not_billed' || actual.source === 'provider_error_not_billed') ? 'known_zero'
      : 'actual';

    // THE FIELD CONSUMERS SUM IS ZERO WHEN NOTHING WAS BILLED.
    //
    // `credits_estimated` used to carry the would-have-been price on every line,
    // billed or not. Measured on the 2026-09-17 local-business-outbound rerun: 27
    // lines summing 41.5 credits, of which 14 non-2xx lines carried 28.0 — the
    // ledger claimed 41.5 while the receipt correctly said those 14 cost nothing.
    // /measure, /cost-optimizer and every budget gate read the LEDGER, so a run
    // could be stopped by a ceiling it had not come close to. The estimate is
    // still worth keeping (it is what the call WOULD have cost), so it moves to
    // `credits_estimated_if_billed`, a name nothing sums by accident.
    const line = {
      schema_version: LEDGER_SCHEMA_VERSION,
      ts: this.clock().toISOString(),
      run_id: this.runId,
      row_id: rowId,
      hop,
      endpoint,
      credits_estimated: notBilled ? 0 : (est === null ? 0 : est),
      ...(notBilled ? { credits_estimated_if_billed: est === null ? 0 : est } : {}),
      billed: verdict.billed,
      not_billed_reason: verdict.reason,
      estimate_basis: estimateBasis,
      credits_actual: actual ? actual.credits : null,
      cost_status: costStatus,
      result_count: resultCount !== undefined
        ? resultCount
        : resultCountOf(catalogEntry, responseBody),
      balance_after: balanceAfter !== undefined ? balanceAfter : this.balance,
      balance_source: balanceSource !== undefined ? balanceSource : this.balanceSource,
      http_status: Number.isInteger(httpStatus) ? httpStatus : 0
    };
    return this.#write(line);
  }

  /**
   * A 402 costs nothing and hands us a fresh balance. Parse it, cache it for
   * the BALANCE preflight key, and write a zero-cost ledger line.
   * The 402 body types `reserved` and `balance` as STRINGS.
   */
  recordInsufficientCredits ({ endpoint, body = {}, estimatedCredits = null, catalogEntry = null }) {
    const parsed = parse402(body);
    if (parsed.balance !== null) {
      this.balance = parsed.balance;
      this.balanceSource = '402_body';
      writeBalanceCache(parsed.balance, '402_body');
    }
    const line = this.record({
      endpoint,
      catalogEntry,
      estimatedCredits,
      responseBody: body,
      httpStatus: 402,
      resultCount: null,
      balanceAfter: parsed.balance,
      balanceSource: parsed.balance !== null ? '402_body' : 'unknown'
    });
    return { line, ...parsed };
  }

  setBalanceFromUsage (usageBody) {
    const b = extractBalance(usageBody);
    if (b === null) return null;
    this.balance = b;
    this.balanceSource = 'usage_endpoint';
    writeBalanceCache(b, 'usage_endpoint');
    return b;
  }

  /** Sum of what we believe we spent: actuals where known, estimates elsewhere. */
  totals () {
    let actual = 0, estimatedOnly = 0, unverifiable = 0, verified = 0, knownZero = 0, providerError = 0;
    for (const l of this.lines) {
      if (l.not_billed_reason === 'provider_error') providerError++;
      if (l.cost_status === 'known_zero') { knownZero++; continue; } // costs nothing, by rule
      if (l.cost_status === 'actual') { actual += num(l.credits_actual) ?? 0; verified++; }
      else { estimatedOnly += num(l.credits_estimated) ?? 0; unverifiable++; }
    }
    return {
      lines: this.lines.length,
      verified_lines: verified,
      unverifiable_lines: unverifiable,
      known_zero_lines: knownZero,
      provider_error_lines: providerError,
      credits_actual: round(actual),
      credits_estimated_unverifiable: round(estimatedOnly),
      ledger_total: round(actual + estimatedOnly)
    };
  }

  /**
   * Session end: reconcile the ledger sum against GET /usage and report drift.
   * `usage` may be the raw body, a number, or null (endpoint unreachable — it
   * is documented in prose only and is absent from the spec's paths:). A
   * missing /usage degrades to "unreconciled", never to a fake match.
   */
  reconcile (usage = null) {
    const t = this.totals();
    const usageTotal = usage === null ? null
      : (typeof usage === 'number' ? usage : extractUsageSpend(usage));

    if (usageTotal === null) {
      return {
        ...t,
        usage_total: null,
        drift: null,
        drift_pct: null,
        status: 'unreconciled',
        reason: 'the pack does not fetch GET /usage for a run yet, so a run cannot be reconciled against account usage',
        report: reconcileReport({ ...t, usage_total: null, drift: null, status: 'unreconciled' })
      };
    }
    const drift = round(usageTotal - t.ledger_total);
    const driftPct = t.ledger_total > 0 ? round((drift / t.ledger_total) * 100, 2) : null;
    const out = {
      ...t,
      usage_total: usageTotal,
      drift,
      drift_pct: driftPct,
      status: drift === 0 ? 'reconciled' : 'drift',
      reason: drift === 0
        ? 'ledger matches GET /usage'
        : `ledger and GET /usage disagree by ${drift} credits; ${t.unverifiable_lines} of ${t.lines} line(s) are estimates we cannot verify`
    };
    out.report = reconcileReport(out);
    return out;
  }
}

function reconcileReport (r) {
  const lines = [
    `Ledger: ${r.ledger_total} credits over ${r.lines} call(s)`,
    `  verified actuals:      ${r.credits_actual} (${r.verified_lines} line(s))`,
    `  unverifiable estimates: ${r.credits_estimated_unverifiable} (${r.unverifiable_lines} line(s))`
  ];
  if (r.usage_total === null) {
    lines.push('GET /usage: unavailable — NOT reconciled. The ledger total above is our own arithmetic.');
  } else {
    lines.push(`GET /usage: ${r.usage_total} credits`);
    lines.push(`Drift: ${r.drift} credits${r.drift_pct === null ? '' : ` (${r.drift_pct}%)`}`);
  }
  return lines.join('\n');
}

// --- 402 / usage parsing ---------------------------------------------------

/** 402 body: { error, reserved: "5", balance: "2.5" } — strings, not numbers. */
export function parse402 (body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    error: typeof b.error === 'string' ? b.error : null,
    reserved: num(b.reserved),
    balance: num(b.balance),
    credits_charged: 0,           // non-2xx deducts no credits
    balance_source: num(b.balance) === null ? 'unknown' : '402_body'
  };
}

const BALANCE_KEYS = ['balance', 'credits_remaining', 'creditsRemaining', 'remaining',
  'credits_balance', 'creditsBalance', 'available_credits', 'availableCredits', 'credits'];
const SPEND_KEYS = ['used', 'credits_used', 'creditsUsed', 'spent', 'credits_spent',
  'creditsSpent', 'usage', 'total_credits', 'consumed'];

/** GET /usage has no schema in the spec — probe, and admit failure. */
export function extractBalance (body) {
  return probe(body, BALANCE_KEYS);
}
export function extractUsageSpend (body) {
  return probe(body, SPEND_KEYS);
}

function probe (body, keys) {
  if (body === null || body === undefined) return null;
  if (typeof body === 'number') return Number.isFinite(body) ? body : null;
  let parsed = body;
  if (typeof body === 'string') {
    try { parsed = JSON.parse(body); } catch { return num(body); }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 4 || seen.has(node)) return null;
    seen.add(node);
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(node, k)) {
        const v = num(node[k]);
        if (v !== null) return v;
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') {
        const found = walk(v, depth + 1);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return walk(parsed, 0);
}

// --- the balance cache shared with bin/richapi-skills-preflight ------------
// Format matches the existing .upgrade-cache pattern: line 1 ISO timestamp,
// line 2 value, line 3 source.

export function writeBalanceCache (balance, source = 'unknown', path = balanceCachePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n${balance}\n${source}\n`, 'utf8');
    return true;
  } catch {
    return false;   // the cache is an optimisation; failing to write it is never fatal
  }
}

export function readBalanceCache (path = balanceCachePath()) {
  try {
    if (!existsSync(path)) return null;
    const [ts, value, source] = readFileSync(path, 'utf8').split('\n');
    const b = num(value);
    return { ts: ts?.trim() || null, balance: b, source: (source || '').trim() || 'unknown' };
  } catch {
    return null;
  }
}

// --- helpers ---------------------------------------------------------------

function num (v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}
function firstFinite (...vals) {
  for (const v of vals) { const n = num(v); if (n !== null) return n; }
  return null;
}
function round (n, dp = 4) {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
function readPath (obj, path) {
  return String(path).split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

export default {
  Ledger, estimate, resolveActual, billingVerdict, resultCountOf, parse402,
  extractBalance, extractUsageSpend, writeBalanceCache, readBalanceCache,
  balanceCachePath, stateDir, LEDGER_SCHEMA_VERSION, LEDGER_FILE
};
