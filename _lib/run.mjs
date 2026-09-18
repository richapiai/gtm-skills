// _lib/run.mjs — the gated call surface every skill uses.
//
// THE GAP THIS CLOSES
//
// `skills/richapi-gtm/SKILL.md` says: "Do not improvise a workflow out of raw endpoint
// calls: the whole value of this pack is the gates, the journal and the cost accounting,
// and a hand-rolled call has none of them."
//
// Until this module existed only ONE workflow could obey that instruction. `richapi
// enrich` composes the plan, the gates, the journal, the ledger, the cache and resume;
// every other skill had no subcommand at all, so its calls were issued raw — with no
// gate, no journal line, no ledger line and no cache. Thirty-one of thirty-three skills
// were documentation of a runtime that refused to run them.
//
// So this is `_lib/enrich.mjs`'s composition, GENERALISED to any catalog endpoint.
// Nothing here re-implements the underlying modules; it re-composes them:
//
//   plan      dryrun.buildPlan          cost from the generated catalog, never typed
//   gates     gates.checkCall           + a PER-PAGE page gate, evaluated on the plan
//   suppress  suppression.*             fail-closed, before any call and before output
//   journal   journal.RunJournal        before AND after each call; the resume key
//   execute   batch.runHopMajor         which is journal.runWaterfall plus batching
//   ledger    ledger.Ledger             never fabricates an actual
//   output    suppression.writeOutputList   the only writer
//
// TWO SHAPES, ONE EXECUTOR
//
//   runCall    N input rows x 1 endpoint. The unit is a ROW. Auto-batches.
//   runSearch  1 parameter set x N pages. The unit is a PAGE. Page-gated per page.
//
// They differ only in how the plan's rows are built, which is why they share one
// executor rather than being two half-copies of it. `runSearch` models a page as a
// plan ROW (not as a hop) for one concrete reason: `buildPlan` carries `cached` as a
// set of ENDPOINT names, so pages-as-hops would mark every page cached the moment one
// page was, and a 20-page plan would claim to be free.
//
// WHAT IS DELIBERATELY DUPLICATED FROM enrich.mjs (enrich.mjs owns that logic; these
// are the points where the two would collapse into one):
//   - `gatePlanFor` is `enrich.gatePlan` made page-aware.
//   - `createPayloadCache` is `cache.createCache` keyed on an explicit payload.
//     It writes the SAME files with the SAME key function, so it is hit-compatible
//     with the enrich cache in both directions.
// Everything else is imported.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  RunJournal, readJournal, planResume, summarize, unitKey, acquireListLock, HttpError,
  failureSummary,
} from './journal.mjs';
import { buildPlan, writeDryRun, renderPlanText, reconcile, PlanContractError } from './dryrun.mjs';
import { Ledger, estimate as estimateCost, billingVerdict } from './ledger.mjs';
import {
  loadGates, createSession, setBudget, checkCall, checkPageGate, recordSpend,
  checkSessionSpend, assumedResultsPerPage, gateValue, MissingGateKey, worst, STOP, CONFIRM,
} from './gates.mjs';
import { loadSuppressionStore, isSuppressed, rowIdentifiers, writeOutputList } from './suppression.mjs';
import {
  REQUEST_CONTRACTS, buildRequest, RichApiClient, inspectResponse, readAttribution,
  urnOf, MissingApiKey, RESPONSE_MAPS, MAP_NO_MAP, noteRemediation,
} from './client.mjs';
import { cacheKey, cacheFile, nullCache } from './cache.mjs';
import { appendPiiRow, readPiiJsonl, isExpired, loadTtlTable, ttlForEndpoint } from './pii.mjs';
import { runHopMajor, bulkVariantFor, BUDGET_STOP, alignBulkRows } from './batch.mjs';
import { createMappingAudit } from './mapping-audit.mjs';
import { buildReceipt, assertNeverOverstates, assertMappingSurfaced } from './receipt.mjs';
import {
  readInputRows, rowIdFor, loadCatalog, appendResult, loadResults,
  present, withoutEmptyMarkers, skippedSummary, NOT_A_FAILURE,
} from './enrich.mjs';
import { GATES_PATH } from './paths.mjs';
import { postUrnFrom, POST_URN_ENDPOINTS } from './linkedin-urn.mjs';

export class RunError extends Error {
  constructor (msg) { super(msg); this.name = 'RunError'; }
}

const sha = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex');

/**
 * Own-property lookup on a plain object used as a MAP. Same fix `_lib/gates.mjs` already
 * applies at its own lookups, and `_lib/batch.mjs` at `bulkVariantFor`.
 *
 * `catalog.endpoints['__proto__']` answers with Object.prototype and
 * `catalog.endpoints['constructor']` with the Object function, so both used to satisfy a
 * bare `if (!def)` membership check. The guard whose entire job is "refusing to guess a
 * payload" waved them through: `richapi call __proto__` PLANNED, priced at zero because
 * Object.prototype has no `pricing`, and gated against Object.prototype's absent
 * everything. `nope_not_real` was refused correctly, which is what made it look fine.
 */
function own (obj, key) {
  return obj != null && (typeof key === 'string' || typeof key === 'number')
    && Object.prototype.hasOwnProperty.call(obj, key);
}

/** The catalog's entry for an endpoint, or null. Never Object.prototype. */
function catalogEntry (catalog, endpoint) {
  const eps = catalog?.endpoints;
  return own(eps, endpoint) ? eps[endpoint] : null;
}

// `present` is the pack-wide presence test and lives in enrich.mjs, because the pack's
// explicit empty markers (`not_found`, `not_verifiable`, `not_applicable`) must read as
// ABSENT in every planner, not just in one of them. run.mjs used to carry its own copy
// that did not know them, so `--param email=not_found` built a paid request.


/** Stable canonical JSON, so the same question always hashes the same. */
function canonical (v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => { o[k] = canonical(v[k]); return o; }, {});
  }
  return v;
}

// ---------------------------------------------------------------------------
// gates.yaml:request_page_multipliers — the clamp the runtime actually enforces
// ---------------------------------------------------------------------------
//
// THE HAZARD. The page gate counts REQUESTS. Two endpoints take a request field that
// multiplies how many pages the provider walks per request, so the gate fires once,
// `hard_page_ceiling` counts one, and the bill covers everything that comes back:
//
//   directory_yellowpages.max_pages    one request scrapes N pages
//   google_search_scraper_sync.limit   "Maximum number of result PAGES to fetch"
//
// The second is the trap. `limit` means "max RESULTS to return" on all five sibling
// scrapers and "max PAGES" on this one alone, and it is charged `credits_per_result`
// with `billing_field_present_in_response: false` — so the receipt can never correct
// a user who over-asked. Measured: `--param limit=100` planned at 25 credits and the
// ledger recorded 1000, as `estimated_unverifiable`.
//
// gates.yaml declared the clamp, `tests/contracts/page-multiplier.test.mjs` asserted
// it was DECLARED, and no runtime file read it. A control nobody reads is worse than
// no control, because a reviewer who greps gates.yaml concludes the hazard is handled.
// This is the reader.
//
// It fails closed in both directions: a listed endpoint whose `field` or `clamp` is
// missing REFUSES the call rather than sending it unclamped, and an unreadable
// gates.yaml refuses too (law 5 — and an unreadable gates.yaml already STOPs every
// gate in checkCall, so this is consistent, not newly harsh).

/** The shipped gates, read once. Only used when a caller passes none of its own. */
let DEFAULT_GATES = null;
function defaultGates () {
  DEFAULT_GATES ??= loadGates();
  return DEFAULT_GATES;
}

/**
 * The declared page multiplier for an endpoint, or null when it declares none.
 *
 * Throws MissingGateKey when the policy block itself cannot be read, and returns a
 * `broken` descriptor when a LISTED endpoint is missing its field or clamp — the
 * caller turns both into a refusal.
 */
export function pageMultiplierFor (gates, endpoint) {
  // Both reads are LITERAL dotted paths, which is also what makes them visible to
  // tests/contracts/skill-gate-keys.test.mjs. Reading the endpoint map whole and
  // indexing it here — rather than interpolating the endpoint name into a gateValue
  // path — keeps every key this module reads a real, resolvable key.
  const policy = gateValue(gates, 'request_page_multipliers.policy');
  const declared = gateValue(gates, 'request_page_multipliers.endpoints');
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) {
    throw new MissingGateKey('request_page_multipliers.endpoints', 'not a map');
  }
  if (!Object.prototype.hasOwnProperty.call(declared, endpoint)) return null;

  const entry = declared[endpoint] ?? {};
  const base = `request_page_multipliers.endpoints.${endpoint}`;
  const field = entry.field;
  const clamp = entry.clamp;
  if (typeof field !== 'string' || field.trim() === '') {
    return { policy, broken: `${base}.field`, reason: 'missing or not a field name' };
  }
  if (!Number.isInteger(clamp) || clamp < 1) {
    return { policy, broken: `${base}.clamp`, reason: 'missing, or not an integer >= 1' };
  }
  return { policy, field, clamp };
}

/**
 * Clamp the declared multiplier field in a built payload.
 *
 * Returns the request unchanged when nothing is declared, and NEVER rewrites a
 * parameter silently: a fired clamp comes back as a `clamped` note that the plan, the
 * dry run and the run output all print. The user asked for something specific and got
 * something else; being told is the difference between a control and a surprise.
 */
export function clampPageMultiplier (endpoint, payload, gates) {
  let cfg;
  try {
    cfg = pageMultiplierFor(gates, endpoint);
  } catch (e) {
    if (!(e instanceof MissingGateKey)) throw e;
    return {
      ok: false,
      reason: `gates.yaml key ${e.key} is unreadable (${e.message}) — refusing to build a request `
        + 'for any endpoint until the page-multiplier policy can be read (law 5). Two endpoints '
        + 'multiply pages from inside the request body and one of them is unverifiable at 1 credit '
        + 'per result; sending unclamped is the failure this key exists to prevent.',
    };
  }
  if (!cfg) return { ok: true, payload };
  if (cfg.broken) {
    return {
      ok: false,
      reason: `${endpoint} is declared in gates.yaml:request_page_multipliers.endpoints but `
        + `${cfg.broken} is missing (${cfg.reason}) — failing closed rather than sending the `
        + 'request unclamped (law 5).',
    };
  }
  if (cfg.policy !== 'clamp') {
    return {
      ok: false,
      reason: `gates.yaml:request_page_multipliers.policy is "${cfg.policy}", and the only policy `
        + 'this runtime implements is "clamp" — failing closed rather than guessing what it means.',
    };
  }

  const asked = payload?.[cfg.field];
  if (asked === undefined || asked === null) return { ok: true, payload };
  const n = Number(asked);
  const clamp = Number(cfg.clamp);
  if (!Number.isFinite(n) || n <= clamp) return { ok: true, payload };

  return {
    ok: true,
    payload: { ...payload, [cfg.field]: clamp },
    clamped: {
      endpoint,
      field: cfg.field,
      requested: n,
      clamp,
      gate: `request_page_multipliers.endpoints.${endpoint}.clamp`,
      note: `${endpoint}.${cfg.field}: ${n} was CLAMPED to ${clamp} before the request was built `
        + `(gates.yaml:request_page_multipliers.endpoints.${endpoint}.clamp). On this endpoint `
        + `\`${cfg.field}\` bounds how many PAGES one request walks, not how many results it `
        + `returns, and the charge is per result — so ${n} would have multiplied the bill by up `
        + `to ${n}x while the page gate counted a single call. Raise the clamp in gates.yaml if `
        + 'that is genuinely what you meant; it is a deliberate act, not a flag.',
    },
  };
}

