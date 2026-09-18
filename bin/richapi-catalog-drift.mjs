#!/usr/bin/env node
// richapi-catalog-drift — is the pinned catalog still what the server is serving?
//
// WHY THIS EXISTS
//
//   `spec/openapi.yaml` is pinned by sha256 and `_lib/api-catalog.json` is generated
//   from it. That pin is correct and stays: an intra-run reprice on a credit-spending
//   tool is worse than a day of drift latency. But pinning did not PREVENT drift, it
//   made drift SILENT — a pinned file cannot notice that the server moved. Diffing the
//   pin against the server's own catalog table found two endpoint-set bugs that had
//   been sitting in the repo unnoticed. This is the oracle that makes the pin
//   defensible: the pin stays authoritative for spending, and this fails loud when the
//   pin and the wire disagree.
//
//   The source is the server's live catalog table (`GET /api/v1/catalog`) — the same
//   table the spec is generated from, served directly, so it is richer and fresher
//   than re-exporting a spec. It is PUBLIC: it answers 200 with no API key.
//
// Usage:
//   node bin/richapi-catalog-drift.mjs [options]
//
//   --url <url>        live catalog endpoint
//                      (default $RICHAPI_CATALOG_URL or https://api.richapi.ai/api/v1/catalog)
//   --live <file>      read the live payload from a file instead of the network (tests)
//   --pinned <file>    pinned catalog to defend (default _lib/api-catalog.json)
//   --timeout <ms>     hard deadline for the whole fetch, body included
//                      (default $RICHAPI_CATALOG_TIMEOUT_MS or 10000)
//   --require-network  an unreachable/unusable server is a FAILURE instead of a skip
//   --warn-only        always exit 0 (the report still names the blockers)
//   --json             machine-readable output
//   --help
//
// Exit codes:
//   0  no blocking drift — INCLUDING every no-network / unreachable / unusable-payload
//      case, which SKIPS with a loud message. `scripts/ci-local.sh` runs offline
//      routinely; a check that wedges offline gets deleted, and then it protects
//      nothing. `--require-network` opts into the strict behaviour.
//   1  blocking drift, or the pinned catalog itself could not be read.
//
// SEVERITY MODEL — reused verbatim from _lib/catalog/diff.mjs, not reinvented.
//
//   Two severity vocabularies in one repo is how one of them rots, so the eight
//   classes and their block/warn/info levels come straight from that module's SEVERITY
//   map. Drift adds exactly two classes, in the same shape and on the same scale,
//   because a required-request-field change has no existing class and the live catalog
//   is the only place the pack can see one:
//
//     BLOCK  REQUIRED_FIELD_ADDED    the server now demands a field the pin does not
//                                    send. Every skill routing here 400s at call time
//                                    — the same failure mode as REMOVED_UNMAPPED,
//                                    which already blocks. Measured false-alarm rate
//                                    against the live server on the day this landed: 0.
//     warn   REQUIRED_FIELD_REMOVED  the server relaxed a requirement. Backwards
//                                    compatible; every existing call still works.
//
//   Two deliberate differences from absorb mode, both of them because drift mode
//   CHANGES NOTHING — there is no new spec being taken in, the pin is what it is:
//
//     * RENAME MATCHING IS OFF. In absorb mode a fuzzy old->new match is a warn
//       because the fix is mechanical and gets absorbed in the same pass. Here nothing
//       is absorbed: if the server renamed an endpoint, the old name is dead on the
//       wire and every skill routing to it fails, exactly as if it were deleted. So a
//       server-side rename surfaces as REMOVED_UNMAPPED (block) + ADDED (info). The
//       fuzzy match is still computed and printed as a "likely renamed to X" hint
//       under the blocker, so no information is lost — only the excuse.
//     * ADDED STAYS info. A new endpoint the pin has never heard of is unreachable by
//       construction: skills route through the catalog, so an endpoint absent from the
//       catalog cannot be called and cannot spend a credit. It is lost capability, not
//       a hazard. It is reported in the summary line and in its own section on every
//       run — visible, not fatal. This is the `company_enricher` case.
//
// WHAT THIS CANNOT SEE, stated rather than papered over (law 6, evidence over vibes).
//
//   The live catalog carries no response examples and no deprecation flag, so:
//     * `pricing.billing_field_present_in_response` is derivable only for unmetered
//       endpoints (true by construction). For a metered endpoint the pinned value is
//       carried forward unchanged, so the comparison is a no-op rather than a
//       fabricated `false`. Those endpoints are listed in the report. They stay
//       covered against the pinned spec by `richapi-catalog-diff`.
//     * the DEPRECATED class cannot fire here at all.
//
//   Everything else — the endpoint name set, pricing model, per-call credits, per-result
//   credits, the base, the result-count field, boundedness, and required request fields
//   — is derived from the live payload by `_lib/catalog/extract.mjs`, the SAME extractor
//   that built the pinned catalog from the spec. One derivation, not two: any difference
//   this reports is a real server-vs-pin difference and not an artifact of a second
//   parser drifting from the first.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SEVERITY, RENAME_THRESHOLD, diffCatalogs, matchRenames } from '../_lib/catalog/diff.mjs';
import { extractEndpoints } from '../_lib/catalog/extract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_URL = 'https://api.richapi.ai/api/v1/catalog';
export const DEFAULT_TIMEOUT_MS = 10_000;

