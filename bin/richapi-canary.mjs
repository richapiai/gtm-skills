#!/usr/bin/env node
// richapi-canary — the weekly live-API contract canary.
//
// WHAT IT ASSERTS
//
//   Once a week, against real credentials, on a handful of the cheapest endpoints
//   the catalog knows about:
//
//     1. the live response's top-level key set still matches the generated
//        `field_map_keys` in `_lib/api-catalog.json`;
//     2. what the call was billed still matches what `x-pricing` said it would be.
//
//   A blocking failure writes a GitHub issue payload to `--issue-file`;
//   `.github/workflows/canary.yml` turns that file into an issue. Nothing else in
//   the pack looks at the live API with a key in hand, so this is the only place a
//   silently-changed response shape or a silently-changed bill can be seen.
//
// IT IS OFF BY DEFAULT. THIS IS THE EXACT CONDITION FOR TURNING IT ON.
//
//   `--run` REFUSES while any selected endpoint's `field_map_status` is anything
//   other than `live_fixture`, and names the endpoints. Today every one of the 68
//   catalog entries is `keys_from_spec_example` or `TODO_no_usable_example`, and
//   `field_map` is null on all of them — those key sets come from the pinned spec's
//   200 examples, which CLAUDE.md's law 2 and `bin/richapi-capture-fixtures.mjs`'s
//   own measurements both rule out as a schema source: most examples are largely the
//   literal string "example", and `_list_count` — the billing field 10 of these
//   endpoints charge on — appears in none of them.
//
//   Asserting against that would flag near-everything as drift on the very first
//   live run, and a weekly gate that is red on week one is switched off in week
//   two — the usual fate of a binary gate at the measured churn rate. So:
//
//     ENABLE CONDITION: the live fixture capture has landed and the selected endpoints
//     carry `field_map_status: live_fixture` in `_lib/api-catalog.json`.
//
//   Until then `--run` exits 2 with that sentence. `--force-unverified-field-map`
//   overrides it for a one-off maintainer run and says loudly in the report that
//   the expectations being asserted are spec-derived and unverified.
//
// THE BUDGET IS ENFORCED, NOT DOCUMENTED (law 3 — every paid call named and costed)
//
//   The ceiling is <50 credits/week. The cost of the run is computed from the
//   catalog's own `x-pricing` BEFORE anything is called, and a selection that
//   reaches the ceiling is refused with exit 2 and zero calls made. The ceiling is
//   exclusive, matching `<50cr/week` literally.
//
//   The endpoint set is DERIVED, never a list in this file: the N cheapest catalog
//   entries whose per-call cost is both known and bounded. Excluded, with the
//   reason printed:
//     * `disabled_by_default` (today: post_keyword_search — billing basis undocumented)
//     * `deprecated`
//     * metered endpoints with `bounded: false` — no limit-style request field, so
//       the server decides how many results to bill and the cost cannot be capped
//     * anything `_lib/ledger.mjs` `estimate()` cannot price
//     * anything with no safe probe body (see PROBES)
//
//   Ties are broken toward the endpoints whose charge can actually be read back
//   (see below), because a canary that can never observe a charge only asserts half
//   its contract.
//
// WHY THE CHARGE CHECK IS NOT TAUTOLOGICAL
//
//   `estimate()` and `resolveActual()` in `_lib/ledger.mjs` share one x-pricing
//   arithmetic, so comparing them at the SAME result count compares a number with
//   itself. The comparison here is deliberately across two different numbers:
//
//     planned  = the cost at the result count this canary REQUESTED (limit=1,
//                which is what the probe body asks for)
//     observed = the cost at the result count the server actually BILLED, read out
//                of the response's own `result_count_field`
//
//   They differ exactly when the server stops honouring the request-side bound —
//   which is the only way a run planned at a few credits can quietly cost hundreds,
//   and the only thing that makes the <50cr/week ceiling above a fact rather than a
//   hope. If a response ever carries `credits_charged`, `resolveActual`
//   returns that outright and the comparison becomes a true charge-vs-price check.
//
//   Law 4 applies here as everywhere: where the charge cannot be read back, the
//   result is `unobservable` with the catalog's own reason, never a fabricated pass.
//   `resolveActual` returns null for every `flat` endpoint by design (a flat price
//   is a deterministic estimate, not a charge read from a response), and for the
//   metered endpoints whose `billing_field_present_in_response` is false. The
//   remaining case — the catalog promises the billing field and the response does
//   not carry it — is a real contract break and is reported as one.
//
// PROBES
//
//   Request bodies come from the same synthesis `bin/richapi-capture-fixtures.mjs`
//   uses: `tests/fixtures/live/sample-inputs.json` where an entry exists, otherwise
//   the placeholder table in that file, with every limit-style field pinned to 1. One
//   synthesis, not two, so a probe that is safe for a capture run is safe here. The
//   sample-inputs file lives under `tests/`, which package.json `files` does not
//   ship; the capture harness already degrades to the derived placeholders when it
//   is absent, and so does this. `--probes <file>` overrides with the same
//   `{"inputs": {...}}` shape.
//
// MAINTAINER TOOL. Not registered in package.json "bin" — it is invoked by
// .github/workflows/canary.yml and by hand.
//
// Usage:
//   node bin/richapi-canary.mjs [options]
//
//   With no options this PLANS the run: it selects the endpoints, prints what each
//   would cost and the total, and makes ZERO HTTP requests.
//
//   --run                    make the live calls and assert. Needs richapi_API_KEY.
//   --endpoints <n>          how many endpoints to probe (default 8)
//   --budget <credits>       weekly ceiling, exclusive (default 50)
//   --catalog <file>         catalog to read (default _lib/api-catalog.json)
//   --probes <file>          request bodies, {"inputs": {endpoint: body}}
//   --issue-file <file>      write {title, body} JSON here when something blocks
//   --base-url <url>         override the API base URL (https:, or loopback)
//   --timeout <ms>           per-call deadline (default 30000)
//   --force-unverified-field-map
//                            assert against spec-derived key sets anyway
//   --json                   machine-readable output
//   --help
//
// Exit codes:
//   0  clean, or plan mode, or every finding was a warning
//   1  at least one BLOCKING finding — the issue payload was written
//   2  refused before any call: no key, unverified field maps, budget exceeded,
//      an unusable catalog, or an unsafe origin

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSafeOrigin, UnsafeOrigin, resolveBaseUrl } from '../_lib/client.mjs';
import { estimate, resolveActual, resultCountOf } from '../_lib/ledger.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_ENDPOINT_COUNT = 8;
/** The weekly ceiling, exclusive: "<50cr/week". */
export const DEFAULT_BUDGET_CREDITS = 50;
/** Every limit-style probe field is pinned to this, so this is what we plan for. */
export const CANARY_RESULT_LIMIT = 1;
export const DEFAULT_TIMEOUT_MS = 30_000;