/** Apply the clamp to a buildRequest*-shaped result, carrying the note through. */
function withClamp (endpoint, req, gates) {
  if (!req?.ok) return req;
  const c = clampPageMultiplier(endpoint, req.payload, gates);
  if (!c.ok) return { ok: false, reason: c.reason };
  return c.clamped ? { ...req, payload: c.payload, clamped: c.clamped } : req;
}

// ---------------------------------------------------------------------------
// The request's own bound on how many results one call can return
// ---------------------------------------------------------------------------
//
// `planRowCall` used to derive its result count from ARRAY LENGTHS only, so a scalar
// bound in the payload was invisible and the plan fell back to
// `gates.yaml:unbounded_endpoints.assumed_results_per_page`. Measured:
// `richapi search people_search --param limit=1000 --pages 1` planned at 2.5 credits
// against a real charge of 0.1 x 1000 = 100. Nothing fired — the page gate saw one
// page, and `session_budget.fractions.single_call_confirm` (0.25 of budget) was
// evaluated against 2.5 instead of 100, which is exactly the "one huge unbounded
// search on call #1" that gate exists to catch. `--page-size 1000` priced it right,
// so the CLI already had the knob; nothing tied it to `--param limit`.
//
// The field names below are a PINNED SET, not a guess: every numeric request property
// in the pinned spec that bounds how many things one call RETURNS is spelled `limit`.
// `tests/request-limits/request-bound.test.mjs` re-derives that from spec/openapi.yaml and fails
// if a spec revision introduces another spelling, so the list cannot quietly go stale.
//
// Fields that bound PAGES rather than results are deliberately excluded: they are the
// multiplier class above, they are clamped, and a page count is not a result count.
export const RESULT_BOUND_FIELDS = Object.freeze(['limit', 'max_results', 'page_size', 'per_page']);

/**
 * The request field this endpoint actually declares for "results per page", or null.
 *
 * THE DEFECT THIS EXISTS FOR. `--page-size` was a PRICING knob and nothing else: it was
 * never put on the wire, for any endpoint. Live 2026-09-17:
 * `richapi search lead_search --page-size 10` planned 10 base + 0.5 x 10 = 15 credits,
 * the API answered 25 results and billed 22.5 — 50% over a plan the user approved. The
 * spec says why: `lead_search` declares `page` and `session_id` and NO size field, so
 * there was never a parameter to send. The size is the server's choice and the plan
 * has to say so instead of quietly pricing the caller's wish.
 *
 * Read from the catalog's `request_fields` (law 1: the catalog is the source of truth
 * for routing). A null `request_fields` — an older catalog — reads as "unknown", which
 * is treated as "no control", the conservative half.
 */
export function pageSizeFieldFor (def, gates = null, endpoint = null) {
  const all = Array.isArray(def?.request_fields) ? def.request_fields : null;
  if (!all) return null;
  let multiplierField = null;
  try {
    multiplierField = endpoint ? pageMultiplierFor(gates ?? defaultGates(), endpoint)?.field ?? null : null;
  } catch { /* an unreadable policy is the clamp's problem, not this one's */ }
  return RESULT_BOUND_FIELDS.find((f) => f !== multiplierField && all.includes(f)) ?? null;
}

/**
 * The per-call result ceiling the caller themselves put in the payload, or null.
 *
 * Read from the built payload rather than from the catalog because the catalog records
 * no request-field list (`request_fields` is absent for all 68 endpoints) — and the
 * payload is already an allow-list of fields the caller named or the endpoint requires,
 * so nothing arbitrary can reach it.
 */
