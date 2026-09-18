// Turn a parsed OpenAPI document into catalog endpoint rows conforming to
// _lib/contracts/api-catalog.schema.json.
//
// LAW (CLAUDE.md #2): the spec is a COST-AND-ROUTE source, not a schema source.
// 39 of 68 response examples are >=40% the literal string "example" and both bulk
// enrich endpoints have no example at all. Nothing in this file may derive a
// `field_map` from a spec example. `field_map` is always null here; the live fixture
// capture (live-maps.mjs) supplies real ones from recorded responses.
//
// WHAT LAW 2 IS ABOUT, EXACTLY (clarified 2026-08-30):
//
//   The law is about VALUES. `"firstname": "example"` tells you nothing about the
//   value — that is the whole point of the 39-of-68 measurement. It does not follow
//   that the KEY is fiction. The keys are the names the API answers with, and they are
//   independently corroborated: for 64 of the 65 endpoints that declare a non-empty
//   200 example, the example's top-level key set is IDENTICAL to the `output_schema`
//   recorded in the server's own generated endpoint manifest, which is built from the
//   server's endpoint configuration rather than from this spec. Two
//   artefacts produced by different pipelines agreeing on 64 key sets is evidence
//   (law 6), not a spec example being trusted for what it cannot support.
//
//   So this file now emits `field_map_keys`: the top-level key NAMES, and nothing else.
//   It is deliberately a DIFFERENT TYPE from `field_map` — an array, not an object — so
//   no consumer can mistake a key list for a mapping. What it does NOT tell you:
//
//     * nested shape. `education`, `experience`, `skills`, `languages`,
//       `certifications`, `techStack`, `specialties` are empty arrays in the example
//       AND in the backend manifest. Their element shape is unknown.
//     * types, units, nullability, or which key means what.
//     * whether a key is always present or only sometimes.
//
//   Recording live fixtures is therefore still required, for exactly the part a key
//   set cannot supply. Key names shrink that job; they do not close it.
//
// One endpoint is a known disagreement and is called out here rather than smoothed
// over: `find_personal_email` declares `{data, id, status}` in the spec (an async job
// envelope) while the backend manifest records `{first_personal_email, message}` (the
// resolved payload). Its `field_map_keys` are the spec's, because the spec is what this
// generator reads; a live capture is what settles it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { capabilityGroupFor } from './taxonomy.mjs';

/** The status for "we know the top-level key names, and nothing below them". */
export const FIELD_MAP_STATUS_KEYS_FROM_SPEC = 'keys_from_spec_example';

/** The status for "there is genuinely nothing to read" — a null/absent/empty example. */
export const FIELD_MAP_STATUS_NONE = 'TODO_no_usable_example';

/** Where `field_map_keys` came from, recorded on the row so it is never inferred. */
export const FIELD_MAP_KEYS_SOURCE = 'spec_200_example_top_level_keys';

const CONTRACT_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'contracts',
  'api-catalog.schema.json'
);

let allowedStatusCache = null;

/**
 * The `field_map_status` values the FROZEN shared contract currently permits.
 *
 * Read from the contract rather than duplicated here, because a frozen contract is
 * amended deliberately (CLAUDE.md), never by a side edit in the generator. Any status
 * the enum does not list is not legal, so the generator FAILS CLOSED to the status that
 * claims less, while still emitting `field_map_keys` (which is additive and legal under
 * the contract, since `endpoint` sets no `additionalProperties: false`).
 *
 * The enum is the only switch: a status added to it is picked up by
 * `npm run catalog:gen` with no further code change here.
 */
export function allowedFieldMapStatuses(contractFile = CONTRACT_FILE) {
  if (contractFile === CONTRACT_FILE && allowedStatusCache) return allowedStatusCache;
  let set;
  try {
    const schema = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
    const values = schema?.$defs?.endpoint?.properties?.field_map_status?.enum;
    set = new Set(Array.isArray(values) && values.length ? values : [FIELD_MAP_STATUS_NONE]);
  } catch {
    // Unreadable contract is not a licence to claim more. Fail closed.
    set = new Set([FIELD_MAP_STATUS_NONE]);
  }
  if (contractFile === CONTRACT_FILE) allowedStatusCache = set;
  return set;
}