/** The one `field_map_status` this canary is allowed to assert against. */
export const REQUIRED_FIELD_MAP_STATUS = 'live_fixture';

/** Same two models `_lib/catalog/extract.mjs` and the drift tool call metered. */
const METERED = new Set(['per_result', 'base_plus_per_result']);

const API_KEY_ENV = 'richapi_API_KEY';
const SAMPLE_INPUTS = path.join(ROOT, 'tests', 'fixtures', 'live', 'sample-inputs.json');

/**
 * Finding classes and their levels, in the same block/warn vocabulary the catalog
 * differ and the drift check already use.
 *
 * TRANSPORT is a warn on purpose. A third-party outage on a Monday morning must not
 * open an issue every Monday morning, for the same reason the drift check skips
 * rather than failing when the network is gone: a check that cries wolf is a check
 * that gets switched off, and then it protects nothing.
 */
export const CANARY_SEVERITY = Object.freeze({
  FIELD_MAP_MISMATCH: 'block',
  CHARGE_MISMATCH: 'block',
  BILLING_FIELD_MISSING: 'block',
  REQUEST_REJECTED: 'block',
  INSUFFICIENT_CREDITS: 'block',
  TRANSPORT: 'warn',
});

export const CANARY_BLOCKING = Object.entries(CANARY_SEVERITY)
  .filter(([, s]) => s === 'block')
  .map(([k]) => k)
  .sort();

/** The selection could not be built at all — a repo problem, not an API problem. */
export class UnusableCatalogError extends Error {}
/** The computed cost of the selection reached the ceiling. Nothing was called. */
export class BudgetExceededError extends Error {}

const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// selection — derived from the catalog, never a list
// ---------------------------------------------------------------------------

/**
 * Can the charge for this endpoint be read back out of a response at all?
 *
 * This mirrors `resolveActual`'s own rules rather than restating them loosely: it
 * returns a charge only for a metered endpoint whose `result_count_field` the
 * catalog says is actually present in responses (or for any endpoint whose response
 * carries `credits_charged`, which nothing does today).
 */
export function chargeObservable(entry) {
  const p = entry?.pricing ?? {};
  return METERED.has(p.model) && p.billing_field_present_in_response === true;
}

/**
 * One call's cost, priced by the ledger's estimator at the result count the probe
 * asks for. Returns `_lib/ledger.mjs`'s own shape.
 */