export function requestBound (endpoint, payload, gates) {
  if (!payload || typeof payload !== 'object') return null;
  let multiplierField = null;
  try {
    multiplierField = pageMultiplierFor(gates, endpoint)?.field ?? null;
  } catch { /* unreadable policy is handled by the clamp, which refuses the request */ }

  for (const field of RESULT_BOUND_FIELDS) {
    if (field === multiplierField) continue;      // bounds pages, not results
    const v = payload[field];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Request building for ANY catalog endpoint
// ---------------------------------------------------------------------------

/**
 * Build and validate a request body for any of the catalog's endpoints.
 *
 * `client.buildRequest` is the authority for the eight endpoints it hand-writes a
 * contract for — those floors are STRICTER than the spec (the spec makes an empty POST
 * valid on the 25-credit `phone_finder`) and they carry the input-column renames
 * (`linkedin_url` -> `url`). We defer to it whenever it has an opinion.
 *
 * For the other sixty endpoints the catalog's `required_request_fields` is the floor,
 * and the payload is built from an ALLOW-LIST — the endpoint's required fields, the
 * parameters the caller named, and any extra row columns the caller opted in. A row is
 * never poured wholesale into a request body: a prospect list carries contact columns
 * that no endpoint asked for, and shipping them is both a wasted PII egress and a
 * source of silent 400s.
 *
 * Returns { ok: true, payload } or { ok: false, reason }. A false is journalled as a
 * skipped unit, never as a paid call.
 */
export function buildRequestFor (endpoint, record, catalog, { params = {}, fields = [], gates = null } = {}) {
  // The pack's explicit empty markers are stripped BEFORE anything is built, so
  // `email_verifier --param email=not_found` fails the contract instead of buying a
  // verification of the string "not_found". client.buildRequest has its own presence
  // test that does not know the marker vocabulary, which is why this happens here.
  let merged = withoutEmptyMarkers({ ...(record ?? {}), ...params });
  if (POST_URN_ENDPOINTS.includes(endpoint) && present(merged.post_url) && !present(merged.urn)) {
    // A pasted post URL becomes the `urn` these endpoints require. `post_url` itself
    // is never sent: it is an input column, not a request field.
    const parsed = postUrnFrom(String(merged.post_url));
    if (!parsed.ok) return { ok: false, reason: `${endpoint}: ${parsed.reason}` };
    const { post_url: _drop, ...rest } = merged;
    merged = { ...rest, urn: parsed.urn };
    const { post_url: _dropParam, ...restParams } = params;
    params = { ...restParams, urn: parsed.urn };
    fields = fields.filter((f) => f !== 'post_url');
  }
  const g = gates ?? defaultGates();
  if (own(REQUEST_CONTRACTS, endpoint)) return withClamp(endpoint, buildRequest(endpoint, merged), g);

  const def = catalogEntry(catalog, endpoint);
  if (!def) {
    return { ok: false, reason: `"${endpoint}" is not in the catalog — refusing to guess a payload` };
  }

  const required = Array.isArray(def.required_request_fields) ? def.required_request_fields : [];
  const allowed = new Set([...required, ...Object.keys(params), ...fields]);

  const payload = {};
  for (const key of allowed) {
    const v = merged[key];
    if (!present(v)) continue;
    payload[key] = (typeof v === 'string') ? v.trim() : v;
  }

  const missing = required.filter((k) => !Object.prototype.hasOwnProperty.call(payload, k));
  if (missing.length) {
    return {
      ok: false,
      reason: `insufficient input for ${endpoint}; missing required field(s): ${missing.join(', ')}`,
    };
  }
  if (Object.keys(payload).length === 0) {
    // Ten endpoints declare NOTHING required, `lead_search` (10 credits base) among
    // them. An empty POST is spec-valid and still billable, so it is refused here
    // rather than sent and paid for.
    //
    // The exception is an endpoint that is BOTH free and genuinely fieldless.
    // `search_reference_data` is the case: the spec gives it `properties: {}`, so an
    // empty POST is not merely spec-valid, it is the ONLY spec-valid body — and the
    // catalog prices it at zero, so the guard's entire rationale ("still billable")
    // does not apply. Refusing it made the endpoint unreachable, and the only way
    // past was to invent an undeclared --param, which is worse: it teaches callers to
    // smuggle fields no endpoint asked for.
    //
    // Kept narrow. Free is not enough on its own and neither is fieldless: an
    // endpoint that declares optional fields still has a meaningful empty call to
    // refuse, and a billable fieldless endpoint is exactly what the guard is for.
    const free = isFreeEndpoint(def);
    const fieldless = declaresNoRequestFields(def);
    if (free && fieldless) return withClamp(endpoint, { ok: true, payload }, g);

    return {
      ok: false,
      reason: `${endpoint} declares no required request field, and no parameter was supplied — `
        + 'refusing to send an empty POST (spec-valid, still billable)',
    };
  }
  return withClamp(endpoint, { ok: true, payload }, g);
}

/** Zero-cost per the catalog. Absent or non-zero pricing is treated as billable. */
function isFreeEndpoint (def) {
  const p = def?.pricing;
  if (!p) return false;
  if (p.model === 'free') return true;
  const flat = p.credits_per_call;
  const base = p.credits_base;
  const per = p.credits_per_result;
  return (flat === 0 || flat === null) && (base === 0 || base === null) && (per === 0 || per === null)
    && flat === 0;
}

/** The endpoint's schema declares no request properties at all — not merely none required. */
function declaresNoRequestFields (def) {
  const required = Array.isArray(def?.required_request_fields) ? def.required_request_fields : [];
  const all = Array.isArray(def?.request_fields) ? def.request_fields : null;
  if (required.length > 0) return false;
  // When the catalog records the full field list, trust it. When it does not, fall
  // back to "no required fields" only for a free endpoint, which the caller has
  // already checked.
  return all === null ? true : all.length === 0;
}

// ---------------------------------------------------------------------------
// Read-through cache, keyed on the payload
// ---------------------------------------------------------------------------

/**
 * `cache.createCache` derives its key by calling `client.buildRequest(endpoint, record)`,
 * which returns `ok: false` for the sixty endpoints with no hand-written contract — so
 * for those it silently never hits and never writes. This is the same cache, keyed on a
 * payload the caller already built.
 *
 * On-disk it is byte-compatible: same file (`gtm/enrichment-cache/<endpoint>.jsonl`),
 * same `cacheKey`, same PII provenance stamping, same pii.mjs TTL table. An entry
 * written by `richapi enrich` is a hit for `richapi call`, and the reverse.
 */
export function createPayloadCache ({
  root = process.cwd(),
  dir = 'gtm',
  table = null,
  now = () => new Date(),
  enabled = true,
} = {}) {
  if (!enabled) return { ...nullCache('--no-cache'), ttl_source: null };

  // gates.yaml ships with the PACKAGE, not with the user's GTM workspace.
  const ttl = table || loadTtlTable({ root, gatesPath: GATES_PATH });
  const stats = { hits: 0, misses: 0, writes: 0, expired: 0, unusable: 0, endpoints: {} };
  const index = new Map();

  const bump = (endpoint, field) => {
    stats.endpoints[endpoint] ??= { hits: 0, misses: 0, writes: 0, expired: 0 };
    stats.endpoints[endpoint][field] += 1;
    stats[field] += 1;
  };

  const load = (endpoint) => {
    if (index.has(endpoint)) return index.get(endpoint);
    const map = new Map();
    index.set(endpoint, map);
    const file = cacheFile(root, dir, endpoint);
    if (!fs.existsSync(file)) return map;
    let rows;
    try {
      // Non-strict: a damaged cache degrades to a miss and costs credits. It must
      // never wedge a run, and it must never serve unprovenanced PII.
      ({ rows } = readPiiJsonl(file, { strict: false }));
    } catch {
      stats.unusable += 1;
      return map;
    }
    const clock = now();
    for (const row of rows) {
      if (!row.key) continue;
      if (isExpired(row, { now: clock, table: ttl })) { bump(endpoint, 'expired'); map.delete(row.key); continue; }
      map.set(row.key, row);
    }
    return map;
  };

  return {
    enabled: true,
    ttl_source: ttl.source,
    ttlMs (endpoint) { return ttlForEndpoint(endpoint, ttl); },

    has (endpoint, payload) {
      if (ttlForEndpoint(endpoint, ttl) === 0) return false;   // never-cache sentinel
      return load(endpoint).has(cacheKey(payload));
    },

    get (endpoint, payload) {
      if (ttlForEndpoint(endpoint, ttl) === 0) return null;
      const row = load(endpoint).get(cacheKey(payload));
      if (!row) { bump(endpoint, 'misses'); return null; }
      bump(endpoint, 'hits');
      return row.response ?? null;
    },

    put (endpoint, payload, response) {
      if (ttlForEndpoint(endpoint, ttl) === 0) return null;
      const key = cacheKey(payload);
      const stamped = appendPiiRow(
        cacheFile(root, dir, endpoint),
        { key, response: response ?? null },
        { endpoint, now: now(), key },
      );
      load(endpoint).set(key, stamped);
      bump(endpoint, 'writes');
      return stamped;
    },

    stats,
  };
}

// ---------------------------------------------------------------------------
// Gating the PLAN, not the call
// ---------------------------------------------------------------------------

/**
 * Evaluate every gate on the whole plan, once, before a single credit moves.
 *
 * This is `enrich.gatePlan` with the fix the search skills need: `enrich` hard-codes
 * `page: 1` on every `checkCall`, so `unbounded_endpoints.pages_before_confirm` — the
 * gate whose entire job is "a human between pages is the only real bound" — could
 * never fire. Here every distinct planned page is checked, so a 12-page plan surfaces
 * eleven page confirms and a 21-page plan is STOPPED by the hard ceiling BEFORE it
 * buys page one.
 *
 * Per-call prompting is deliberately not an option. At ~8 credits a contact a 100-row
 * list is ~800 credits; prompting per call fires dozens of times during the trial that
 * decides whether the user ever pays, and gate fatigue kills the only control there is.
 */
export function gatePlanFor ({ plan, catalog, session, pages = [] }) {
  const decisions = [];
  const seen = new Set();

  for (const hop of plan.per_hop) {
    if (hop.calls_planned === 0 || seen.has(hop.endpoint)) continue;
    seen.add(hop.endpoint);
    // An endpoint the catalog does not carry has no known cost, so it cannot be gated.
    // `checkCall` treats a null catalogEntry as "the caller did not supply one" — which
    // is right for the (plan total) line and wrong here, so the refusal is made
    // explicit rather than left to a null that reads as consent. Before the
    // own-property fix this branch was unreachable for a prototype name: the lookup
    // returned Object.prototype, whose absent `pricing.model` happened to STOP.
    const entry = catalogEntry(catalog, hop.endpoint);
    if (!entry) {
      decisions.push({
        decision: STOP,
        gate: 'catalog.endpoint',
        endpoint: hop.endpoint,
        reason: `"${hop.endpoint}" is not in the catalog, so its cost cannot be known and the `
          + 'call cannot be gated — failing closed (law 5)',
        failed_closed: true,
      });
      continue;
    }

    decisions.push(checkCall(session, {
      endpoint: hop.endpoint,
      catalogEntry: entry,
      estimatedCredits: hop.credits_estimated,
      page: 1,
    }));
  }

  // The page gate, per planned page. `checkPageGate` is monotone in the page number,
  // so checking each planned page and taking the worst is exact, not a sample.
  //
  // A page is gated as the HIGHER of its raw number and its position in this run.
  // Zero-based endpoints (`people_search`, `post_activities`) plan pages 0, 1, 2…, and
  // `checkPageGate` reads a raw 0 as page 1 — so, gated on the raw number alone, the
  // second page bought ran without asking. The position fixes that; the raw number
  // keeps `--start-page` deep into a walk exactly as strict as before.
  for (const endpoint of seen) {
    for (const [i, page] of [...pages].sort((a, b) => a - b).entries()) {
      const effective = Math.max(i + 1, Number(page) || 0);
      if (effective === 1) continue;                // already covered by checkCall above
      const d = checkPageGate(session.gates, endpoint, effective);
      if (d.decision !== STOP && d.decision !== CONFIRM) continue;
      decisions.push({ ...d, endpoint, page });
    }
  }

  // The whole-plan spend check, once, against the session budget.
  decisions.push(checkCall(session, {
    endpoint: '(plan total)',
    estimatedCredits: plan.totals.credits_estimated,
  }));

  const stops = decisions.filter((d) => d.decision === STOP);
  const confirms = decisions.filter((d) => d.decision === CONFIRM);
  return { decisions, stops, confirms, blocked: stops.length > 0, worst: worst(decisions) };
}

// ---------------------------------------------------------------------------
// Auto-batching
// ---------------------------------------------------------------------------

/**
 * Is auto-batching switched on?
 *
 * Batching does not change what a run COSTS (`enrich_profile` is 1 credit per call,
 * `enrich_profiles_bulk` 1 credit per result — batch.mjs's whole premise), so this is
 * not a spend gate. It is a CORRECTNESS switch: the bulk endpoints have no 200 example
 * in the spec, so attribution across a bulk response is positional, and a correctly
 * sized response in the wrong order hands contact A contact B's email.
 *
 * So it fails closed toward the SAFER path. A missing `runtime.batch.auto` key means
 * single calls, with the reason recorded — never "no gate, batch away".
 */
export function batchPolicy (gates) {
  try {
    const on = gateValue(gates, 'runtime.batch.auto') === true;
    return { auto: on, reason: on ? null : 'gates.yaml:runtime.batch.auto is false — single calls' };
  } catch (e) {
    if (e instanceof MissingGateKey) {
      return {
        auto: false,
        reason: `gates.yaml key ${e.key} is missing — failing closed to single calls (law 5). `
          + 'Bulk attribution is positional and the bulk response shape is unverified, so the '
          + 'closed position is not to batch.',
      };
    }
    throw e;
  }
}

/**
 * The identifier a bulk variant needs from a row, or null with a reason.
 *
 * THE TRAP, stated so it cannot be forgotten: `enrich_profile` takes `url` (a LinkedIn
 * profile URL); `enrich_profiles_bulk` takes `urns` (LinkedIn entity URNs). Nothing in
 * this API converts one into the other. So batching gates on the row ALREADY carrying a
 * URN, per row, and when it does not the fallback is recorded — N unexplained single
 * calls is how a 50x latency penalty goes unnoticed.
 */
export function bulkIdentifierFor (bulkDef, record) {
  const required = Array.isArray(bulkDef?.required_request_fields) ? bulkDef.required_request_fields : [];
  if (required.length !== 1 || required[0] !== 'urns') {
    return { id: null, reason: `${bulkDef?.name ?? 'the bulk variant'} takes [${required.join(', ') || 'nothing declared'}], which cannot be derived per row` };
  }
  const urn = urnOf(record);
  return urn
    ? { id: urn, reason: null }
    : { id: null, reason: 'row carries no LinkedIn URN (a profile URL is not a URN, and no endpoint converts one)' };
}

/**
 * Decide batching for a whole hop, and RECORD the decision either way. The returned
 * object is surfaced in the run result and in the rendered report: a run that fell back
 * to single calls always says why, and names how many rows were short an identifier.
 */
export function planBatching ({ catalog, endpoint, gates, units, recordOf }) {
  const decision = {
    endpoint,
    bulk_variant: null,
    max_batch: null,
    batched: false,
    split: 'none',                 // none | all | partial
    reason: null,
    rows_callable: 0,
    rows_with_identifier: 0,
    rows_without_identifier: 0,
    fallback_reasons: {},
    eligible: new Set(),
    attribution: null,
  };

  const bulk = bulkVariantFor(catalog, endpoint);
  if (!bulk) {
    decision.reason = `${endpoint} declares no usable bulk variant in the catalog`;
    return decision;
  }
  decision.bulk_variant = bulk.endpoint;
  decision.max_batch = bulk.maxBatch;

  const callable = units.filter((u) => !u.skip);
  decision.rows_callable = callable.length;

  const policy = batchPolicy(gates);
  if (!policy.auto) {
    decision.reason = policy.reason;
    return decision;
  }

  for (const u of callable) {
    const { id, reason } = bulkIdentifierFor(bulk.def, recordOf(u.row_id));
    if (id) { decision.rows_with_identifier += 1; decision.eligible.add(u.row_id); }
    else {
      decision.rows_without_identifier += 1;
      decision.fallback_reasons[reason] = (decision.fallback_reasons[reason] ?? 0) + 1;
    }
  }

  const n = decision.rows_with_identifier;
  if (n < 2) {
    decision.eligible.clear();
    decision.reason = decision.rows_without_identifier > 0
      ? `${bulk.endpoint} needs \`urns\` and only ${n} of ${callable.length} row(s) carry one — `
        + `${Object.keys(decision.fallback_reasons)[0] ?? 'no identifier'}. All ${callable.length} go as single calls.`
      : `only ${n} callable row — a batch of one is a single call`;
    return decision;
  }

  decision.batched = true;
  decision.split = decision.rows_without_identifier === 0 ? 'all' : 'partial';
  decision.attribution = 'by_identity';
  const calls = Math.ceil(n / bulk.maxBatch);
  const head = decision.split === 'all'
    ? `all ${n} rows carry a URN`
    : `${n} of ${callable.length} rows carry a URN; the other ${decision.rows_without_identifier} `
      + `fall back to single calls (${Object.keys(decision.fallback_reasons)[0]})`;
  decision.reason = `${head} — ${n} row(s) batch into ${calls} call(s) of up to ${bulk.maxBatch}. `
    + 'Bulk results are matched to rows by IDENTITY (entityUrn), never by position — the live '
    + 'endpoint does not answer in request order. A row the response does not name fails, '
    + 'rather than taking another row\'s data.';
  return decision;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Per-call expected result count, used to price a per-result endpoint honestly. */
function expectedResultsFor (def, gates, override) {
  const model = def?.pricing?.model;
  // A flat endpoint is one credit per CALL. Handing it a result count makes
  // ledger.estimate multiply by it, which would invent a charge that cannot happen.
  if (model === 'flat') return null;
  if (override !== null && override !== undefined) return Number(override);
  // A per-result endpoint cannot be priced without a count. The gates file states the
  // assumption out loud so the plan can name its basis instead of reporting "unknown".
  return assumedResultsPerPage(gates);
}

/**
 * Build the plan for a row-major call. Pure: makes no calls, writes nothing.
 */
export function planRowCall ({
  runId, endpoint, records, catalog, gates, store, cache,
  params = {}, fields = [], expectedResults = null, now = () => new Date().toISOString(),
}) {
  const def = catalogEntry(catalog, endpoint);
  if (!def) throw new RunError(`"${endpoint}" is not in the catalog — run: node bin/richapi-catalog-gen.mjs`);

  const clamps = [];
  const prepared = records.map((record, index) => {
    const row_id = rowIdFor(record, index);
    const req = buildRequestFor(endpoint, record, catalog, { params, fields, gates });
    if (req.clamped) clamps.push(req.clamped);
    // Check the record AND what is actually about to go on the wire.
    //
    // `record` is `{}` for a `--param`-only call — the documented form in
    // `richapi --help` (`richapi call email_verifier --param email=a@b.com`). The
    // address lives in `params`, which `buildRequestFor` merges into the PAYLOAD on
    // the line above, so a check that reads only `record` finds no identifiers,
    // reports "0 suppressed", and plans a paid call against someone who
    // unsubscribed. Measured: the same address was dropped via `--in` and billed
    // via `--param`.
    //
    // The payload is the precise thing law 5 is about — it is what reaches the API —
    // so the union of both is the check. The record is still read on its own because
    // it can carry an identifier the request contract does not send (a personal
    // address in an unused column), and suppressing on that is also correct.
    const ids = [...new Set([
      ...rowIdentifiers(record),
      ...(req.ok ? rowIdentifiers(req.payload) : []),
    ])];
    const suppressed = ids.some((id) => isSuppressed(store, id));
    const cached = req.ok && cache.enabled && cache.has(endpoint, req.payload);
    return {
      row_id,
      record,
      request: req.ok ? req.payload : null,
      skipReason: req.ok ? null : req.reason,
      descriptor: {
        row_id,
        has: req.ok ? [] : ['done'],   // not callable -> "already has" the result
        suppressed,
        cached: cached ? [endpoint] : [],
      },
      cachedBody: cached ? cache.get(endpoint, req.payload) : null,
    };
  });

  // A per-result endpoint cannot be priced without a count. When the request itself
  // carries the list being charged for — `enrich_profiles_bulk` takes `urns` — that
  // list IS the count, and using it beats the gates.yaml assumption by a mile:
  // 3 URNs priced as 25 results overstates the plan 8x and trains people to skim it.
  //
  // A SCALAR bound counts too, and used not to. `--param limit=1000` is the caller
  // stating the ceiling they are buying; ignoring it priced the call at the 25-result
  // assumption and disarmed `session_budget.fractions.single_call_confirm`, whose
  // whole job is to catch one huge call on call #1. Whichever bound is LARGER wins,
  // because the estimate must not understate what the request can bring back.
  const arrayLen = (payload) => Math.max(0, ...Object.values(payload ?? {}).map((v) => (Array.isArray(v) ? v.length : 0)));
  const boundOf = (payload) => Math.max(arrayLen(payload), requestBound(endpoint, payload, gates) ?? 0);
  const lens = prepared.filter((p) => p.request).map((p) => boundOf(p.request)).filter((n) => n > 0);
  const fromRequest = lens.length && lens.every((n) => n === lens[0]) ? lens[0] : null;
  const expected = expectedResultsFor(def, gates, expectedResults ?? fromRequest);
  const waterfall = [{ endpoint, only_if_missing: 'done', expected_results: expected }];

  const plan = buildPlan({
    runId, rows: prepared.map((p) => p.descriptor), waterfall, catalog, now,
  });
  return { plan, prepared, waterfall, pages: [1], expected, clamps };
}

/**
 * Build the plan for a paged search. Pure.
 *
 * A page is a plan ROW, not a hop — see the module header for why. `row_id` is derived
 * from the page number and a hash of the parameters, so it carries no query text into
 * the journal and still matches on resume.
 */
export function planSearch ({
  runId, endpoint, params, catalog, gates, cache,
  pages = 1, startPage = 1, pageSize = null, now = () => new Date().toISOString(),
}) {
  const def = catalogEntry(catalog, endpoint);
  if (!def) throw new RunError(`"${endpoint}" is not in the catalog — run: node bin/richapi-catalog-gen.mjs`);

  const count = Math.max(1, Number(pages) || 1);
  const first = Number.isFinite(Number(startPage)) ? Number(startPage) : 1;
  const pageNumbers = Array.from({ length: count }, (_, i) => first + i);
  const qhash = sha(JSON.stringify(canonical({ endpoint, ...params }))).slice(0, 12);

  // The request's own per-page bound beats the gates.yaml assumption, for the reason
  // spelled out over `requestBound`: `--param limit=1000 --pages 1` on a 0.1cr/result
  // endpoint is a 100-credit call that used to plan at 2.5. An explicit `--page-size`
  // still wins over both — it is the caller overriding their own request.
  // `--page-size` is only a number the caller can HOLD the server to when the endpoint
  // declares a field for it. When it does, it goes on the wire (it used to be priced
  // and never sent). When it does not, it is neither sent nor priced — pricing a wish
  // is exactly how `lead_search --page-size 10` planned 15 and was billed 22.5.
  const psField = pageSizeFieldFor(def, gates, endpoint);
  const asked = pageSize === null || pageSize === undefined ? null : Number(pageSize);
  const sent = psField && asked !== null ? { [psField]: asked } : {};
  const notes = [];
  if (asked !== null && !psField) {
    notes.push(`${endpoint} declares no page-size request field (spec request properties: `
      + `${(def.request_fields ?? []).join(', ') || 'none'}), so --page-size ${asked} CANNOT be sent: `
      + 'how many results a page returns is the server\'s choice, and this plan prices your '
      + `${asked} as an expectation, not a bound. Live 2026-09-17: --page-size 10 here planned 15 `
      + 'credits and the API answered 25 and billed 22.5. The walk re-prices itself from the '
      + 'first page the API actually answers, and stops if that page is materially bigger '
      + 'than this plan.');
  }

  const probe = buildRequestFor(endpoint, {}, catalog, { params: { ...params, ...sent, page: first }, gates });
  const bound = probe.ok ? requestBound(endpoint, probe.payload, gates) : null;
  const perPage = asked ?? bound ?? assumedResultsPerPage(gates);
  // Where the number came from, so the plan can say "this is an assumption" out loud
  // rather than printing an assumption as though it were a fact. Live 2026-09-17:
  // linkedin_company_search answers 50 rows a page against the assumed 25, so the plan
  // was HALF the real bill and nothing in it said the 25 was a guess.
  const perPageBasis = asked !== null ? (psField ? 'explicit' : 'server_choice')
    : bound !== null ? 'request'
    : 'assumption';

  const expected = expectedResultsFor(def, gates, perPage);
  // Every page after the first is CONDITIONAL: a search may exhaust early, so the plan
  // total is a stated ceiling rather than a promise.
  const waterfall = [{ endpoint, expected_results: expected }];

  const clamps = [];
  const prepared = pageNumbers.map((page, i) => {
    const merged = { ...params, ...sent, page };
    const req = buildRequestFor(endpoint, {}, catalog, { params: merged, gates });
    if (req.clamped && i === 0) clamps.push(req.clamped);   // one note, not one per page
    const row_id = `p${String(page).padStart(5, '0')}-${qhash}`;
    const cached = req.ok && cache.enabled && cache.has(endpoint, req.payload);
    return {
      row_id,
      page,
      record: merged,
      request: req.ok ? req.payload : null,
      skipReason: req.ok ? null : req.reason,
      descriptor: { row_id, has: req.ok ? [] : ['done'], suppressed: false, cached: cached ? [endpoint] : [] },
      cachedBody: cached ? cache.get(endpoint, req.payload) : null,
      conditional: i > 0,
    };
  });

  const plan = buildPlan({
    runId, rows: prepared.map((p) => p.descriptor), waterfall, catalog, now,
  });
  // buildPlan marks conditionality per HOP; with pages as rows there is one hop, so the
  // ceiling flag is set here instead of being silently dropped. The floor is the first
  // page that is actually planned as a call — a search always buys at least that one.
  if (count > 1) {
    plan.totals.estimate_is_ceiling = true;
    const firstCall = plan.rows.find((r) => r.hops.some((h) => h.action === 'call'));
    const floor = firstCall?.credits_estimated ?? 0;
    plan.totals.credits_estimated_floor = floor;
    // Keep the "if every call misses" arithmetic on the SAME basis as the floor. A
    // search models pages as rows on one unconditional hop, so conditionalEconomics
    // counted every page as unconditional and printed a floor and a miss-cost that
    // contradicted each other on the same screen.
    const ce = plan.conditional_economics;
    if (ce) {
      ce.credits_if_every_call_misses = floor;
      ce.calls_billed_on_miss = Math.min(1, ce.calls_billed_on_miss);
      ce.credits_conditional_if_fired_and_missed = plan.totals.credits_estimated - floor;
      ce.calls_conditional = Math.max(0, count - 1);
    }
  }
  plan.totals.page_size = perPage;
  plan.totals.page_size_basis = perPageBasis;
  plan.totals.page_size_field = psField;
  return {
    plan, prepared, waterfall, pages: pageNumbers, expected: perPage, clamps, notes,
    pageSizeBasis: perPageBasis, pageSizeField: psField,
  };
}

// ---------------------------------------------------------------------------
// The execution client
// ---------------------------------------------------------------------------

/**
 * How much bigger than the planned page the API may answer before the walk stops.
 *
 * FAIL CLOSED (law 5): a missing key is not "no gate", it is zero tolerance.
 */
export function overdeliveryTolerance (gates) {
  try {
    const pct = Number(gateValue(gates, 'unbounded_endpoints.page_size_overdelivery_tolerance_pct'));
    return Number.isFinite(pct) && pct >= 0 ? pct / 100 : 0;
  } catch { return 0; }
}

/** A page delivered materially more than the plan priced. */
export function overdelivered (planned, delivered, tolerance) {
  if (!Number.isFinite(planned) || planned <= 0) return false;
  if (!Number.isFinite(delivered) || delivered <= 0) return false;
  return delivered > planned * (1 + tolerance);
}

/** A page that came back shorter than the size in force. Used only to explain, never to decide. */
function heuristicallyShort (rows, size) {
  return Array.isArray(rows) && Number.isFinite(size) && size > 0 && rows.length < size;
}

/** Rows a paged response carried, or null when we could not read one. */
// Where the recorded search responses keep their rows. `content` is a paged answer
// (people_search, post_activities, post_keyword_search, profile_activities); the
// scrapers nest theirs one level down under `data` (search_bing and youtube_search
// `data.results`, directory_yellowpages `data.businesses`, youtube_channel_videos
// `data.videos`). tests/run-surface/result-rows.test.mjs replays every recording.
const ROW_KEYS = ['elements', 'content', 'results', 'data', 'items', 'profiles', 'companies', 'businesses', 'videos'];

/**
 * A row's stable identity, when it has one. Pages of a live search OVERLAP — the
 * 2026-09-17 post_activities run returned 3 of page 0's 10 comments again on page 1 —
 * so a paged output is deduplicated on this. No id, no dedupe: a row we cannot
 * identify is kept rather than guessed equal to another.
 */
export function pageRowId (row) {
  if (!row || typeof row !== 'object') return null;
  for (const v of [row.id, row.urn, row.entityUrn, row.commenter?.entityUrn]) {
    if ((typeof v === 'string' && v.trim() !== '') || typeof v === 'number') return String(v);
  }
  return null;
}

/** Rows across pages, first occurrence kept. Returns { rows, duplicates }. */
export function dedupePageRows (rows) {
  const seen = new Set();
  const out = [];
  let duplicates = 0;
  for (const r of rows) {
    const id = pageRowId(r);
    if (id !== null) {
      if (seen.has(id)) { duplicates += 1; continue; }
      seen.add(id);
    }
    out.push(r);
  }
  return { rows: out, duplicates };
}

/**
 * The total a page claims. It MOVES between calls (live: 16, then something else), so
 * it is reported as the last one seen, never trusted as a stable denominator.
 */
export function readReportedTotal (body) {
  if (!body || typeof body !== 'object') return null;
  for (const v of [
    body.totalElements, body.pagination?.totalElements,
    body.total_results, body.total, body.data?.total_results, body.data?.total,
  ]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// What the response itself says about paging
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS CLOSES. "The search is exhausted" was decided by comparing the rows
// returned against an ASSUMED page size — `gates.yaml:unbounded_endpoints
// .assumed_results_per_page`, 25 — and every recorded search response carries the real
// answer. Measured on 2026-09-17:
//
//   post_activities                     page 0: 10 rows, `totalPages: 2, last: false`
//                                       -> the runtime declared it exhausted and
//                                          never bought page 1.
//   linkedin_company_employees_search   page 1: 3 rows, page 2: 10 rows
//                                       -> a short page is not the end of a walk.
//
// TWO SHAPES, both read off the recordings in tests/fixtures/live/ (law 2 — nothing
// here is a key the spec merely promises):
//
//   Spring page   people_search, post_activities, post_keyword_search, profile_activities
//                 { content: [...], number, size, numberOfElements, totalPages,
//                   totalElements, last, first, empty }      `number` is ZERO-BASED
//   `pagination`  lead_search, profile_search, linkedin_company_search,
//                 linkedin_company_employees_search, linkedin_job_search, linkedin_ad_search
//                 { elements: [...], pagination: { pageNumber, pageSize, totalPages,
//                   totalElements, previousElements, totalResultCount? } }
//                                                             `pageNumber` is ONE-BASED
//
// Every field is optional: linkedin_ad_search answers `{pageSize: 24, totalPages: null,
// pageNumber: null}`, so the reader must degrade to "says nothing" rather than to a
// wrong number.

/** Finite number, or null. `null` and `"3"` both have to be handled here. */
function fin (v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The paging metadata a response carries, normalised. Fields the response does not
 * carry come back null — never guessed, never defaulted.
 *
 * `page_number` is normalised to the response's OWN convention plus `zero_based`, so a
 * caller can compare it to `total_pages` without knowing which shape answered.
 */
export function readPageMeta (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const p = body.pagination && typeof body.pagination === 'object' ? body.pagination : null;

  if (p) {
    return {
      source: 'pagination',
      zero_based: false,
      page_number: fin(p.pageNumber),
      page_size: fin(p.pageSize),
      total_pages: fin(p.totalPages),
      total_elements: fin(p.totalElements),
      returned_on_page: null,
      last: null,
    };
  }
  // The Spring page shape. `number` is 0 on the first page, so a bare truthiness test
  // on it is wrong; `fin` keeps the zero.
  const looksSpring = ['number', 'totalPages', 'numberOfElements', 'last', 'size']
    .some((k) => Object.hasOwn(body, k));
  if (!looksSpring) return null;
  return {
    source: 'spring_page',
    zero_based: true,
    page_number: fin(body.number),
    page_size: fin(body.size),
    total_pages: fin(body.totalPages),
    total_elements: fin(body.totalElements),
    returned_on_page: fin(body.numberOfElements),
    last: typeof body.last === 'boolean' ? body.last : null,
  };
}

/**
 * Is the walk over? Decided from what the response REPORTS, and only from the
 * short-page heuristic when it reports nothing.
 *
 * Returns { exhausted, basis, reason }. `basis` names which evidence decided it, so a
 * run can print "the API said so" rather than "we guessed".
 *
 * The one thing it will never do is claim exhaustion against the response: `last:
 * false`, or a page number below the last page, ends the question.
 */
export function pageExhausted ({ meta, rows, pageSize = null }) {
  const n = Array.isArray(rows) ? rows.length : null;

  if (meta) {
    if (meta.last === true) return { exhausted: true, basis: 'response.last', reason: 'the response reports last: true' };
    if (meta.total_pages !== null && meta.page_number !== null) {
      // Spring counts pages from 0, `pagination` from 1. Normalise both to "how many
      // pages have been walked including this one".
      const walked = meta.zero_based ? meta.page_number + 1 : meta.page_number;
      if (walked >= meta.total_pages) {
        return {
          exhausted: true,
          basis: 'response.total_pages',
          reason: `the response reports page ${walked} of ${meta.total_pages}`,
        };
      }
      return {
        exhausted: false,
        basis: 'response.total_pages',
        reason: `the response reports page ${walked} of ${meta.total_pages} — more pages remain`,
      };
    }
    if (meta.last === false) {
      return { exhausted: false, basis: 'response.last', reason: 'the response reports last: false' };
    }
  }

  // Nothing readable in the response. An EMPTY page is the one thing a short page
  // certainly means, whatever the assumed size was.
  if (n === 0) return { exhausted: true, basis: 'empty_page', reason: 'the page came back empty' };
  if (pageSize && n !== null && n < pageSize) {
    return {
      exhausted: true,
      basis: 'short_page_heuristic',
      reason: `${n} of a possible ${pageSize} row(s) came back and the response carries no paging `
        + 'metadata — treated as exhausted on the short-page heuristic, which is an ASSUMPTION',
    };
  }
  return { exhausted: false, basis: n === null ? 'unreadable' : 'full_page', reason: 'no evidence the walk is over' };
}

// ---------------------------------------------------------------------------
// Search rows -> columns `enrich` can read
// ---------------------------------------------------------------------------
//
// THE DEFECT. A search wrote rows out with the API's own nested camelCase keys
// (`linkedinUrl`, `commenter.entityUrn`, `firstname`), while `richapi enrich` reads
// `linkedin_url`, `urn`, `first_name`. So every one of the 2026-09-17 runs hand-mapped
// the search output before it could be enriched — the two halves of the pack did not
// join up.
//
// EVERY KEY BELOW IS READ OFF A RECORDING in tests/fixtures/live/ (law 2). Nothing is
// taken from the spec, and nothing is invented:
//
//   people_search.content[]                url, firstname, lastname, entityUrn, headline
//   lead_search.elements[]                 id, linkedinUrl, firstName, lastName,
//                                          currentPositions[0].{title,companyName}
//   profile_search.elements[]              id, name, position, linkedinUrl
//   linkedin_company_employees_search[]    id, name, position, linkedinUrl
//   linkedin_company_search.elements[]     id, name, linkedinUrl, universalName, industry
//   post_activities.content[]              id, url, commenter.{firstName,lastName,
//                                          entityUrn,headline}
//   post_keyword_search.content[]          urn, actor.{name,url}
//
// `source_url` carries any URL on the row that is NOT a person profile — the comment
// permalink `post_activities` answers, a company page, a post. See `normalisePageRow`.
//
// `company_domain` is deliberately ABSENT: no search recording carries a domain or a
// website field anywhere, so there is no key to read and inventing one is exactly what
// law 2 forbids. tests/run-surface/search-normalise.test.mjs replays the recordings.

/** One level of the obvious person/company container, flattened onto the row. */
const ROW_CONTAINERS = ['commenter', 'actor', 'profile', 'person', 'company'];

/**
 * A LinkedIn PERSON profile URL — `/in/<handle>`, and nothing else.
 *
 * Deliberately narrow. `/feed/update/...`, `/company/...`, `/posts/...` and a bare
 * comment permalink are all LinkedIn URLs and none of them is a person.
 */
export function isPersonProfileUrl (v) {
  if (typeof v !== 'string') return false;
  return /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/in\/[^/?#\s]+/i.test(v.trim());
}

/** First recorded spelling that carries a value. */
function pick (row, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), row);
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

/**
 * Add the identifier columns the pack already uses, keeping the raw row exactly as it
 * is today. An existing key is never overwritten: the API's own value wins over ours.
 */
export function normalisePageRow (row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;

  // One level of flattening, for the rows that nest the person inside the row.
  const flat = { ...row };
  for (const c of ROW_CONTAINERS) {
    const inner = row[c];
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    for (const [k, v] of Object.entries(inner)) if (!(k in flat)) flat[k] = v;
  }
  const pos = Array.isArray(row.currentPositions) ? row.currentPositions[0] : null;

  // THE COMMENT PERMALINK. `post_activities` rows carry `url` = the comment's own
  // permalink (`/feed/update/urn:li:ugcPost:...?commentUrn=...`) and the PERSON under
  // `commenter.entityUrn` — read off the 2026-09-17 live run. Mapping that `url` into
  // `linkedin_url` put a post permalink into the column every enrichment hop treats as
  // a person profile, and the hop was then billed against it.
  //
  // So `linkedin_url` is derived ONLY from a value that is a person profile URL. Any
  // other URL the row carries is still kept — under `source_url`, a name no hop reads
  // as an identifier.
  const urls = [pick(flat, 'linkedinUrl'), pick(flat, 'url'), pick(flat, 'shareUrl')].filter(Boolean);
  const profileUrl = urls.find(isPersonProfileUrl) ?? null;
  const otherUrl = urls.find((u) => u !== profileUrl) ?? null;

  const derived = {
    linkedin_url: profileUrl,
    source_url: otherUrl,
    urn: pick(flat, 'entityUrn', 'urn', 'id', 'objectUrn'),
    first_name: pick(flat, 'firstName', 'firstname'),
    last_name: pick(flat, 'lastName', 'lastname'),
    title: pick(flat, 'position', 'headline') ?? (pos ? pick(pos, 'title') : null),
    company_name: pos ? pick(pos, 'companyName') : null,
  };

  const out = { ...row };
  for (const [k, v] of Object.entries(derived)) {
    if (v !== null && !present(out[k])) out[k] = v;
  }
  return out;
}

export function readResultRows (body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return null;
  for (const k of ROW_KEYS) {
    if (Array.isArray(body[k])) return body[k];
  }
  const data = body.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const k of ROW_KEYS) {
      if (Array.isArray(data[k])) return data[k];
    }
  }
  return null;
}

/**
 * Adapts RichApiClient to `runWaterfall`'s call contract.
 *
 * The executor never sees a contact record: payloads are computed at PLAN time and
 * looked up here by row_id, so nothing contact-shaped reaches the journal.
 *
 * Every call writes a ledger line, including a failure — "we tried and were charged
 * nothing" is itself an accounting fact, and a timeout we cannot verify must not be
 * recorded as free.
 */
export function createCallClient ({
  api, catalog, endpoint, ledger, session, requests, results, cache,
  dir, runId, audit, notes = [], expected = null, mode = 'rows',
  pageSize = null, stopOnShortPage = true, bulk = null, recordOf = () => ({}),
  gates = null,
}) {
  const entry = catalogEntry(catalog, endpoint);
  const state = {
    exhausted: false, exhausted_at: null, exhausted_basis: null, pages_empty: 0,
    last_call_credits: 0, last_reported_total: null,
    // The page size the API ITSELF reported on the last page of this run. Once a page
    // has answered, this beats the gates.yaml assumption for every page after it —
    // linkedin_company_search answers 50 to an assumed 25, so the forward estimate
    // (and therefore the session-budget cap) was half the real bill.
    observed_page_size: null,
    page_size_basis: pageSize ? 'plan' : 'assumption',
  };

  /** Results per call, best evidence first: what a page reported, then the plan's. */
  const perPageNow = () => state.observed_page_size ?? pageSize ?? expected;
  /** The size the PLAN priced, which never moves — the yardstick over-delivery is measured against. */
  const planned0 = pageSize ?? expected;
  const tolerance = overdeliveryTolerance(gates);
  const priceEstimate = (count) => estimateCost(entry, { resultCount: count ?? perPageNow() });

  const persist = (rowId, fields) => {
    if (dir && runId && fields && Object.keys(fields).length) appendResult(dir, runId, rowId, endpoint, fields);
  };

  const client = {
    state,

    /**
     * THE RUNTIME CAP. Asked before every call; never asks the user anything.
     *
     * `checkCall` — and therefore `checkSessionSpend` — was reachable from exactly two
     * places, both pre-execution (`gatePlanFor`, and `gatePlan` in enrich.mjs). During
     * execution spend was only ever ACCUMULATED: `recordSpend(session, ...)` wrote
     * `session.spent_credits` and nothing on earth read it back. The session budget was
     * a check on an ESTIMATE, and the only thing that stopped a runaway was the vendor
     * returning 402.
     *
     * Measured: `richapi search lead_search --param title=CTO --pages 20 --budget 500`
     * plans at 450 credits on `assumed_results_per_page: 25`. Pages that return 500
     * results each cost 20 x (10 + 250) = 5,200 — 10.4x the budget the user set, with
     * every gate green.
     *
     * TWO THINGS MAKE THE CAP BIND rather than merely exist:
     *
     *   1. It reads `session.spent_credits`, which is the REAL running total — the
     *      ledger's `credits_actual` where the response carried a billing field, its
     *      estimate where it did not.
     *   2. The forward estimate is the larger of the plan's per-call price and what the
     *      LAST call actually cost. On the measured run the plan says 22.5 and page one
     *      costs 260; without (2) the cap would let nineteen more 260s through under a
     *      22.5-credit forecast, which is the same blindness one level down.
     *
     * Returns null when there is nothing to enforce: no budget was set, so there is no
     * number to cap against and the plan gate already asked for one.
     */
    checkBudget ({ units = null } = {}) {
      const budget = session?.budget_credits;
      if (budget === null || budget === undefined) return null;

      const forward = units && bulk?.bulk_variant
        ? estimateCost(catalogEntry(catalog, bulk.bulk_variant), { resultCount: units.length }).credits
        : Math.max(priceEstimate(null).credits ?? 0, state.last_call_credits ?? 0);

      const d = checkSessionSpend(session, forward ?? 0);
      if (d.decision !== STOP) return null;
      return {
        decision: STOP,
        gate: d.gate,
        estimate: forward,
        spent: session.spent_credits,
        budget,
        reason: `session budget reached BEFORE this call, not after it: ${session.spent_credits} of `
          + `${budget} credits already spent and the next ${endpoint} call is estimated at ${forward}, `
          + `which would take the run to ${session.spent_credits + forward}. Stopped.`,
      };
    },

    async call ({ endpoint: ep, row_id, hop }) {
      if (state.exhausted) {
        // No HTTP call, no charge, no ledger line. A named machine code, not free text:
        // journal.errorCode requires a SAFE_TOKEN, and the resume planner reads it back
        // to avoid re-buying a page the search already proved empty.
        const e = new Error(`search exhausted at page ${state.exhausted_at}`);
        e.code = 'search_exhausted';
        throw e;
      }
      const payload = requests.get(row_id);
      if (!payload) {
        const e = new Error(`no usable request payload for ${row_id}`);
        e.code = 'input_insufficient';
        throw e;
      }

      let res;
      try {
        res = await api.post(ep, payload);
      } catch (err) {
        if (err instanceof HttpError && err.status === 402) {
          ledger.recordInsufficientCredits({ endpoint: ep, body: err.body ?? {}, catalogEntry: entry });
        } else if (err instanceof HttpError) {
          // EVERY attempted call reaches the ledger, status 0 included. A timeout the
          // API may well have billed must not be recorded as zero spend and then
          // re-paid on resume.
          const est = priceEstimate(null);
          ledger.record({
            endpoint: ep, catalogEntry: entry,
            estimatedCredits: est.credits, estimateBasis: est.basis,
            rowId: row_id, hop, responseBody: err.body, httpStatus: err.status ?? 0,
          });
        }
        noteRemediation(notes, err);
        throw err;
      }

      const rows = readResultRows(res.body);
      const observed = rows ? rows.length : null;

      // A real estimate, never null and never zero. For the eleven endpoints whose
      // charge is never verifiable this is the only number that will ever exist.
      const est = priceEstimate(observed);
      const line = ledger.record({
        endpoint: ep,
        catalogEntry: entry,
        estimatedCredits: est.credits,
        estimateBasis: est.basis,
        rowId: row_id,
        hop,
        responseBody: res.body,
        httpStatus: res.status,
        ...(observed === null ? {} : { resultCount: observed }),
      });
      state.last_call_credits = line.credits_actual ?? line.credits_estimated ?? 0;
      recordSpend(session, state.last_call_credits);

      if (cache?.enabled) cache.put(ep, payload, res.body);

      const attribution = readAttribution(res.body);

      if (mode === 'pages') {
        const page = requests.get(row_id)?.page ?? null;
        const total = readReportedTotal(res.body);
        if (total !== null) state.last_reported_total = total;
        // What the API says about paging beats what we assumed about it.
        const meta = readPageMeta(res.body);
        if (meta?.page_size !== null && meta?.page_size !== undefined && meta.page_size > 0) {
          state.observed_page_size = meta.page_size;
          state.page_size_basis = 'response';
        }
        if (rows === null) {
          notes.push(`page ${page}: the response carried no readable result array — `
            + `keys: ${Object.keys(res.body ?? {}).join(', ') || 'none'}. Paid, unreadable.`);
        } else {
          const normalised = rows.map(normalisePageRow);
          results.set(row_id, { _results: normalised, _page: page, _count: rows.length });
          persist(row_id, { _results: normalised, _page: page, _count: rows.length });
          if (rows.length === 0) state.pages_empty += 1;
          // EXHAUSTION IS THE RESPONSE'S CALL, not the assumption's. `--all-pages`
          // (stopOnShortPage: false) still only overrides the HEURISTIC: when the API
          // states the walk is over, buying further pages would buy nothing.
          const verdict = pageExhausted({ meta, rows, pageSize: perPageNow() });
          const heuristic = verdict.basis === 'short_page_heuristic';
          if (verdict.exhausted && (stopOnShortPage || !heuristic)) {
            state.exhausted = true;
            state.exhausted_at = page;
            state.exhausted_basis = verdict.basis;
            notes.push(`page ${page}: ${verdict.reason} — the search is exhausted; no later page was bought.`
              + (total === null ? '' : ` Last total the API reported: ${total}.`));
          } else if (!state.exhausted && overdelivered(planned0, meta?.page_size ?? rows.length, tolerance)) {
            // THE BILL BEATS THE PLAN. Live 2026-09-17: `lead_search --page-size 10`
            // was approved at 15 credits and the first page answered 25 results, billed
            // at 22.5 — and the walk would have bought nineteen more of those under the
            // same approval. A page that delivers materially more than the plan priced
            // is a plan that is no longer the plan, so the walk STOPS and says so
            // rather than buying the rest at a price nobody approved.
            state.exhausted = true;
            state.exhausted_at = page;
            state.exhausted_basis = 'page_size_overdelivery';
            notes.push(`page ${page} delivered ${meta?.page_size ?? rows.length} result(s) against a planned `
              + `${planned0} (tolerance ${Math.round(tolerance * 100)}%, `
              + 'gates.yaml:unbounded_endpoints.page_size_overdelivery_tolerance_pct). The rest of the '
              + 'walk was NOT bought: it would have cost more than the plan you approved. Re-run with '
              + `--page-size ${meta?.page_size ?? rows.length} (or --pages) to price it honestly and approve it.`);
          } else if (!verdict.exhausted && heuristicallyShort(rows, perPageNow())) {
            // The case that lost pages: a SHORT page the API says is not the last one.
            notes.push(`page ${page} returned ${rows.length} of a possible ${perPageNow()}, but `
              + `${verdict.reason} — the walk continues.`);
          }
        }
        return {
          body: res.body,
          credits_actual: line.credits_actual,
          provider: attribution.provider,
          confidence: attribution.confidence,
        };
      }

      // Row mode: map the response onto output columns AND classify the mapping. A 2xx
      // whose body carries data but produces no column is a mapping failure (the empty-column tripwire), not
      // an empty result, and it is billable either way.
      const insp = audit.record(inspectDelivered(ep, res.body), { row_id, hop, billing: billingVerdict(res.body, res.status) });
      const fields = rowFields(ep, res.body, insp);
      const prior = results.get(row_id) ?? {};
      results.set(row_id, { ...prior, ...fields });
      persist(row_id, fields);

      return {
        body: res.body,
        mapping: { status: insp.status, columns: insp.column_count, is_mapping_failure: insp.is_mapping_failure },
        credits_actual: line.credits_actual,
        provider: attribution.provider,
        confidence: attribution.confidence,
      };
    },
  };

  if (!bulk?.batched) return client;

  // --- the batched path -----------------------------------------------------
  client.bulkEligible = ({ units }) => {
    const callable = units.filter((u) => !u.skip);
    const missing = callable.filter((u) => !bulkIdentifierFor(catalogEntry(catalog, bulk.bulk_variant), recordOf(u.row_id)).id);
    if (missing.length) {
      // Re-checked at execution time, not trusted from plan time: a resume re-plans a
      // different unit set and the answer can change.
      const reason = `${bulk.bulk_variant} needs \`urns\`, but ${missing.length} of ${callable.length} `
        + 'rows carry none. Falling back to single calls.';
      notes.push(reason);
      return { ok: false, reason };
    }
    return { ok: true, bulk: { endpoint: bulk.bulk_variant, maxBatch: bulk.max_batch, def: catalogEntry(catalog, bulk.bulk_variant) } };
  };

  client.callBulk = async ({ endpoint: bulkEndpoint, units }) => {
    const ids = units.map((u) => bulkIdentifierFor(catalogEntry(catalog, bulkEndpoint), recordOf(u.row_id)).id);
    const urns = ids.filter(Boolean);
    const req = buildRequestFor(bulkEndpoint, {}, catalog, { params: { urns }, gates });
    if (!req.ok) { const e = new Error(req.reason); e.code = 'input_insufficient'; throw e; }

    const bulkEntry = catalogEntry(catalog, bulkEndpoint);
    let res;
    try {
      res = await api.post(bulkEndpoint, req.payload);
    } catch (err) {
      if (err?.status === 402) ledger.recordInsufficientCredits({ endpoint: bulkEndpoint, body: err.body ?? {}, catalogEntry: bulkEntry });
      else if (err?.status !== undefined) {
        const e = estimateCost(bulkEntry, { resultCount: units.length });
        ledger.record({
          endpoint: bulkEndpoint, catalogEntry: bulkEntry,
          estimatedCredits: e.credits, estimateBasis: e.basis,
          responseBody: err.body, httpStatus: err.status ?? 0,
        });
      }
      noteRemediation(notes, err);
      throw err;
    }

    const rows = readResultRows(res.body);
    const count = rows ? rows.length : units.length;
    const est = estimateCost(bulkEntry, { resultCount: count });
    // ONE ledger line per bulk CALL with a result_count, so a per-result charge is
    // accounted correctly. The journal still carries one line per row.
    const line = ledger.record({
      endpoint: bulkEndpoint, catalogEntry: bulkEntry,
      estimatedCredits: est.credits, estimateBasis: est.basis,
      responseBody: res.body, httpStatus: res.status, resultCount: count,
    });
    recordSpend(session, line.credits_actual ?? line.credits_estimated ?? 0);

    const aligned = rows ? alignBulkRows(ids, rows) : null;
    if (aligned) {
      units.forEach((u, i) => {
        if (!aligned[i]) return;
        // The bulk elements carry the SINGLE endpoint's field names, so both the
        // response map and the cache key are the single endpoint's.
        const insp = audit.record(inspectDelivered(endpoint, aligned[i]), { row_id: u.row_id, hop: 'bulk', billing: billingVerdict(res.body, res.status) });
        const fields = rowFields(endpoint, aligned[i], insp);
        const prior = results.get(u.row_id) ?? {};
        results.set(u.row_id, { ...prior, ...fields });
        persist(u.row_id, fields);
        const payload = requests.get(u.row_id);
        if (cache?.enabled && payload) cache.put(endpoint, payload, aligned[i]);
      });
    }

    return {
      results: aligned,
      returned: rows ? rows.length : null,
      credits_per_row: bulkEntry?.pricing?.credits_per_result ?? null,
      credits_actual: line.credits_actual,
    };
  };

  return client;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/** Units the journal says this search already proved empty. Never re-bought. */
function dropExhausted (todo, lines) {
  const state = summarize(lines);
  const kept = [];
  let dropped = 0;
  for (const u of todo) {
    const prior = state.get(unitKey(u.row_id, u.hop));
    if (prior?.error === 'search_exhausted') { dropped += 1; continue; }
    kept.push(u);
  }
  return { todo: kept, dropped };
}

/**
 * Run (or plan, or resume) one gated endpoint call.
 *
 * `mode: 'rows'`  — N input rows through one endpoint. Auto-batches where allowed.
 * `mode: 'pages'` — one parameter set across N pages, page-gated per page.
 *
 * `confirm` is the approval callback. It is consulted only for a real run: a dry run
 * spends nothing and asks nothing.
 */
export async function runGated ({
  mode = 'rows',
  endpoint,
  input = null,
  rows = null,
  params = {},
  fields = [],
  pages = 1,
  startPage = 1,
  pageSize = null,
  expectedResults = null,
  stopOnShortPage = true,
  output = null,
  dir = 'gtm',
  root = process.cwd(),
  dryRun = false,
  noCache = false,
  resume = null,
  budget = null,
  api = null,
  catalog = null,
  gates = null,
  confirm = async () => false,
  now = () => new Date().toISOString(),
  runId = null,
  maxAttempts = 3,
  sleep = undefined,
} = {}) {
  if (!endpoint) throw new RunError('an endpoint is required');
  const cat = catalog ?? loadCatalog();
  const gateCfg = gates ?? loadGates();
  const gtmDir = path.resolve(root, dir);

  // Fail closed: no readable suppression store, no run. This throws.
  // The store follows --dir, or a run could use one project's suppression list with
  // another's state — the quiet version of emailing a suppressed contact.
  const store = loadSuppressionStore({ root, path: path.resolve(root, dir, 'suppression.jsonl') });

  const cache = createPayloadCache({ root, dir, enabled: !noCache });

  let records = [];
  if (mode === 'rows') {
    records = rows ?? (input ? readInputRows(path.resolve(root, input)) : [{}]);
    if (!records.length) throw new RunError(`input list is empty: ${input}`);
  }

  const listKey = input ? path.resolve(root, input) : `${endpoint}:${sha(JSON.stringify(canonical(params))).slice(0, 16)}`;
  // A run id becomes a file name and journal.runJournalPath caps it at 64 safe chars,
  // so the endpoint is a truncated slug rather than the full name — `search-` plus
  // `linkedin_company_employees_search` plus a timestamp already overruns it.
  const slug = String(endpoint).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 16);
  const id = resume ?? runId
    ?? `${mode === 'pages' ? 'srch' : 'call'}-${slug}-${Date.now().toString(36)}-${sha(listKey).slice(0, 6)}`;

  let planned;
  try {
    planned = mode === 'pages'
      ? planSearch({ runId: id, endpoint, params, catalog: cat, gates: gateCfg, cache, pages, startPage, pageSize, now })
      : planRowCall({ runId: id, endpoint, records, catalog: cat, gates: gateCfg, store, cache, params, fields, expectedResults, now });
  } catch (err) {
    if (err instanceof PlanContractError) throw err;
    throw err;
  }
  const { plan, prepared } = planned;
  // A fired clamp is REPORTED, never a silent rewrite of the caller's parameter.
  const clampNotes = [...(planned.clamps ?? []).map((c) => c.note), ...(planned.notes ?? [])];

  const byId = new Map(prepared.map((p) => [p.row_id, p.record]));
  const requests = new Map(prepared.filter((p) => p.request).map((p) => [p.row_id, p.request]));

  const session = createSession({ gates: gateCfg, runId: id });
  if (budget !== null) {
    const set = setBudget(session, budget);
    if (set.decision === STOP) throw new RunError(set.reason);
  }

  const skipReasons = {};
  for (const p of prepared) {
    if (!p.skipReason) continue;
    skipReasons[endpoint] ??= {};
    skipReasons[endpoint][p.skipReason] = (skipReasons[endpoint][p.skipReason] ?? 0) + 1;
  }

  const batch = mode === 'rows'
    ? planBatching({ catalog: cat, endpoint, gates: gateCfg, units: plan.units, recordOf: (rid) => byId.get(rid) ?? {} })
    : { endpoint, bulk_variant: null, batched: false, reason: 'a paged search is not batchable', rows_callable: 0, rows_with_identifier: 0, rows_without_identifier: 0, attribution: null };

  // ---- dry run: zero calls, by construction ----
  if (dryRun) {
    const journal = new RunJournal({ runId: id, dir: gtmDir });
    const written = writeDryRun({ plan, journal, dir: gtmDir });
    const gate = gatePlanFor({ plan, catalog: cat, session, pages: planned.pages });
    return {
      mode: 'dry-run', kind: mode, endpoint, run_id: id, plan, gate, batch: publicBatch(batch),
      journal_path: written.path,
      cache: { enabled: cache.enabled, ttl_source: cache.ttl_source ?? null, ...cache.stats },
      pending_written: written.pending_written,
      skipped_written: written.skipped_written,
      calls_made: 0,
      http_calls: 0,
      skip_reasons: skipReasons,
      pages: planned.pages,
      clamped: planned.clamps ?? [],
      notes: [...clampNotes],
      text: renderPlanText(plan),
    };
  }

  // ---- real run ----
  const gate = gatePlanFor({ plan, catalog: cat, session, pages: planned.pages });
  if (gate.blocked) {
    return {
      mode: 'blocked', kind: mode, endpoint, run_id: id, plan, gate, batch: publicBatch(batch),
      calls_made: 0, http_calls: 0, reasons: gate.stops.map((s) => s.reason), skip_reasons: skipReasons,
      clamped: planned.clamps ?? [], notes: [...clampNotes],
    };
  }
  if (gate.confirms.length) {
    const approved = await confirm({ plan, gate, batch });
    if (!approved) {
      return { mode: 'declined', kind: mode, endpoint, run_id: id, plan, gate, batch: publicBatch(batch), calls_made: 0, http_calls: 0, skip_reasons: skipReasons, clamped: planned.clamps ?? [], notes: [...clampNotes] };
    }
  }

  const lock = acquireListLock({ dir: gtmDir, listKey, runId: id });
  try {
    const journal = new RunJournal({ runId: id, dir: gtmDir });
    let units = plan.units;
    let resumeInfo = null;
    let exhaustedSkipped = 0;
    if (resume) {
      const { lines, corrupt } = readJournal(journal.path);
      resumeInfo = planResume({ lines, corrupt, units: plan.units, maxAttempts });
      const filtered = dropExhausted(resumeInfo.todo, lines);
      units = filtered.todo;
      exhaustedSkipped = filtered.dropped;
    }

    const ledger = new Ledger({ dir: gtmDir, runId: id });
    const apiClient = api ?? new RichApiClient();
    // Check the key BEFORE the run — but only when the run will actually call. Without
    // the up-front check MissingApiKey is thrown per call and caught as a unit failure,
    // so the user is told "300 units failed" rather than "set richapi_API_KEY". And
    // demanding a key for a run whose every unit is a cache hit would make the free
    // path the one that needs credentials.
    const willCall = units.some((u) => !u.skip);
    if (willCall && typeof apiClient.requireKey === 'function') apiClient.requireKey();

    // A resume MUST rebuild what earlier runs already bought, or the output file is
    // written without it and the credits are spent twice over.
    const results = resume ? loadResults(gtmDir, id) : new Map();
    // Seed from the cache, so a unit the plan showed as a cache hit still contributes
    // to the output rather than vanishing from it.
    for (const p of prepared) {
      if (!p.cachedBody) continue;
      if (mode === 'pages') {
        const rws = (readResultRows(p.cachedBody) ?? []).map(normalisePageRow);
        results.set(p.row_id, { _results: rws, _page: p.page, _count: rws.length, _cached: true });
      } else {
        const insp = inspectResponse(endpoint, p.cachedBody);
        results.set(p.row_id, { ...(results.get(p.row_id) ?? {}), ...rowFields(endpoint, p.cachedBody, insp) });
      }
    }

    const notes = [...clampNotes];
    const audit = createMappingAudit();
    const client = createCallClient({
      api: apiClient, catalog: cat, endpoint, ledger, session, requests, results, cache,
      dir: gtmDir, runId: id, audit, notes, expected: planned.expected, mode,
      pageSize: mode === 'pages' ? planned.expected : null, stopOnShortPage,
      bulk: batch, recordOf: (rid) => byId.get(rid) ?? {}, gates: gateCfg,
    });

    // PER-ROW fallback, not per-hop. batch.mjs's eligibility check is all-or-nothing
    // over a hop, so one row without a URN would send all five hundred as singles. The
    // rows that CAN batch are run as a batched group and the rest as single calls; both
    // journal identically, and the split is reported either way.
    let exec;
    if (batch.split === 'partial') {
      const batchable = units.filter((u) => u.skip || batch.eligible.has(u.row_id));
      const singles = units.filter((u) => !u.skip && !batch.eligible.has(u.row_id));
      const lone = { ...client };
      delete lone.callBulk;
      delete lone.bulkEligible;
      const a = await runHopMajor({ journal, units: batchable, client, catalog: cat, maxAttempts, ...(sleep ? { sleep } : {}) });
      let b = null;
      if (a.aborted) {
        // A 402 — or the session budget — in the batched group stops the run. The
        // single-call rows are journalled skipped_budget (REPLANNABLE), so a resume
        // after a top-up or a raise picks them all up.
        const token = a.abort_reason === 'session_budget' ? BUDGET_STOP : 'http_402';
        for (const u of singles) journal.appendResult(u, { status: 'skipped_budget', credits_actual: 0, error: token, attempt: 0 });
        b = { skipped_budget: singles.length };
      } else if (singles.length) {
        b = await runHopMajor({ journal, units: singles, client: lone, catalog: cat, maxAttempts, ...(sleep ? { sleep } : {}) });
      }
      exec = mergeExec(a, b);
    } else {
      exec = await runHopMajor({ journal, units, client, catalog: cat, maxAttempts, ...(sleep ? { sleep } : {}) });
    }

    // The cap's own line. `exec.abort_note` is set only when the session budget stopped
    // the run, so a 402 abort reads exactly as it did before.
    if (exec.abort_note) notes.push(exec.abort_note);

    // Pages overlap on the live API, so a paged result is deduplicated by stable id
    // before it is written or returned, and the drop is reported, not hidden.
    const pageRows = mode === 'pages'
      ? dedupePageRows(prepared.flatMap((p) => (results.get(p.row_id)?._results ?? [])))
      : { rows: null, duplicates: 0 };
    if (pageRows.duplicates) {
      notes.push(`${pageRows.duplicates} row(s) appeared on more than one page and were dropped as duplicates.`);
    }

    // Output goes through the suppression filter. There is no other writer.
    let outputInfo = null;
    if (output) {
      const outRows = mode === 'pages'
        ? pageRows.rows
        : prepared.filter((p) => !p.descriptor.suppressed)
          .map((p) => ({ ...p.record, ...(results.get(p.row_id) ?? {}) }));
      const flat = String(output).toLowerCase().endsWith('.csv')
        ? outRows.map(mode === 'pages' ? scalarsOnly : csvRow)
        : outRows;
      outputInfo = writeOutputList(path.resolve(root, output), flat, { root, store });
      // Visible, not silent: how many written rows carry a raw, un-normalised body.
      if (mode !== 'pages') {
        const dropped = new Set(outputInfo.dropped.map((d) => d.row));
        outputInfo.unmapped_rows = flat.filter((r, i) => !dropped.has(r) && outRows[i]?.response_mapped === false).length;
      }
    }

    // Terminal failures by code, read back from the journal. A page skipped because the
    // search was already exhausted is journalled `failed` for resume's sake; it is not
    // a failure anyone needs to hear about.
    const journalLines = readJournal(journal.path).lines;
    const failures = failureSummary(journalLines, { ignore: NOT_A_FAILURE });
    // Units that never reached the wire are SKIPPED, not failed. A verify step with no
    // email to verify was reported as `FAILED 1: input_insufficient` — an API error the
    // user would go and chase, beside a receipt that charged nothing for it.
    const skipped = skippedSummary(journalLines);

    const rec = reconcile({ plan, ledgerLines: ledger.lines });
    const mapping = audit.summary();
    const receipt = buildReceipt({
      ledger, gates: gateCfg, runLabel: id,
      balance: ledger.balance, balanceSource: ledger.balanceSource,
      mapping: mode === 'pages' ? null : mapping,
    });
    assertNeverOverstates(receipt, ledger);
    if (mode !== 'pages') assertMappingSurfaced(receipt, mapping);

    return {
      mode: resume ? 'resume' : 'run',
      kind: mode,
      endpoint,
      run_id: id,
      plan, gate, exec, batch: publicBatch(batch),
      resume: resumeInfo,
      resume_exhausted_skipped: exhaustedSkipped,
      journal_path: journal.path,
      ledger_path: ledger.path,
      ledger_totals: ledger.totals(),
      receipt,
      reconcile: rec,
      http_calls: apiClient.callCount ?? null,
      calls_made: exec.calls_made,
      failures,
      skipped_units: skipped,
      output: outputInfo,
      cache: { enabled: cache.enabled, ttl_source: cache.ttl_source ?? null, ...cache.stats },
      skip_reasons: skipReasons,
      notes,
      clamped: planned.clamps ?? [],
      budget_stop: exec.abort_reason === 'session_budget'
        ? { note: exec.abort_note ?? null, budget: session.budget_credits, spent: session.spent_credits }
        : null,
      pages: planned.pages,
      search: mode === 'pages'
        ? {
          ...client.state,
          // What the plan priced with, and what the API actually answered with.
          page_size: client.state.observed_page_size ?? planned.expected,
          planned_page_size: planned.expected,
          planned_page_size_basis: planned.pageSizeBasis ?? null,
          duplicates_dropped: pageRows.duplicates,
        }
        : null,
      mapping: mode === 'pages' ? null : mapping,
      unmapped_rows: outputInfo?.unmapped_rows ?? 0,
      mapping_issues: mode === 'pages' ? [] : audit.issues,
      results: mode === 'pages' ? pageRows.rows : null,
    };
  } finally {
    lock.release();
  }
}

/** The reportable form: a Set does not survive JSON.stringify. */
function publicBatch (b) {
  const { eligible, ...rest } = b;
  return { ...rest, rows_batchable: eligible ? eligible.size : 0 };
}

/** Sum two executor results. batch.mjs's own `merge` is not exported. */
function mergeExec (a, b) {
  if (!b) return a;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number' && typeof out[k] === 'number') out[k] += v;
    else if (typeof v === 'number' && out[k] === undefined) out[k] = v;
  }
  if (b.aborted) { out.aborted = true; out.abort_reason = b.abort_reason; out.balance = b.balance; }
  return out;
}

/** CSV cannot hold a nested object; JSONL can. Drop, never stringify to [object Object]. */
/**
 * The fields one paid response contributes to its output row.
 *
 * The body ALWAYS rides along as `response`, so nothing paid is ever lost. Law 2 forbids
 * inventing map keys, not passing the body through: an endpoint with no RESPONSE_MAPS
 * entry used to write only the input columns (CSV) or `{}` (JSONL) — live run
 * 2026-09-17, website_intelligence, web_scrape, profile_social_metrics and others.
 * `response_mapped: false` tells the reader the body is raw, not normalised columns.
 */
export function rowFields (endpoint, body, insp) {
  return { ...insp.columns, response: body ?? null, response_mapped: Object.hasOwn(RESPONSE_MAPS, endpoint) };
}

/** The mapping audit's text for a no-map response, now that the body is delivered. */
function inspectDelivered (endpoint, body) {
  const insp = inspectResponse(endpoint, body);
  if (insp.status === MAP_NO_MAP) {
    insp.reason = `no RESPONSE_MAPS entry for "${endpoint}": the body was delivered raw in the `
      + '`response` field (CSV: `response_json`), marked response_mapped: false — no normalised columns';
  }
  return insp;
}

/**
 * CSV cannot hold the body as an object, so an unmapped row carries it as
 * `response_json`. The object goes to the writer and is stringified there, AFTER the
 * suppression scan has walked it — a JSON string would hide a nested address.
 */
function csvRow (row) {
  const out = scalarsOnly(row);
  if (row?.response_mapped === false) out.response_json = row.response;
  return out;
}

function scalarsOnly (row) {
  const out = {};
  for (const [k, v] of Object.entries(row ?? {})) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v) || typeof v === 'object') continue;
    out[k] = v;
  }
  return out;
}