/**
 * A request property that bounds the NUMBER OF RESULTS the call returns, and therefore
 * bounds the bill on a per-result endpoint.
 *
 * Deliberately exact-match, not substring. Substring matching gets this wrong on the
 * real spec in both directions:
 *   - `max_pages` (directory_yellowpages, web_emails) bounds pages, not results.
 *   - `posted_limit` / `scrape_posted_limit` (linkedin_company_posts) are recency
 *     filters whose values are '24h' / 'week' / 'month' — strings, not counts.
 *   - `company_size`, `employee_size_start/end`, `countries`, `account_owner` are
 *     audience filters that happen to contain a size-ish word.
 * With exact matching the derived unbounded set is exactly the 11 endpoints measured
 * by hand.
 */
const LIMIT_PARAM_NAMES = new Set([
  'limit',
  'count',
  'size',
  'top',
  'max_results',
  'maxresults',
  'num_results',
  'numresults',
  'per_page',
  'perpage',
  'page_size',
  'pagesize',
  'result_limit',
  'resultlimit',
]);

/**
 * A request property that lets the caller ask for the NEXT slice of the same result
 * set. Its presence is what makes a limit-style parameter a per-PAGE bound rather than
 * a bound on the total, because the caller can simply call again.
 *
 * Exact-match for the same reason LIMIT_PARAM_NAMES is: `max_pages` contains "page"
 * but is a ceiling, not a cursor, and `posted_limit` contains "limit" but is a recency
 * filter. Only two of these names occur in the pinned spec (`page`, `pagination_token`);
 * the rest are listed so a new spec that adopts a conventional cursor name is caught by
 * the generator instead of by a bill.
 */
const PAGINATION_PARAM_NAMES = new Set([
  'page',
  'page_number',
  'pagenumber',
  'pagination_token',
  'paginationtoken',
  'page_token',
  'pagetoken',
  'next_token',
  'nexttoken',
  'cursor',
  'offset',
  'start',
  'start_index',
  'startindex',
  'scroll_id',
  'scrollid',
]);

const BULK_SUFFIX = '_bulk';

/** Very small English de-pluraliser, only used to pair `X_bulk` with its single form. */
function singularize(token) {
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.endsWith('ses')) return token.slice(0, -2);
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/**
 * `enrich_profiles_bulk` -> `enrich_profile`, `enrich_companies_bulk` -> `enrich_company`.
 * Returns null when no such endpoint exists in the spec.
 */
export function singleFormOf(bulkName, allNames) {
  if (!bulkName.endsWith(BULK_SUFFIX)) return null;
  const stem = bulkName.slice(0, -BULK_SUFFIX.length);
  const parts = stem.split('_');
  parts[parts.length - 1] = singularize(parts[parts.length - 1]);
  const candidate = parts.join('_');
  return allNames.includes(candidate) ? candidate : null;
}

/** "Fetch up to 50 LinkedIn profiles in a single call" -> 50. */
export function maxBatchFromText(text) {
  if (!text) return null;
  const m = /\bup to (\d+)\b/i.exec(text);
  return m ? Number(m[1]) : null;
}

function jsonSchemaOf(requestBody) {
  return requestBody?.content?.['application/json']?.schema ?? null;
}

function responseExampleOf(op) {
  const r200 = op.responses?.['200'] ?? op.responses?.[200];
  return r200?.content?.['application/json']?.example;
}

/**
 * The declared 200 example's own top-level key names, sorted, or null when there is
 * nothing to read.
 *
 * Null — not `[]` — for the three endpoints with no usable example, because "the API
 * returns no keys" and "we do not know what the API returns" are different claims and
 * an empty array would say the first one. Those three are, measured on the pinned spec:
 * enrich_companies_bulk, enrich_profiles_bulk (no `example` at all) and
 * google_maps_places_scraper_keyword (an example that is not a JSON object).
 *
 * Top level ONLY. Walking into the example would start describing nested shape, which
 * is the part the spec cannot support and the part live fixtures exist to record.
 */