export function planCost(entry, resultCount = CANARY_RESULT_LIMIT) {
  return estimate(entry, { resultCount });
}

/**
 * Pick the cheapest N probeable endpoints.
 *
 * @param {object} catalog     a v2 api-catalog
 * @param {object} [opts]
 * @param {number} [opts.limit]        how many to select
 * @param {object} [opts.probes]       {endpoint: {body, method}} — an endpoint with
 *                                     no probe cannot be called and is excluded
 * @param {number} [opts.resultCount]  result count the probe asks for
 * @returns {{selected: object[], excluded: object[], total: number}}
 */
export function selectEndpoints(catalog, { limit = DEFAULT_ENDPOINT_COUNT, probes = {}, resultCount = CANARY_RESULT_LIMIT } = {}) {
  const entries = catalog?.endpoints;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    throw new UnusableCatalogError('catalog has no `endpoints` object');
  }

  const candidates = [];
  const excluded = [];
  for (const name of Object.keys(entries).sort()) {
    const entry = entries[name];
    const p = entry?.pricing ?? {};

    if (entry?.deprecated === true) {
      excluded.push({ name, reason: 'deprecated in the pinned spec' });
      continue;
    }
    if (p.disabled_by_default === true) {
      excluded.push({ name, reason: `disabled_by_default — ${p.disabled_reason ?? 'no reason recorded'}` });
      continue;
    }
    if (METERED.has(p.model) && p.bounded !== true) {
      excluded.push({
        name,
        reason:
          `bounded:false — ${p.model} with no limit-style request field, so the server ` +
          'decides how many results to bill and one call cannot be costed in advance',
      });
      continue;
    }
    const cost = planCost(entry, resultCount);
    if (cost.credits === null) {
      excluded.push({ name, reason: `not priceable: ${cost.basis}` });
      continue;
    }
    const probe = probes[name];
    if (!probe || !probe.body || typeof probe.body !== 'object') {
      excluded.push({ name, reason: probe?.reason ?? 'no safe probe body — add one to tests/fixtures/live/sample-inputs.json' });
      continue;
    }
    candidates.push({
      name,
      entry,
      path: entry.path,
      method: probe.method ?? 'POST',
      body: probe.body,
      credits: cost.credits,
      basis: cost.basis,
      charge_observable: chargeObservable(entry),
      field_map_status: entry.field_map_status ?? null,
    });
  }

  candidates.sort(
    (a, b) =>
      a.credits - b.credits ||
      Number(b.charge_observable) - Number(a.charge_observable) ||
      a.name.localeCompare(b.name)
  );

  const selected = candidates.slice(0, limit);
  for (const c of candidates.slice(limit)) {
    excluded.push({ name: c.name, reason: `not among the ${limit} cheapest probeable endpoints (${c.credits} credits)` });
  }

  return { selected, excluded, total: round(selected.reduce((a, c) => a + c.credits, 0)) };
}

/**
 * Fail closed on the ceiling. Throws before anything is called; never after.
 * The ceiling is exclusive, so a selection costing exactly the budget is refused.
 */
export function assertBudget(selection, budget = DEFAULT_BUDGET_CREDITS) {
  if (!(selection.total < budget)) {
    throw new BudgetExceededError(
      `the selection costs ${selection.total} credits and the ceiling is ${budget} credits/week, ` +
        `exclusive (the default is ${DEFAULT_BUDGET_CREDITS}). Nothing was called and nothing was charged. ` +
        'Lower --endpoints, or raise --budget deliberately and say why.'
    );
  }
  return selection.total;
}

/** Selected endpoints whose expectations are NOT live-verified. See the header. */
export function unverifiedFieldMaps(selection) {
  return selection.selected
    .filter((c) => c.field_map_status !== REQUIRED_FIELD_MAP_STATUS)
    .map((c) => ({ name: c.name, status: c.field_map_status }));
}