/** The eight shared classes, plus the two drift-only ones. Same scale, one vocabulary. */
export const DRIFT_SEVERITY = Object.freeze({
  ...SEVERITY,
  REQUIRED_FIELD_ADDED: 'block',
  REQUIRED_FIELD_REMOVED: 'warn',
});

export const DRIFT_BLOCKING = Object.entries(DRIFT_SEVERITY)
  .filter(([, s]) => s === 'block')
  .map(([k]) => k)
  .sort();

/** Print order: blockers first, then warnings, then info. */
const REPORT_ORDER = [
  'PRICING_SEMANTICS_CHANGED',
  'REPRICED_MAJOR',
  'REMOVED_UNMAPPED',
  'REQUIRED_FIELD_ADDED',
  'RENAMED',
  'REPRICED_MINOR',
  'REQUIRED_FIELD_REMOVED',
  'DEPRECATED',
  'ADDED',
];

const METERED = new Set(['per_result', 'base_plus_per_result']);

/** Rename matching disabled: nothing can score >= Infinity. See the header. */
const RENAMES_OFF = Number.POSITIVE_INFINITY;

/** The payload arrived but cannot be trusted to mean "this is the whole catalog". */
export class UnusableCatalogError extends Error {}

// ---------------------------------------------------------------------------
// live payload -> catalog
// ---------------------------------------------------------------------------

/**
 * Re-shape one live catalog row into the OpenAPI operation the extractor expects.
 *
 * The live `pricing` object uses the same four keys as the spec's `x-pricing`
 * (`credits_per_call`, `base_credits_per_call`, `credits_per_result`,
 * `result_count_field`), and `input_schema` is a flat map of property -> {type,
 * required}. That is everything `extractEndpoints` reads apart from the response
 * example, so the live table can be fed through the real extractor rather than through
 * a hand-rolled second one.
 */
export function liveCatalogToSpecDoc(tools) {
  const paths = {};
  for (const tool of tools) {
    const properties = {};
    const required = [];
    for (const [prop, meta] of Object.entries(tool?.input_schema ?? {})) {
      properties[prop] = { type: meta?.type ?? 'string', description: meta?.description ?? '' };
      if (meta?.required === true) required.push(prop);
    }
    const apiPath = String(tool?.api_path ?? tool?.name ?? '').replace(/^\/+/, '');
    paths[`/${apiPath}`] = {
      post: {
        operationId: tool?.name ?? apiPath,
        summary: tool?.description ?? '',
        description: tool?.description ?? '',
        tags: tool?.category ? [tool.category] : [],
        'x-pricing': tool?.pricing ?? null,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object', properties, required } } },
        },
        // No response example exists on the wire. Deliberately absent rather than
        // invented — see the header's "what this cannot see".
        responses: {},
      },
    };
  }
  return { openapi: '3.0.0', info: { version: 'live' }, paths };
}

