// _lib/mapping-audit.mjs — the empty-column tripwire's run-level record.
//
// `client.inspectResponse` classifies ONE response. This accumulates those
// classifications across a run so the receipt can say, loudly and once:
//
//     "You paid for 42 calls and this run delivered 0 columns."
//
// That sentence is the whole point. The empty-mapping defect shipped because nothing in the pack could
// say it: `enrich_profile` and `enrich_company` mapped to nothing, the output file
// was written with the input columns and no new ones, and the run reported success.
// Every row then re-enriched forever, because the "already enriched?" predicate keys
// on columns that could never arrive.
//
// WHAT IS STORED (law 7). Counts, endpoint names, and RESPONSE KEY NAMES. Never a
// value, never a row id in the persisted summary. A key set is the evidence needed
// to fix RESPONSE_MAPS; a value is a contact.

import { MAP_MAPPED, MAP_EMPTY, MAP_UNMAPPED, MAP_NO_MAP } from './client.mjs';

/** How many distinct key sets to keep per endpoint. Bounded, so a 500-row run
 *  cannot grow the summary without limit. Three is enough to see the pattern. */
export const MAX_KEY_SETS_PER_ENDPOINT = 3;

const emptyEndpoint = () => ({
  calls: 0,
  mapped: 0,
  empty: 0,
  provider_error: 0,
  failures: 0,
  // Responses delivered RAW because this endpoint has no RESPONSE_MAPS entry. Counted
  // apart from `failures` since 2026-09-17: see the note on `record` below.
  unmapped: 0,
  columns: [],                 // distinct output columns this endpoint delivered
  expected_keys: [],           // what RESPONSE_MAPS says it should answer with
  observed_key_sets: [],       // [{ keys: [...], count: n }] — the evidence
  map_status: null,
  first_reason: null,
});

export function createMappingAudit () {
  const byEndpoint = {};
  const issues = [];

  function record (inspection, { row_id = null, hop = null, billing = null } = {}) {
    if (!inspection || !inspection.endpoint) return inspection;
    const e = (byEndpoint[inspection.endpoint] ??= emptyEndpoint());
    e.calls += 1;
    e.map_status ??= inspection.map_status ?? null;
    if (!e.expected_keys.length) e.expected_keys = [...(inspection.expected_keys ?? [])];

    for (const c of inspection.mapped_columns ?? []) {
      if (!e.columns.includes(c)) e.columns.push(c);
    }

    // A call the API says it did not bill delivered nothing because the PROVIDER
    // failed, not because the person was not found and not because a map is wrong.
    // Counting it as `empty` reads as "we paid and got nothing", which is the one
    // thing it is not: `billed: false` means no charge (law 4, measured 2026-09-17).
    if (billing && billing.billed === false && billing.reason === 'provider_error') {
      e.provider_error += 1;
      return inspection;
    }
    if (inspection.status === MAP_MAPPED) { e.mapped += 1; return inspection; }
    if (inspection.status === MAP_EMPTY) { e.empty += 1; return inspection; }

    // NO MAP IS NOT A FAILURE. Corrected 2026-09-17 after six of eleven live runs
    // printed "MAPPING FAILURE — THIS RUN PAID FOR CALLS AND DELIVERED ZERO COLUMNS"
    // for endpoints that had simply never been mapped, while the runtime was handing
    // the caller the whole body raw.
    //
    //   MAP_NO_MAP    there is no map, the body is delivered raw, nothing is lost.
    //                 A gap in coverage, reported calmly, with the key count so the
    //                 next person can write the map.
    //   MAP_UNMAPPED  there IS a map, the response carried data, and the map read
    //                 none of it. Something WAS lost on a paid call. Stays loud.
    //
    // Conflating them cost the loud banner its meaning: an operator who sees it on
    // every run stops reading it, and then misses the run where it is real.
    const keysNoMap = [...(inspection.raw_keys ?? [])].sort();
    if (inspection.status === MAP_NO_MAP) {
      e.unmapped += 1;
      e.first_reason ??= inspection.reason;
      const sigNoMap = keysNoMap.join(',');
      const seenNoMap = e.observed_key_sets.find(x => x.keys.join(',') === sigNoMap);
      if (seenNoMap) seenNoMap.count += 1;
      else if (e.observed_key_sets.length < MAX_KEY_SETS_PER_ENDPOINT) {
        e.observed_key_sets.push({ keys: keysNoMap, count: 1 });
      }
      return inspection;
    }

    // --- real mapping failure (MAP_UNMAPPED / MAP_PARTIAL) ---
    e.failures += 1;
    e.first_reason ??= inspection.reason;

    // The raw key set IS the evidence. Without it the next debugger is guessing at
    // camelCase vs snake_case all over again, which is exactly how that defect survived.
    const keys = [...(inspection.raw_keys ?? [])].sort();
    const sig = keys.join(',');
    const seen = e.observed_key_sets.find(s => s.keys.join(',') === sig);
    if (seen) seen.count += 1;
    else if (e.observed_key_sets.length < MAX_KEY_SETS_PER_ENDPOINT) {
      e.observed_key_sets.push({ keys, count: 1 });
    }

    // row_id is a hash, not a contact (enrich.rowIdFor), and it is kept in memory
    // only so a caller can point at which units were affected. It is not persisted
    // into the receipt summary.
    issues.push({
      endpoint: inspection.endpoint,
      status: inspection.status,
      row_id,
      hop,
      reason: inspection.reason,
      raw_keys: keys,
      expected_keys: inspection.expected_keys ?? [],
      unrecognised_keys: inspection.unrecognised_keys ?? [],
    });
    return inspection;
  }

  function summary () {
    let calls = 0, mapped = 0, empty = 0, failures = 0, unmapped = 0, providerError = 0;
    const columns = new Set();
    const failed = [];
    const unmappedEndpoints = [];
    for (const [ep, e] of Object.entries(byEndpoint)) {
      calls += e.calls; mapped += e.mapped; empty += e.empty; failures += e.failures;
      unmapped += e.unmapped ?? 0;
      providerError += e.provider_error ?? 0;
      for (const c of e.columns) columns.add(c);
      if (e.failures > 0) failed.push(ep);
      if ((e.unmapped ?? 0) > 0) unmappedEndpoints.push(ep);
    }
    return {
      calls,
      mapped_responses: mapped,
      empty_responses: empty,
      // Not billed: the provider failed. Never a not-found and never a mapping fault.
      provider_error_responses: providerError,
      mapping_failures: failures,
      // Delivered raw, because no map exists. A coverage gap, not a loss.
      unmapped_responses: unmapped,
      unmapped_endpoints: unmappedEndpoints.sort(),
      columns_delivered: columns.size,
      failed_endpoints: failed.sort(),
      // The empty-mapping defect exactly: money was spent and nothing came back.
      // A run whose every call went to an UNMAPPED endpoint is not that: the caller
      // got the whole body. Columns are zero because no map was asked to make any.
      total_blackout: calls > 0 && columns.size === 0 && (unmapped + providerError) < calls,
      by_endpoint: byEndpoint,
    };
  }

  return { record, summary, issues, byEndpoint };
}