export function responseExampleKeys(example) {
  if (example === null || example === undefined) return null;
  if (typeof example !== 'object' || Array.isArray(example)) return null;
  const keys = Object.keys(example);
  return keys.length ? keys.slice().sort() : null;
}

/**
 * Does the response actually report what it CHARGED? LAW #4: never fabricate an
 * actual. When this is false the ledger writes cost_status=estimated_unverifiable.
 *
 * REWRITTEN 2026-09-17. This used to ask a different question — "does the spec's 200
 * example contain the `result_count_field`?" — and answer it from the spec, which law
 * 2 forbids as a schema source. Measured against 65 recorded 2xx bodies: ZERO carry a
 * charge or a credit count at any depth (the only "price" keys in the corpus are
 * product prices inside business data). So the catalog claimed 21 endpoints reported
 * their charge while every receipt they produced said `estimated_unverifiable` — a
 * contradiction the live runs of 2026-09-17 reported six times.
 *
 * The flag now means what its name says and is derived from EVIDENCE ONLY: it is true
 * for an endpoint whose recorded 2xx body carries a numeric billing field, and false
 * everywhere else, including every endpoint with no recording at all (fail closed,
 * law 5). The spec is not consulted: a documented example is not a charge.
 */

/**
 * Key names that count as "the response reported its charge".
 *
 * Deliberately NARROW. `price`, `amount` and `value` are excluded because business
 * data is full of them — google_maps places carry a `price` and a `cost` would be
 * indistinguishable from a product's. A wide net here manufactures the very
 * fabricated actual law 4 forbids.
 */
export const BILLING_FIELD_KEYS = Object.freeze([
  'credits_charged', 'credits_used', 'credits', 'charge', 'cost',
]);

/** Containers a billing field may hide in. Top level, or one meta/usage envelope. */
export const BILLING_FIELD_CONTAINERS = Object.freeze(['meta', 'usage']);

/**
 * Is `path` (a dotted scalar path off a recorded body) a billing field of type
 * `type`? Numeric only: `credits: "unlimited"` is prose, not a charge.
 */
export function isBillingFieldPath(path, type) {
  if (type !== 'number') return false;
  const seg = String(path).split('.');
  if (seg.length === 1) return BILLING_FIELD_KEYS.includes(seg[0]);
  if (seg.length === 2 && BILLING_FIELD_CONTAINERS.includes(seg[0])) {
    return BILLING_FIELD_KEYS.includes(seg[1]);
  }
  return false;
}

/**
 * The evidence answer for one recorded endpoint: does its recording carry a billing
 * field? A row with no recording is not evidence of absence — but it is not evidence
 * of presence either, and this flag fails closed, so the caller treats both as false.
 */
export function billingFieldPresentInRecording(row) {
  const types = row?.observed_types;
  if (!types || typeof types !== 'object') return false;
  return Object.entries(types).some(([p, t]) => isBillingFieldPath(p, t));
}

/**
 * Parse `x-pricing` into the frozen contract's pricing object.
 *
 * Shapes observed in the pinned spec (the only four keys that exist):
 *   { credits_per_call: N }                                          -> flat        (47)
 *   { credits_per_result: N, result_count_field: F }                 -> per_result  (16)
 *   { base_credits_per_call: B, credits_per_result: N, ... }         -> see below    (5)
 *
 * `base_plus_per_result` is reserved for a base that actually costs something. Four of
 * the five endpoints declaring `base_credits_per_call` declare it as 0 — economically
 * identical to per_result. Classifying those as base_plus_per_result would make
 * `pricing.model` flip (a PRICING_SEMANTICS_CHANGED BLOCK in the spec diff gate) the day the API drops
 * a redundant `base_credits_per_call: 0`, which is exactly the false alarm that gets a
 * gate switched off. `credits_base` is still recorded verbatim, so nothing is lost.
 */