/**
 * @param {object} payload the raw `GET /api/v1/catalog` body
 * @param {object} [opts]
 * @param {object} [opts.pinned] pinned catalog, used only to carry forward the one
 *   field the live table cannot express
 * @param {string} [opts.fetchedAt]
 * @returns {{catalog: object, unobservableBillingField: string[], warnings: string[]}}
 */
export function adaptLiveCatalog(payload, { pinned = null, fetchedAt = null } = {}) {
  const tools = payload?.tools;
  if (!Array.isArray(tools)) {
    throw new UnusableCatalogError('response has no `tools` array — this is not a catalog payload');
  }
  if (tools.length === 0) {
    throw new UnusableCatalogError('response lists zero tools');
  }
  // A truncated response would read as a mass removal and block CI on a lie. The
  // server states its own count; refuse the payload rather than report fabricated drift.
  if (typeof payload.total === 'number' && payload.total !== tools.length) {
    throw new UnusableCatalogError(
      `response says total=${payload.total} but carries ${tools.length} tool(s) — truncated ` +
        'or paginated, and reading it as drift would fabricate removals'
    );
  }
  const unnamed = tools.filter((t) => !t?.name).length;
  if (unnamed) throw new UnusableCatalogError(`${unnamed} tool row(s) have no \`name\``);

  // No `disabledByDefault` seed is passed on purpose. "We ship this one off by default"
  // is OUR editorial decision about our own pack; the server has no such concept and
  // cannot drift on it. Injecting the seed here would only paint a local policy onto
  // the live side and make it look like an observation.
  const { endpoints, warnings } = extractEndpoints(liveCatalogToSpecDoc(tools));

  // LAW #4, never fabricate: `billing_field_present_in_response` is an EVIDENCE flag —
  // true only when a RECORDED 2xx body carried a numeric billing field. The live
  // catalog table is a price list, not a response, so it is evidence about this for no
  // endpoint at all. Widened 2026-09-17 from metered-only: while flat rows were `true`
  // by construction the extractor still reproduced them here, and now that they are
  // evidence-derived the same missing-evidence artifact applies to every row. Without
  // this, a clean drift run reported "billing field disappeared" as a BLOCK on six
  // endpoints — a lie, and a gate that lies gets switched off.
  const unobservableBillingField = [];
  for (const [name, ep] of Object.entries(endpoints)) {
    unobservableBillingField.push(name);
    const before = pinned?.endpoints?.[name]?.pricing?.billing_field_present_in_response;
    if (typeof before === 'boolean') ep.pricing.billing_field_present_in_response = before;
  }
  unobservableBillingField.sort();

  return {
    catalog: {
      schema_version: pinned?.schema_version ?? 1,
      generated_at: fetchedAt ?? new Date().toISOString(),
      spec_sha256: null,
      spec_version: 'live',
      endpoints,
    },
    unobservableBillingField,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// the two drift-only classes
// ---------------------------------------------------------------------------

/**
 * Required-request-field changes on endpoints both sides know about.
 *
 * `diffCatalogs` does not compare these — it was built for a spec-to-spec absorption
 * where the required set travels with the pricing it is being absorbed alongside. Here
 * the pin is frozen, so a field the server started requiring is a live breakage.
 */
export function diffRequiredFields(pinned, live) {
  const out = [];
  for (const name of Object.keys(pinned?.endpoints ?? {}).sort()) {
    const after = live?.endpoints?.[name];
    if (!after) continue; // absence is REMOVED_UNMAPPED's business, not this one's
    const was = new Set(pinned.endpoints[name].required_request_fields ?? []);
    const now = new Set(after.required_request_fields ?? []);
    const added = [...now].filter((f) => !was.has(f)).sort();
    const removed = [...was].filter((f) => !now.has(f)).sort();
    if (added.length) {
      out.push({
        class: 'REQUIRED_FIELD_ADDED',
        severity: DRIFT_SEVERITY.REQUIRED_FIELD_ADDED,
        endpoint: name,
        fields: added,
        detail:
          `${name} now requires ${added.map((f) => `\`${f}\``).join(', ')}, which the pinned ` +
          'catalog does not list. Every call the pack builds from the pin is missing it and ' +
          'fails at request time.',
      });
    }
    if (removed.length) {
      out.push({
        class: 'REQUIRED_FIELD_REMOVED',
        severity: DRIFT_SEVERITY.REQUIRED_FIELD_REMOVED,
        endpoint: name,
        fields: removed,
        detail:
          `${name} no longer requires ${removed.map((f) => `\`${f}\``).join(', ')}. Backwards ` +
          'compatible — existing calls still work; re-pin when convenient.',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------

/**
 * @param {object} pinned pinned catalog (v2 shape)
 * @param {object} payload raw live catalog body
 * @returns {{changes, summary, blocking, exitCode, counts, unobservableBillingField, renameHints, warnings}}
 */
export function driftCheck(pinned, payload, opts = {}) {
  const adapted = adaptLiveCatalog(payload, { pinned, fetchedAt: opts.fetchedAt });
  const live = adapted.catalog;

  const base = diffCatalogs(pinned, live, {
    majorRatio: opts.majorRatio,
    // Drift mode does not absorb, so it does not forgive a rename. See the header.
    renameThreshold: RENAMES_OFF,
  });

  const changes = [...base.changes, ...diffRequiredFields(pinned, live)].sort(
    (a, b) => a.class.localeCompare(b.class) || a.endpoint.localeCompare(b.endpoint)
  );

  const summary = {};
  for (const c of changes) summary[c.class] = (summary[c.class] ?? 0) + 1;
  const blocking = changes.filter((c) => c.severity === 'block');

  // Computed for the report only: naming the plausible successor of a dead endpoint is
  // information; downgrading the blocker because one exists is not.
  const pinnedNames = Object.keys(pinned?.endpoints ?? {});
  const liveNames = Object.keys(live.endpoints);
  const renameHints = matchRenames(
    pinnedNames.filter((n) => !(n in live.endpoints)).sort(),
    liveNames.filter((n) => !(n in (pinned?.endpoints ?? {}))).sort(),
    pinned?.endpoints ?? {},
    live.endpoints,
    RENAME_THRESHOLD
  );

  return {
    changes,
    summary,
    blocking,
    exitCode: blocking.length > 0 ? 1 : 0,
    counts: { pinned: pinnedNames.length, live: liveNames.length },
    unobservableBillingField: adapted.unobservableBillingField,
    renameHints,
    warnings: adapted.warnings,
  };
}

// ---------------------------------------------------------------------------
// fetch — never throws, always bounded
// ---------------------------------------------------------------------------

/**
 * Fetch the live catalog. Mirrors `loadSpec` in _lib/catalog/generate.mjs: a network
 * problem is returned, never thrown, so no caller can be wedged by one.
 *
 * The abort timer is cleared only after the BODY has been read. Clearing it once the
 * headers arrive leaves a server that sends `200` and then stalls mid-body able to hang
 * for as long as it likes, which is the shape of hang that actually happens.
 */
export async function fetchLiveCatalog({
  url,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const started = Date.now();
  try {
    // No key is sent, and none is needed: the catalog table is public (verified — it
    // answers 200 with no Authorization header; the MCP server reads it with an empty
    // key). If that ever changes, the non-2xx lands in the catch below and SKIPS, so a
    // newly-private endpoint degrades to "cannot see" and not to "no drift".
    const res = await fetchImpl(url, {
      signal: ac.signal,
      headers: { accept: 'application/json' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`response is not JSON (${text.slice(0, 60).replace(/\s+/g, ' ')}…)`);
    }
    return { payload, error: null, ms: Date.now() - started };
  } catch (err) {
    const reason =
      err?.name === 'AbortError' || err?.name === 'TimeoutError'
        ? `timed out after ${timeoutMs}ms`
        : (err?.cause?.message ?? err?.message ?? String(err));
    return { payload: null, error: reason, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

/**
 * Drift-specific wording, rendered from the change object's STRUCTURED fields rather
 * than by string-surgery on `diffCatalogs`'s absorb-mode prose ("gone from the spec"
 * is the wrong sentence when the other side is a live server).
 */
function driftDetail(c) {
  switch (c.class) {
    case 'REMOVED_UNMAPPED':
      return (
        `${c.endpoint} is in the pinned catalog and NOT on the live server. Every skill ` +
        'routing to it fails at call time. Re-pin, remap, or retire it.'
      );
    case 'ADDED':
      return (
        `${c.endpoint} exists on the live server and is absent from the pinned catalog. ` +
        'Unreachable until the pin catches up — lost capability, not a hazard.'
      );
    case 'REPRICED_MAJOR':
    case 'REPRICED_MINOR':
      return (
        `${c.endpoint}: pinned ${c.from_credits} -> live ${c.to_credits} credits` +
        (c.ratio === null ? ' (was free)' : ` (${c.ratio}x)`) +
        '. Every estimate the pack has written used the pinned number.'
      );
    case 'PRICING_SEMANTICS_CHANGED':
      return `${c.endpoint}: ${(c.reasons ?? []).join('; ')}. The bill is computed a different way now.`;
    default:
      return c.detail;
  }
}

export function formatDriftReport(result, { pinnedLabel, liveLabel } = {}) {
  const lines = [];
  lines.push(`catalog drift  ${pinnedLabel} (pinned)  ->  ${liveLabel} (live)`);
  lines.push(`  ${result.counts.pinned} pinned endpoint(s) vs ${result.counts.live} live`);
  const counts = REPORT_ORDER.filter((k) => result.summary[k])
    .map((k) => `${k}=${result.summary[k]}`)
    .join('  ');
  lines.push(counts ? `  ${counts}` : '  no drift');

  const hintFor = new Map(result.renameHints.map((h) => [h.from, h]));
  for (const cls of REPORT_ORDER) {
    const rows = result.changes.filter((c) => c.class === cls);
    if (!rows.length) continue;
    const sev = DRIFT_SEVERITY[cls];
    const mark = sev === 'block' ? 'BLOCK' : sev === 'warn' ? 'warn ' : 'info ';
    lines.push('');
    lines.push(`${mark} ${cls} (${rows.length})`);
    for (const r of rows) {
      lines.push(`  - ${driftDetail(r)}`);
      const hint = hintFor.get(r.endpoint);
      if (cls === 'REMOVED_UNMAPPED' && hint) {
        lines.push(
          `      likely renamed to \`${hint.to}\` (similarity ${hint.score.toFixed(2)}). Drift mode ` +
            'does not absorb renames, so this stays a blocker until the pin is updated.'
        );
      }
    }
  }

  lines.push('');
  lines.push('not compared — the live catalog does not carry it:');
  lines.push(
    `  - response examples, so pricing.billing_field_present_in_response is carried forward ` +
      `unchanged for ${result.unobservableBillingField.length} metered endpoint(s)` +
      (result.unobservableBillingField.length
        ? `: ${result.unobservableBillingField.join(', ')}`
        : '') +
      '. Still gated against the pinned spec by `richapi-catalog-diff`.'
  );
  lines.push('  - deprecation flags, so the DEPRECATED class cannot fire here.');

  lines.push('');
  lines.push(
    result.blocking.length
      ? `${result.blocking.length} blocking drift(s): the pinned catalog no longer describes the ` +
          'server. Re-pin the spec and regenerate, or fix the routing, before this ships.'
      : 'No blocking drift. The pinned catalog still describes the server.'
  );
  return lines.join('\n');
}