/** A no-op audit, so a caller that does not want one need not branch. */
export function nullMappingAudit () {
  return {
    record: (i) => i,
    summary: () => ({
      calls: 0, mapped_responses: 0, empty_responses: 0, provider_error_responses: 0, mapping_failures: 0,
      unmapped_responses: 0, unmapped_endpoints: [],
      columns_delivered: 0, failed_endpoints: [], total_blackout: false, by_endpoint: {},
    }),
    issues: [],
    byEndpoint: {},
  };
}

/**
 * The loud block. Returns null when there is nothing wrong — a clean run must not
 * grow a warning section, or the warning stops being read.
 */
export function renderMappingAlert (s) {
  if (!s || (s.mapping_failures === 0 && !s.total_blackout)) return null;
  const L = [];

  if (s.total_blackout) {
    L.push('!!! MAPPING FAILURE — THIS RUN PAID FOR CALLS AND DELIVERED ZERO COLUMNS !!!');
    L.push(`    ${s.calls} call(s) were billed. 0 output columns were produced.`);
  } else {
    L.push('!!! MAPPING FAILURE — some paid responses could not be read !!!');
    L.push(`    ${s.mapping_failures} of ${s.calls} billed call(s) returned data that mapped to no column.`);
  }
  L.push('    This is NOT a not-found. The API answered WITH data and the field map failed to read it.');
  L.push('    Do not treat these rows as enriched: the "already enriched" check keys on the missing');
  L.push('    columns, so they will be re-bought on every subsequent run.');
  L.push('');

  for (const ep of s.failed_endpoints) {
    const e = s.by_endpoint[ep];
    L.push(`  ${ep}  —  ${e.failures}/${e.calls} call(s) unreadable`);
    if (e.first_reason) L.push(`      ${e.first_reason}`);
    L.push(`      map expects : ${e.expected_keys.join(', ') || '(no map)'}`);
    for (const set of e.observed_key_sets) {
      L.push(`      API returned: ${set.keys.join(', ') || '(no keys)'}   x${set.count}`);
    }
    if (e.map_status) L.push(`      map provenance: ${e.map_status}`);
  }
  L.push('');
  L.push('  Fix: correct _lib/client.mjs RESPONSE_MAPS against the key sets above, or run');
  L.push('  `node bin/richapi-capture-fixtures.mjs --run` to record them from the live API.');
  return L.join('\n');
}

/**
 * The CALM note: endpoints answered, were delivered raw, and have no map yet.
 *
 * Deliberately not the loud block, and deliberately not silent either. Raw delivery
 * loses nothing, so it is not a failure — but an unmapped endpoint produces no
 * spreadsheet column, so the "is this row already enriched?" check cannot see it, and
 * leaving that unsaid is how a coverage gap survives a quarter.
 *
 * Returns null when every endpoint in the run had a map.
 */
export function renderUnmappedNote (s) {
  if (!s || !s.unmapped_responses) return null;
  const L = [];
  L.push(`  ${s.unmapped_responses} response(s) were DELIVERED UNMAPPED — the raw body reached you, `
    + 'but no field map turned it into columns:');
  for (const ep of s.unmapped_endpoints ?? []) {
    const e = s.by_endpoint?.[ep] ?? {};
    const keys = e.observed_key_sets?.[0]?.keys ?? [];
    L.push(`    ${ep}  —  ${e.unmapped ?? 0}/${e.calls ?? 0} call(s), raw body, ${keys.length} key(s)`);
    if (keys.length) L.push(`      keys: ${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''}`);
  }
  L.push('  This is NOT a mapping failure: nothing was lost. To get columns, add an entry to');
  L.push('  _lib/client.mjs RESPONSE_MAPS using the key names above.');
  return L.join('\n');
}

export default { createMappingAudit, nullMappingAudit, renderMappingAlert, renderUnmappedNote, MAX_KEY_SETS_PER_ENDPOINT };