export function formatUnverifiedRefusal(unverified) {
  return [
    `REFUSED: ${unverified.length} of the selected endpoint(s) do not carry ` +
      `field_map_status: ${REQUIRED_FIELD_MAP_STATUS}, so there is nothing live-verified to assert against.`,
    ...unverified.map((u) => `  - ${u.name}: ${u.status ?? '<none>'}`),
    '',
    'Those key sets come from the pinned spec\'s 200 examples, which are unreliable — asserting',
    'against them would flag near-everything as drift on the first live run, and a gate that is',
    'red on week one is switched off in week two.',
    '',
    'ENABLE CONDITION: run the live fixture capture (bin/richapi-capture-fixtures.mjs --run) and',
    'regenerate the catalog so these endpoints read field_map_status: live_fixture.',
    '',
    'Nothing was called and nothing was charged. --force-unverified-field-map runs it anyway.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// the two assertions
// ---------------------------------------------------------------------------

/**
 * Assertion 1 — the live top-level key set vs the generated `field_map_keys`.
 *
 * Top-level names only, which is exactly what the catalog carries: `field_map_keys`
 * is documented in `_lib/catalog/extract.mjs` as an array of top-level response key
 * NAMES, never a map, so nothing deeper can honestly be compared here.
 */
export function compareKeys(entry, body) {
  const expected = entry?.field_map_keys;
  if (!Array.isArray(expected)) {
    return { status: 'no_expectation', reason: 'the catalog records no field_map_keys for this endpoint' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 'not_an_object', reason: `the response body is ${Array.isArray(body) ? 'an array' : typeof body}, not an object` };
  }
  const live = Object.keys(body).sort();
  const want = [...expected].sort();
  const missing = want.filter((k) => !live.includes(k));
  const unexpected = live.filter((k) => !want.includes(k));
  return {
    status: missing.length || unexpected.length ? 'mismatch' : 'match',
    expected: want,
    live,
    missing,
    unexpected,
  };
}

/**
 * The billed result count, read from the endpoint's OWN declared billing field.
 *
 * Deliberately NOT `resultCountOf`, which falls back to the first of `elements`,
 * `results`, `data`, `items` that happens to be an array. That fallback is right for
 * a ledger line (any count beats none) and wrong here: it would let an unrelated key
 * stand in for a billing field that has genuinely disappeared, and hide the very
 * contract break this canary exists to find. Also unlike `resolveActual`'s reader, an
 * ARRAY at the declared field counts as its length — 7 of the pinned catalog's metered
 * endpoints bill on `elements`, which is a list, and reading `Number([...])` as NaN
 * there would report every one of them as a missing billing field.
 */
export function billedResultCount(entry, body) {
  const field = entry?.pricing?.result_count_field;
  if (!field || !body || typeof body !== 'object') return null;
  const v = String(field)
    .split('.')
    .reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), body);
  if (Array.isArray(v)) return v.length;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Assertion 2 — planned cost vs billed cost. See "WHY THE CHARGE CHECK IS NOT
 * TAUTOLOGICAL" in the header: `planned` is priced at the result count the probe
 * REQUESTED, the other side at the count the server actually BILLED.
 *
 * Three sources, most authoritative first:
 *   1. `resolveActual` — a real charge read out of the response (`credits_charged`,
 *      or a numeric billing field). Nothing returns `credits_charged` today.
 *   2. the declared billing field's count, priced through the SAME `estimate()`.
 *   3. nothing — reported `unobservable` with the catalog's own reason, never a
 *      fabricated pass (law 4).
 */
export function compareCharge(entry, body, httpStatus, { requested = CANARY_RESULT_LIMIT } = {}) {
  const p = entry?.pricing ?? {};
  const planned = planCost(entry, requested);

  const compare = (credits, source, billedResults) => {
    if (planned.credits === null) {
      return { status: 'unobservable', planned: null, actual: credits, reason: planned.basis };
    }
    const delta = round(credits - planned.credits);
    return {
      status: Math.abs(delta) < 1e-9 ? 'match' : 'mismatch',
      planned: planned.credits,
      actual: credits,
      delta,
      source,
      billed_results: billedResults,
      requested_results: requested,
    };
  };

  const actual = resolveActual(entry, body, httpStatus);
  if (actual) return compare(actual.credits, actual.source, billedResultCount(entry, body) ?? resultCountOf(entry, body));

  if (chargeObservable(entry)) {
    const billed = billedResultCount(entry, body);
    if (billed === null) {
      return {
        status: 'billing_field_missing',
        field: p.result_count_field ?? null,
        planned: planned.credits,
        actual: null,
        reason:
          `the catalog records billing_field_present_in_response: true for \`${p.result_count_field}\`, ` +
          'and the live response does not carry a readable count there',
      };
    }
    const observed = estimate(entry, { resultCount: billed });
    if (observed.credits === null) {
      return { status: 'unobservable', planned: planned.credits, actual: null, reason: observed.basis };
    }
    return compare(observed.credits, `billed_on:${p.result_count_field}=${billed}`, billed);
  }

  return {
    status: 'unobservable',
    planned: planned.credits,
    actual: null,
    reason: METERED.has(p.model)
      ? `the catalog records billing_field_present_in_response: false for \`${p.result_count_field ?? '<none>'}\``
      : `${p.model} pricing: the charge is fully determined before the call, and no response carries credits_charged`,
  };
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * One probe call. Mirrors `fetchLiveCatalog` in bin/richapi-catalog-drift.mjs: a
 * network problem is RETURNED, never thrown, and the abort timer is cleared only
 * after the body has been read, so a server that answers headers and then stalls is
 * still bounded.
 */
export async function probe({ url, method = 'POST', body, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method,
      signal: ac.signal,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body),
      redirect: 'follow',
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed, raw: text, error: null };
  } catch (err) {
    const reason =
      err?.name === 'AbortError' || err?.name === 'TimeoutError'
        ? `timed out after ${timeoutMs}ms`
        : (err?.cause?.message ?? err?.message ?? String(err));
    return { status: 0, body: null, raw: '', error: reason };
  } finally {
    clearTimeout(timer);
  }
}