/** The banner every no-network path prints. One shape, so it is greppable. */
export function formatSkip(reason, { liveLabel, strict }) {
  return [
    `catalog drift  SKIPPED — could not read the live catalog at ${liveLabel}`,
    `  reason: ${reason}`,
    strict
      ? '  --require-network was given, so this is a failure.'
      : '  No network is not a failure. The pinned catalog is unchanged and still authoritative;' +
        '\n  drift is simply UNKNOWN on this run, not absent. Re-run with network to check it.',
  ].join('\n');
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
  const known = new Set(['json', 'warn-only', 'require-network', 'help']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    if (known.has(key)) flags.add(key);
    else opts[key] = argv[++i];
  }
  return { flags, opts };
}

export async function main(argv = process.argv.slice(2), { fetchImpl } = {}) {
  const { flags, opts } = parseArgs(argv);
  if (flags.has('help')) {
    console.log(helpText());
    return 0;
  }

  // An explicit path is the caller's, so it resolves against their cwd; only the
  // default is repo-relative (same rule as bin/richapi-catalog-diff.mjs).
  const pinnedFile = opts.pinned
    ? path.resolve(opts.pinned)
    : path.resolve(ROOT, '_lib/api-catalog.json');
  const url = opts.url ?? process.env.RICHAPI_CATALOG_URL ?? DEFAULT_URL;
  const timeoutMs = Number(opts.timeout ?? process.env.RICHAPI_CATALOG_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const strict = flags.has('require-network');
  const liveLabel = opts.live ? path.relative(ROOT, path.resolve(opts.live)) : url;

  let pinned;
  try {
    pinned = JSON.parse(fs.readFileSync(pinnedFile, 'utf8'));
  } catch (err) {
    // A repo problem, not an outage. This one really is a failure.
    console.error(`error: cannot read pinned catalog ${path.relative(ROOT, pinnedFile)}: ${err.message}`);
    return 1;
  }

  let payload = null;
  let reason = null;
  if (opts.live) {
    // A local file the caller named. Unreadable is a typo or a missing fixture, not an
    // outage, so it fails rather than skipping — a silent pass from a mistyped --live
    // is the one way this tool could report "no drift" without looking at anything.
    try {
      payload = JSON.parse(fs.readFileSync(path.resolve(opts.live), 'utf8'));
    } catch (err) {
      console.error(`error: cannot read --live ${opts.live}: ${err.message}`);
      return 1;
    }
  } else {
    const got = await fetchLiveCatalog({ url, timeoutMs, fetchImpl });
    payload = got.payload;
    reason = got.error;
  }

  let result = null;
  if (payload) {
    try {
      result = driftCheck(pinned, payload);
    } catch (err) {
      if (!(err instanceof UnusableCatalogError)) throw err;
      reason = err.message;
    }
  }

  if (!result) {
    const code = strict && !flags.has('warn-only') ? 1 : 0;
    if (flags.has('json')) {
      console.log(JSON.stringify({ skipped: true, reason, live: liveLabel, exit_code: code }, null, 2));
    } else {
      console.log(formatSkip(reason ?? 'unknown', { liveLabel, strict }));
    }
    return code;
  }

  const pinnedLabel = path.relative(ROOT, pinnedFile);
  if (flags.has('json')) {
    console.log(
      JSON.stringify(
        {
          skipped: false,
          pinned: pinnedLabel,
          live: liveLabel,
          counts: result.counts,
          summary: result.summary,
          changes: result.changes,
          blocking: result.blocking.map((c) => ({ class: c.class, endpoint: c.endpoint })),
          not_compared: {
            billing_field_present_in_response: result.unobservableBillingField,
            deprecated: 'the live catalog carries no deprecation flag',
          },
          rename_hints: result.renameHints,
          exit_code: result.exitCode,
        },
        null,
        2
      )
    );
  } else {
    console.log(formatDriftReport(result, { pinnedLabel, liveLabel }));
  }
  return flags.has('warn-only') ? 0 : result.exitCode;
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