export function parsePricing(xPricing) {
  if (!xPricing || typeof xPricing !== 'object') {
    return {
      model: 'unknown',
      credits_per_call: null,
      credits_base: null,
      credits_per_result: null,
      result_count_field: null,
    };
  }
  const perResult = numOrNull(xPricing.credits_per_result);
  const base = numOrNull(xPricing.base_credits_per_call);
  const perCall = numOrNull(xPricing.credits_per_call);
  const rcf = xPricing.result_count_field ?? null;

  let model;
  if (perResult !== null && base !== null && base > 0) model = 'base_plus_per_result';
  else if (perResult !== null) model = 'per_result';
  else if (perCall !== null) model = 'flat';
  else model = 'unknown';

  return {
    model,
    credits_per_call: perCall,
    credits_base: base,
    credits_per_result: perResult,
    result_count_field: rcf,
  };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Worst-case-agnostic cost of one call at `n` results. Used by the diff to compare two
 * pricing objects on one axis instead of three.
 */
export function costAt(pricing, n) {
  switch (pricing.model) {
    case 'flat':
      return pricing.credits_per_call ?? 0;
    case 'per_result':
      return (pricing.credits_base ?? 0) + (pricing.credits_per_result ?? 0) * n;
    case 'base_plus_per_result':
      return (pricing.credits_base ?? 0) + (pricing.credits_per_result ?? 0) * n;
    default:
      return null;
  }
}

/**
 * @param {object} doc parsed OpenAPI document
 * @param {object} [opts]
 * @param {Record<string, {reason: string}>} [opts.disabledByDefault]
 * @returns {{endpoints: Record<string, object>, warnings: string[], stats: object}}
 */
export function extractEndpoints(doc, opts = {}) {
  const disabled = opts.disabledByDefault ?? {};
  // Recorded 2xx bodies, the ONLY evidence that an endpoint reports its own charge.
  // Absent (a consumer regenerating without the shipped digest) means every row fails
  // closed to false, which is the honest state today anyway.
  const liveRows = opts.liveDigest?.endpoints ?? {};
  const allowedStatuses = opts.allowedFieldMapStatuses ?? allowedFieldMapStatuses();
  const keysStatus = allowedStatuses.has(FIELD_MAP_STATUS_KEYS_FROM_SPEC)
    ? FIELD_MAP_STATUS_KEYS_FROM_SPEC
    : FIELD_MAP_STATUS_NONE;
  const warnings = [];
  const paths = doc?.paths ?? {};
  const pathKeys = Object.keys(paths).sort();

  // Pass 1: collect operations.
  const raw = [];
  for (const p of pathKeys) {
    const item = paths[p];
    const op = item?.post;
    if (!op) {
      warnings.push(`skipped ${p}: no POST operation (the API is POST-only)`);
      continue;
    }
    const name = op.operationId ?? p.replace(/^\//, '');
    if (!op.operationId) warnings.push(`${p}: no operationId, fell back to path`);
    raw.push({ name, path: p, op });
  }
  const allNames = raw.map((r) => r.name);

  // Pass 2: bulk pairing, both directions.
  const bulkOf = new Map(); // single name -> bulk name
  const batchOf = new Map(); // bulk name -> max batch
  for (const { name, op } of raw) {
    if (!name.endsWith(BULK_SUFFIX)) continue;
    const max = maxBatchFromText(`${op.summary ?? ''} ${op.description ?? ''}`);
    batchOf.set(name, max);
    const single = singleFormOf(name, allNames);
    if (single) bulkOf.set(single, name);
    else warnings.push(`${name}: bulk endpoint with no single-record counterpart in spec`);
    if (max === null) warnings.push(`${name}: no "up to N" batch ceiling in summary/description`);
  }

  const endpoints = {};
  const stats = {
    total: 0,
    by_group: {},
    pricing_models: {},
    bounded_false: [],
    page_gated: [],
    billing_field_absent: [],
    no_required_fields: [],
    request_body_optional: [],
    // Endpoints with NOTHING to read in the 200 example. Before 2026-08-30 this held
    // every endpoint in the spec; it now holds only the genuine blanks, and
    // `field_map_keys_from_spec` holds the rest. A regression that puts all 68 back in
    // here is the old lie returning.
    field_map_todo: [],
    field_map_keys_from_spec: [],
    // `keys_from_spec_example` if the frozen contract permits it yet, else the
    // fail-closed fallback. Printed by richapi-catalog-gen so the state is never a
    // guess.
    field_map_keys_status: keysStatus,
    provisional_groups: [],
  };

  for (const { name, path, op } of raw) {
    const { group, provisional } = capabilityGroupFor(name);
    if (provisional) {
      stats.provisional_groups.push(name);
      warnings.push(
        `${name}: not in the capability taxonomy, provisionally grouped as "${group}" — ` +
          `add it to _lib/catalog/taxonomy.mjs`
      );
    }

    const pricing = parsePricing(op['x-pricing']);
    if (pricing.model === 'unknown') warnings.push(`${name}: unparseable or missing x-pricing`);

    const example = responseExampleOf(op);
    const exampleKeys = responseExampleKeys(example);

    const schema = jsonSchemaOf(op.requestBody);
    const props = Object.keys(schema?.properties ?? {});
    const required = [...(schema?.required ?? [])].sort();
    const requestBodyRequired = op.requestBody?.required === true;

    const metered = pricing.model === 'per_result' || pricing.model === 'base_plus_per_result';
    const hasLimitParam = props.some((p) => LIMIT_PARAM_NAMES.has(p.toLowerCase()));
    const hasPaginationParam = props.some((p) => PAGINATION_PARAM_NAMES.has(p.toLowerCase()));
    // The endpoint's OWN documented batch ceiling ("Fetch up to 50 ... in a single
    // call"), not one inherited from a bulk sibling. Only a bulk form has one.
    const ownBatchCeiling = batchOf.has(name) ? batchOf.get(name) : null;
    // A flat call costs the same whatever comes back, so its spend is bounded by
    // definition. Only per-result endpoints can be unbounded.
    const bounded = metered ? hasLimitParam : true;

    // EVIDENCE ONLY (see billingFieldPresentInRecording). This used to read `true` for
    // every flat endpoint "by construction" and for every metered endpoint whose
    // result_count_field appeared in a SPEC EXAMPLE. Both arms were claims no recorded
    // response supports: across 65 recorded 2xx bodies not one carries a charge. The
    // ledger already refused to promote a flat price to an actual (`resolveActual`
    // returns null for `model: 'flat'`), so the old `true` only ever contradicted the
    // receipt it was supposed to explain.
    pricing.billing_field_present_in_response =
      billingFieldPresentInRecording(liveRows[name]);
    pricing.bounded = bounded;

    // `page_gated` is NOT `!bounded`. They are different questions and the pinned spec
    // answers them differently for four endpoints:
    //
    //   bounded          "does a request field cap the number of results I am billed
    //                     for on THIS CALL?"                    -> is there a `limit`
    //   page_gated       "can the caller keep walking and be billed again for the same
    //                     result set?"                          -> needs a human between
    //                                                              pages to be a bound
    //
    // people_search and post_keyword_search declare `limit` — the spec's own words are
    // "Number of items per page" and "Results per page, 1-50" — alongside `page`. They
    // are bounded per call and unbounded per search, so they page-gate.
    // enrich_profiles_bulk and enrich_companies_bulk declare no `limit`, so they are
    // bounded:false, but their result count IS the length of the caller's own `urns`
    // array, capped at 50 by the documented batch ceiling. There is no next page and
    // nothing for a human between pages to decide, so they do not page-gate.
    //
    // The catalog generator once computed the first predicate and the ledger the second,
    // both called the answer "the 11 unbounded endpoints", and the sets were different.
    // Hence this field.
    //
    // A real pagination param page-gates even a FLAT endpoint. `bounded` is true for a
    // flat call because one call has one fixed price — but each page is its own call,
    // so walking pages multiplies a flat price exactly as it multiplies a per-result
    // one (post_activities: 3cr per page, zero-based `page`). Without a pagination
    // param, a flat endpoint has no next page to walk, so the `!hasLimitParam` arm
    // stays metered-only.
    pricing.page_gated = ownBatchCeiling === null && (hasPaginationParam || (metered && !hasLimitParam));

    const dis = disabled[name];
    pricing.disabled_by_default = Boolean(dis);
    pricing.disabled_reason = dis ? dis.reason : null;

    const bulkVariant = bulkOf.get(name) ?? null;
    const maxBatch = batchOf.has(name) ? batchOf.get(name) : bulkVariant ? batchOf.get(bulkVariant) ?? null : null;

    endpoints[name] = {
      name,
      path,
      capability_group: group,
      spec_tag: op.tags?.[0] ?? null,
      pricing: orderPricing(pricing),
      required_request_fields: required,
      // EVERY request property the spec declares, not just the required ones. The
      // runtime needs to know which fields an endpoint HAS, not only which it insists
      // on: `richapi search lead_search --page-size 10` priced a page at 10 results and
      // was billed for 25, because lead_search declares `page` and no page-size field
      // at all — the flag could never have reached the server. `required_request_fields`
      // cannot answer that question (it is `[]` for lead_search), so the full list is
      // published here. It is spelling from the spec, not semantics, so law 2 is
      // untouched: these are REQUEST field names, never a response field map.
      request_fields: [...props].sort(),
      request_body_required: requestBodyRequired,
      bulk_variant: bulkVariant,
      max_batch: maxBatch ?? null,
      // LAW #2. Never derived from a spec example. The live fixture capture fills these in.
      field_map: null,
      // Top-level response key NAMES only — see the header. An array, never an object,
      // so it can never be read as a field map.
      field_map_keys: exampleKeys,
      field_map_keys_source: exampleKeys ? FIELD_MAP_KEYS_SOURCE : null,
      field_map_status: exampleKeys ? keysStatus : FIELD_MAP_STATUS_NONE,
      deprecated: op.deprecated === true,
    };

    stats.total += 1;
    stats.by_group[group] = (stats.by_group[group] ?? 0) + 1;
    stats.pricing_models[pricing.model] = (stats.pricing_models[pricing.model] ?? 0) + 1;
    if (metered && !bounded) stats.bounded_false.push(name);
    if (pricing.page_gated) stats.page_gated.push(name);
    // Every row whose recording does NOT report a charge, not just the metered ones:
    // since the flag became evidence-derived, a flat endpoint is in exactly the same
    // position as a per-result one — the charge is an estimate either way.
    if (!pricing.billing_field_present_in_response) stats.billing_field_absent.push(name);
    if (required.length === 0) stats.no_required_fields.push(name);
    if (!requestBodyRequired) stats.request_body_optional.push(name);
    if (exampleKeys) stats.field_map_keys_from_spec.push(name);
    else stats.field_map_todo.push(name);
  }

  for (const k of Object.keys(stats)) if (Array.isArray(stats[k])) stats[k].sort();

  // Sorted key order is what makes regeneration byte-identical.
  const sorted = {};
  for (const k of Object.keys(endpoints).sort()) sorted[k] = endpoints[k];
  return { endpoints: sorted, warnings, stats };
}

function orderPricing(p) {
  return {
    model: p.model,
    credits_per_call: p.credits_per_call,
    credits_base: p.credits_base,
    credits_per_result: p.credits_per_result,
    result_count_field: p.result_count_field,
    billing_field_present_in_response: p.billing_field_present_in_response,
    bounded: p.bounded,
    page_gated: p.page_gated,
    disabled_by_default: p.disabled_by_default,
    disabled_reason: p.disabled_reason,
  };
}