function finding(cls, endpoint, detail, extra = {}) {
  return { class: cls, severity: CANARY_SEVERITY[cls], endpoint, detail, ...extra };
}

/**
 * Call every selected endpoint once and assert both contracts.
 *
 * @returns {{runs: object[], findings: object[], blocking: object[], warnings: object[],
 *            credits_planned: number, credits_observed: number|null, exitCode: number}}
 */
export async function runCanary({ selection, baseUrl, apiKey, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, resultCount = CANARY_RESULT_LIMIT }) {
  const runs = [];
  const findings = [];
  let observed = 0;
  let observedAny = false;

  for (const c of selection.selected) {
    const res = await probe({
      url: `${baseUrl}${c.path}`,
      method: c.method,
      body: c.body,
      apiKey,
      timeoutMs,
      fetchImpl,
    });

    const row = { endpoint: c.name, http_status: res.status, credits_planned: c.credits, keys: null, charge: null };

    if (res.error) {
      row.error = res.error;
      findings.push(finding('TRANSPORT', c.name, `could not be reached: ${res.error}`));
      runs.push(row);
      continue;
    }
    if (res.status === 402) {
      // Billing rule: a non-2xx deducts no credits, so this cost nothing — but the
      // canary cannot do its job without credits and a human has to know.
      findings.push(finding('INSUFFICIENT_CREDITS', c.name, 'HTTP 402 — the account is out of credits, so the rest of the contract cannot be checked'));
      runs.push(row);
      break;
    }
    if (res.status === 429 || res.status >= 500) {
      findings.push(finding('TRANSPORT', c.name, `HTTP ${res.status} — an outage or a rate limit, not a contract change`));
      runs.push(row);
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      findings.push(
        finding('REQUEST_REJECTED', c.name, `HTTP ${res.status} — the request the pack builds from the pinned catalog was rejected`, {
          request_fields: Object.keys(c.body).sort(),
        })
      );
      runs.push(row);
      continue;
    }

    const keys = compareKeys(c.entry, res.body);
    row.keys = keys;
    if (keys.status === 'mismatch') {
      findings.push(
        finding(
          'FIELD_MAP_MISMATCH',
          c.name,
          `the live response key set no longer matches field_map_keys` +
            (keys.missing.length ? `; missing: ${keys.missing.join(', ')}` : '') +
            (keys.unexpected.length ? `; unexpected: ${keys.unexpected.join(', ')}` : ''),
          { missing: keys.missing, unexpected: keys.unexpected, expected: keys.expected, live: keys.live }
        )
      );
    } else if (keys.status === 'not_an_object') {
      findings.push(finding('FIELD_MAP_MISMATCH', c.name, `field_map_keys cannot be checked: ${keys.reason}`, { missing: [], unexpected: [] }));
    }

    const charge = compareCharge(c.entry, res.body, res.status, { requested: resultCount });
    row.charge = charge;
    if (typeof charge.actual === 'number') {
      observed += charge.actual;
      observedAny = true;
    }
    if (charge.status === 'mismatch') {
      findings.push(
        finding(
          'CHARGE_MISMATCH',
          c.name,
          `planned ${charge.planned} credits at ${charge.requested_results} requested result(s), billed ` +
            `${charge.actual} at ${charge.billed_results} (${charge.source}). The request-side bound is not ` +
            'being honoured, so the weekly ceiling is not a bound either.',
          { planned: charge.planned, actual: charge.actual, delta: charge.delta }
        )
      );
    } else if (charge.status === 'billing_field_missing') {
      findings.push(finding('BILLING_FIELD_MISSING', c.name, charge.reason, { field: charge.field }));
    }

    runs.push(row);
  }

  const blocking = findings.filter((f) => f.severity === 'block');
  return {
    runs,
    findings,
    blocking,
    warnings: findings.filter((f) => f.severity === 'warn'),
    credits_planned: selection.total,
    credits_observed: observedAny ? round(observed) : null,
    exitCode: blocking.length > 0 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// report and issue payload
// ---------------------------------------------------------------------------

export function formatPlan(selection, { budget, unverified }) {
  const w = (s, n) => String(s).padEnd(n);
  const lines = [];
  lines.push('');
  lines.push('  CANARY PLAN — every paid call named and costed before it runs');
  lines.push('  ' + '-'.repeat(92));
  lines.push(`  ${w('endpoint', 44)}${w('credits', 10)}${w('charge readable', 18)}field_map_status`);
  lines.push('  ' + '-'.repeat(92));
  for (const c of selection.selected) {
    lines.push(`  ${w(c.name, 44)}${w(c.credits, 10)}${w(c.charge_observable ? 'yes' : 'no', 18)}${c.field_map_status ?? '<none>'}`);
  }
  lines.push('  ' + '-'.repeat(92));
  lines.push(`  ${w('TOTAL', 44)}${w(selection.total, 10)}ceiling ${budget} credits/week, exclusive`);
  lines.push('');
  const readable = selection.selected.filter((c) => c.charge_observable).length;
  lines.push(
    `  ${readable} of ${selection.selected.length} selected endpoint(s) can have their charge read back out of the ` +
      'response;\n  the rest report `unobservable` rather than a fabricated pass (law 4).'
  );
  if (unverified.length) {
    lines.push('');
    lines.push(`  NOT ASSERTABLE YET — ${unverified.length} endpoint(s) are not field_map_status: ${REQUIRED_FIELD_MAP_STATUS}:`);
    for (const u of unverified) lines.push(`    - ${u.name}: ${u.status ?? '<none>'}`);
  }
  lines.push('');
  return lines.join('\n');
}

export function formatReport(result, { forced = false } = {}) {
  const lines = [];
  lines.push('');
  lines.push(`  CANARY — ${result.runs.length} endpoint(s) probed, ${result.credits_planned} credits planned`);
  if (forced) {
    lines.push('  FORCED: the expectations asserted below are spec-derived and NOT live-verified.');
  }
  for (const r of result.runs) {
    const bits = [`HTTP ${r.http_status || 'none'}`];
    if (r.keys) bits.push(`keys ${r.keys.status}`);
    if (r.charge) bits.push(`charge ${r.charge.status}`);
    if (r.error) bits.push(r.error);
    lines.push(`    ${r.endpoint.padEnd(44)}${bits.join('  ')}`);
  }
  lines.push('');
  for (const f of result.findings) {
    lines.push(`  ${f.severity === 'block' ? 'BLOCK' : 'warn '} ${f.class}  ${f.endpoint}`);
    lines.push(`    ${f.detail}`);
  }
  lines.push('');
  lines.push(
    result.blocking.length
      ? `  ${result.blocking.length} blocking finding(s). The live API no longer matches the pinned catalog.`
      : '  No blocking findings. The live API still matches the pinned catalog on the probed endpoints.'
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * The GitHub issue for a failed run, or null when nothing blocks.
 *
 * Deliberately carries only endpoint names, key NAMES and credit numbers. A probe
 * response can contain real contact data (the probes query public figures, but the
 * API answers with whatever it has), so no response body reaches the issue — law 7.
 */
export function issuePayload(result, { date = new Date().toISOString().slice(0, 10), forced = false } = {}) {
  if (!result.blocking.length) return null;
  const classes = [...new Set(result.blocking.map((f) => f.class))].sort();

  const body = [
    'The weekly live-API contract canary found a change the pinned catalog does not describe.',
    '',
    `- probed: ${result.runs.length} endpoint(s)`,
    `- planned cost: ${result.credits_planned} credits`,
    `- observed cost: ${result.credits_observed === null ? 'not readable from any response (law 4 — not fabricated)' : `${result.credits_observed} credits`}`,
    `- blocking classes: ${classes.join(', ')}`,
    '',
    ...(forced
      ? [
          '> Run with `--force-unverified-field-map`: the key sets asserted against are',
          '> spec-derived, not live-verified, so a FIELD_MAP_MISMATCH here may be a bad',
          '> expectation rather than a changed API. Capture live fixtures before trusting it.',
          '',
        ]
      : []),
    '## Blocking',
    '',
    ...result.blocking.map((f) => `- **${f.class}** \`${f.endpoint}\` — ${f.detail}`),
    ...(result.warnings.length ? ['', '## Warnings (not blocking)', '', ...result.warnings.map((f) => `- **${f.class}** \`${f.endpoint}\` — ${f.detail}`)] : []),
    '',
    '## What to do',
    '',
    '- `FIELD_MAP_MISMATCH` — re-capture the fixture (`bin/richapi-capture-fixtures.mjs --run --only <endpoint>`)',
    '  and regenerate the catalog. Every skill reading those keys is reading the wrong ones until you do.',
    '- `CHARGE_MISMATCH` — the server billed more results than the request asked for. The pack\'s cost',
    '  estimates and every gate in `_lib/gates.yaml` are computed from the planned number.',
    '- `BILLING_FIELD_MISSING` — the catalog promises the charge is readable and it is not; the ledger',
    '  will be writing `cost_status: estimated_unverifiable` for this endpoint.',
    '- `REQUEST_REJECTED` — the request contract moved. Compare with `bin/richapi-catalog-drift.mjs`.',
    '',
    'No response bodies are included: a probe response can carry real contact data.',
  ].join('\n');

  return { title: `Live-API canary: ${classes.join(', ')} (${date})`, body, labels: ['canary'] };
}

// ---------------------------------------------------------------------------
// probes
// ---------------------------------------------------------------------------

function readSampleInputs() {
  // The same file bin/richapi-capture-fixtures.mjs reads. It lives under tests/,
  // which package.json `files` does not ship, so an installed copy has none — the
  // capture harness already degrades to derived placeholders and so does this.
  if (!fs.existsSync(SAMPLE_INPUTS)) return {};
  try {
    return JSON.parse(fs.readFileSync(SAMPLE_INPUTS, 'utf8')).inputs ?? {};
  } catch {
    return {};
  }
}

/**
 * Build `{endpoint: {body, method, source}}`.
 *
 * The default source is the capture harness's own synthesis, imported lazily: it
 * parses spec/openapi.yaml, and `--help` must not pay for that or fail when the spec
 * is missing.
 */
export async function loadProbes({ file = null } = {}) {
  if (file) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    const inputs = raw?.inputs ?? raw ?? {};
    const out = {};
    for (const [name, body] of Object.entries(inputs)) {
      if (name.startsWith('_')) continue; // the sample-inputs file documents itself in `_`-prefixed keys
      out[name] = body === null ? { body: null, reason: 'declared uncapturable in the probes file' } : { body, method: 'POST', source: file };
    }
    return out;
  }

  const harness = await import('./richapi-capture-fixtures.mjs');
  const { endpoints } = harness.loadEndpoints();
  const overrides = readSampleInputs();
  const out = {};
  for (const ep of endpoints) {
    const { body, source, unknownFields } = harness.buildRequestBody(ep, overrides);
    out[ep.name] = unknownFields.length
      ? { body: null, reason: `no safe probe body — no placeholder for ${unknownFields.join(', ')}` }
      : { body, method: ep.method, source };
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function helpText() {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const out = [];
  for (let i = 1; i < src.length && src[i].startsWith('//'); i += 1) {
    out.push(src[i].replace(/^\/\/ ?/, ''));
  }
  return out.join('\n');
}

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const known = new Set(['run', 'json', 'help', 'force-unverified-field-map']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (known.has(key)) flags.add(key);
    else opts[key] = argv[++i];
  }
  return { flags, opts };
}

export async function main(argv = process.argv.slice(2), { fetchImpl, env = process.env } = {}) {
  const { flags, opts } = parseArgs(argv);
  if (flags.has('help')) {
    console.log(helpText());
    return 0;
  }

  const json = flags.has('json');
  const refuse = (message, payload = {}) => {
    if (json) console.log(JSON.stringify({ refused: true, reason: message, exit_code: 2, ...payload }, null, 2));
    else console.error(message);
    return 2;
  };

  const catalogFile = opts.catalog ? path.resolve(opts.catalog) : path.join(ROOT, '_lib', 'api-catalog.json');
  const limit = Number(opts.endpoints ?? DEFAULT_ENDPOINT_COUNT);
  const budget = Number(opts.budget ?? DEFAULT_BUDGET_CREDITS);
  const timeoutMs = Number(opts.timeout ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(limit) || limit < 1) return refuse('error: --endpoints must be a positive number');
  if (!Number.isFinite(budget) || budget <= 0) return refuse('error: --budget must be a positive number of credits');

  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  } catch (err) {
    return refuse(`error: cannot read catalog ${path.relative(ROOT, catalogFile)}: ${err.message}`);
  }

  // The origin is checked BEFORE the key is read, so no path through this binary
  // ever holds an origin the key must not be sent to. Same rule, same refusal text
  // and same opt-in as the client and the capture harness.
  let baseUrl;
  try {
    baseUrl = resolveBaseUrl({ baseUrl: opts['base-url'], env }).baseUrl;
  } catch (err) {
    if (err instanceof UnsafeOrigin) return refuse(err.message);
    throw err;
  }

  let probes;
  try {
    probes = await loadProbes({ file: opts.probes });
  } catch (err) {
    // The default source is bin/richapi-capture-fixtures.mjs, which package.json
    // deliberately keeps out of the tarball. An installed copy therefore has no
    // default probes and must be given some — a legible refusal, not a stack trace.
    return refuse(
      `error: cannot build probe bodies: ${err.message}\n` +
        '  The default probes come from bin/richapi-capture-fixtures.mjs and spec/openapi.yaml.\n' +
        '  Pass --probes <file> with {"inputs": {"<endpoint>": {...}}} to supply them directly.'
    );
  }

  let selection;
  try {
    selection = selectEndpoints(catalog, { limit, probes });
  } catch (err) {
    if (err instanceof UnusableCatalogError) return refuse(`error: ${err.message}`);
    throw err;
  }
  if (selection.selected.length === 0) {
    return refuse('error: no endpoint in the catalog is cheap, bounded and probeable — nothing to canary');
  }

  // Fails closed, before anything is called.
  try {
    assertBudget(selection, budget);
  } catch (err) {
    if (err instanceof BudgetExceededError) return refuse(`REFUSED: ${err.message}`, { selected: selection.selected.map((c) => c.name), credits_planned: selection.total });
    throw err;
  }

  const unverified = unverifiedFieldMaps(selection);
  const forced = flags.has('force-unverified-field-map');

  if (!flags.has('run')) {
    if (json) {
      console.log(
        JSON.stringify(
          {
            mode: 'plan',
            calls_made: 0,
            catalog: path.relative(ROOT, catalogFile),
            budget,
            credits_planned: selection.total,
            selected: selection.selected.map((c) => ({
              name: c.name,
              credits: c.credits,
              basis: c.basis,
              charge_observable: c.charge_observable,
              field_map_status: c.field_map_status,
            })),
            excluded: selection.excluded,
            unverified_field_maps: unverified,
            assertable: unverified.length === 0,
            exit_code: 0,
          },
          null,
          2
        )
      );
    } else {
      console.log(formatPlan(selection, { budget, unverified }));
      console.log('  PLAN ONLY — zero HTTP calls were made and zero credits were spent.');
      console.log(`  To run: ${API_KEY_ENV}=... node bin/richapi-canary.mjs --run\n`);
    }
    return 0;
  }

  // ---- from here on, real money ----

  if (unverified.length && !forced) {
    return refuse(formatUnverifiedRefusal(unverified), {
      unverified_field_maps: unverified,
      enable_condition: `live fixture capture landed and every selected endpoint reads field_map_status: ${REQUIRED_FIELD_MAP_STATUS}`,
    });
  }

  const apiKey = env[API_KEY_ENV] ?? env.RICHAPI_API_KEY;
  if (!apiKey) {
    return refuse(
      `REFUSED: --run needs a live key and this environment has none.\n` +
        `  export ${API_KEY_ENV}='<your key>'\n` +
        `  This run would spend approximately ${selection.total} credits.\n` +
        '  Nothing was called and nothing was charged.'
    );
  }

  const result = await runCanary({ selection, baseUrl, apiKey, fetchImpl, timeoutMs });
  const payload = issuePayload(result, { forced });

  if (opts['issue-file']) {
    const target = path.resolve(opts['issue-file']);
    if (payload) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(payload, null, 2) + '\n');
    } else if (fs.existsSync(target)) {
      // A stale payload from a previous run would open an issue for a clean one.
      fs.rmSync(target);
    }
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: 'run',
          forced,
          catalog: path.relative(ROOT, catalogFile),
          credits_planned: result.credits_planned,
          credits_observed: result.credits_observed,
          runs: result.runs,
          findings: result.findings,
          blocking: result.blocking.map((f) => ({ class: f.class, endpoint: f.endpoint })),
          issue: payload,
          exit_code: result.exitCode,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatReport(result, { forced }));
    if (payload) console.log(`  Issue payload written to ${opts['issue-file'] ?? '<nowhere: pass --issue-file>'}\n`);
  }
  return result.exitCode;
}

// Compared through realpath: npm installs bins as symlinks and a bare
// `=== process.argv[1]` is also false for a relative path. Both make the command a
// silent no-op that reads as success. See tests/contracts/executables-load.test.mjs.
const isMain = (() => {
  if (!process.argv[1]) return false;
  const real = (f) => {
    try {
      return fs.realpathSync(f);
    } catch {
      return path.resolve(f);
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(path.resolve(process.argv[1]));
})();

if (isMain) {
  process.exitCode = await main();
}