export async function runCall (opts = {}) { return runGated({ ...opts, mode: 'rows' }); }
export async function runSearch (opts = {}) { return runGated({ ...opts, mode: 'pages' }); }

// ---------------------------------------------------------------------------
// Rendering — lives here so the CLI stays a thin wrapper
// ---------------------------------------------------------------------------

/** The batching decision, always printed. Silence is how a 50x penalty hides. */
export function renderBatch (b) {
  if (!b || !b.bulk_variant) return null;
  return b.batched
    ? `batching   ${b.endpoint} -> ${b.bulk_variant}: ${b.reason}`
    : `batching   OFF for ${b.endpoint}: ${b.reason}`;
}

export function renderRunText (res, { renderReceiptText = null } = {}) {
  const L = [];
  L.push(`run ${res.run_id}  (${res.mode}, ${res.kind === 'pages' ? 'paged search' : 'row call'} on ${res.endpoint})`);
  L.push('');

  if (res.mode === 'dry-run') {
    L.push(res.text);
    L.push('');
    if (res.cache?.enabled && res.plan.totals.skipped_cache > 0) {
      L.push(`${res.plan.totals.skipped_cache} call(s) already cached — shown above as skipped, not charged.`);
    }
    const b = renderBatch(res.batch);
    if (b) L.push(b);
    L.push(`ZERO calls made. Journal: ${res.journal_path}`);
    L.push(`  ${res.pending_written} unit(s) planned, ${res.skipped_written} written terminal (suppressed or cached).`);
  } else if (res.mode === 'blocked') {
    L.push('BLOCKED before any call:');
    for (const r of res.reasons) L.push(`  - ${r}`);
  } else if (res.mode === 'declined') {
    L.push('Plan not approved. Nothing was spent.');
  } else {
    const e = res.exec;
    L.push(`http calls      ${res.http_calls ?? '?'}`);
    L.push(`units attempted ${e.attempted ?? e.calls_made}   (ok ${e.ok}, failed ${e.failed}, retries ${e.retries})`);
    L.push(`skipped         cache ${e.skipped_cache}, suppressed ${e.skipped_suppressed}, budget ${e.skipped_budget}`);
    L.push(...renderFailures(res.failures));
    L.push(...renderSkipped(res.skipped_units));
    if (e.batched_calls) L.push(`batched         ${e.batched_calls} call(s) covering ${e.batched_rows} row(s)${e.unaligned_batches ? `, ${e.unaligned_batches} UNALIGNED (failed, not mis-attributed)` : ''}`);
    if (e.aborted) L.push(`ABORTED: ${e.abort_reason}${e.balance !== null ? ` (balance ${e.balance})` : ''}`);

    const t = res.ledger_totals ?? {};
    L.push('');
    L.push(`credits verified  ${t.credits_actual ?? 0}   (${t.verified_lines ?? 0} call(s) whose charge the response confirmed)`);
    if (t.unverifiable_lines) {
      L.push(`credits estimated ${t.credits_estimated_unverifiable ?? 0}   (${t.unverifiable_lines} call(s) UNVERIFIABLE — the response carries no billing field)`);
    }
    L.push(`ledger total      ${t.ledger_total ?? 0}`);

    const c = res.cache;
    if (c) {
      L.push(c.enabled
        ? `cache             ${c.hits ?? 0} hit, ${c.writes ?? 0} written, ${c.expired ?? 0} expired  (TTLs from ${c.ttl_source ?? 'defaults'})`
        : 'cache             disabled (--no-cache): everything was re-paid');
    }
    const b = renderBatch(res.batch);
    if (b) L.push(b);
    L.push(`journal  ${res.journal_path}`);
    L.push(`ledger   ${res.ledger_path}`);
    if (res.output) L.push(`output   ${res.output.file}  (${res.output.written} rows, ${res.output.suppressed} suppressed)`);

    if (res.search) {
      L.push('');
      L.push(`pages    ${res.pages.length} planned, ${res.search.pages_empty} empty`
        + (res.search.exhausted
          ? `, exhausted at page ${res.search.exhausted_at} per ${res.search.exhausted_basis} (no later page was bought)`
          : ''));
      L.push(`pagesize ${res.search.page_size} `
        + (res.search.page_size_basis === 'response'
          ? '(reported by the API)'
          : `(${res.search.planned_page_size_basis ?? 'assumption'} — the API reported none)`));
      L.push(`rows     ${res.results?.length ?? 0} unique`
        + (res.search.duplicates_dropped ? `, ${res.search.duplicates_dropped} duplicate(s) across pages dropped` : '')
        + (res.search.last_reported_total !== null && res.search.last_reported_total !== undefined
          ? `; API reported total ${res.search.last_reported_total} (last seen — it moves between calls)` : ''));
    }
    if (res.resume) {
      const s = res.resume.stats;
      L.push('');
      L.push(`resumed: ${s.units_done} unit(s) already done, ${s.units_todo} paid for this time`);
      if (res.resume_exhausted_skipped) L.push(`  ${res.resume_exhausted_skipped} page(s) skipped: an earlier run proved the search exhausted there`);
      if (s.suspect_max_double_charge_rows > 0) {
        L.push(`  note: at most ${s.suspect_max_double_charge_rows} unit(s) may have been charged twice (killed mid-call)`);
      }
    }
    if (res.receipt && renderReceiptText) {
      L.push('');
      L.push('--- receipt ---');
      L.push(renderReceiptText(res.receipt));
    }
  }

  for (const n of res.notes ?? []) L.push(`  ! ${n}`);

  const skips = res.skip_reasons ?? {};
  if (Object.keys(skips).length) {
    L.push('');
    L.push('units not attempted:');
    for (const [ep, reasons] of Object.entries(skips)) {
      for (const [reason, n] of Object.entries(reasons)) L.push(`  ${ep.padEnd(16)} ${String(n).padStart(5)}  ${reason}`);
    }
  }
  if (res.plan?.totals?.credits_unknown_calls) {
    L.push('');
    L.push(`${res.plan.totals.credits_unknown_calls} call(s) have no known cost in the catalog and were not priced.`);
  }
  return L.join('\n');
}

/** Failed units, by code. Empty when nothing failed; never silent when something did. */
export function renderFailures (failures) {
  const entries = Object.entries(failures ?? {});
  if (!entries.length) return [];
  const n = entries.reduce((a, [, c]) => a + c, 0);
  return [`FAILED          ${n} unit(s): ${entries.map(([k, c]) => `${k} x${c}`).join(', ')}`
    + '  — nothing was charged for them; --resume retries exactly these.'];
}

/**
 * Units that never reached the wire. Printed as SKIPPED, because that is what they are:
 * a verify step with no email to verify is not an API failure and retrying it would do
 * the same thing.
 */
export function renderSkipped (skipped) {
  const entries = Object.entries(skipped ?? {});
  if (!entries.length) return [];
  const n = entries.reduce((a, [, c]) => a + c, 0);
  return [`SKIPPED         ${n} unit(s): ${entries.map(([k, c]) => `${k} x${c}`).join(', ')}`
    + '  — never reached the API, never charged, and not a failure.'];
}

export { MissingApiKey, PlanContractError };
