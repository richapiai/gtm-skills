// _lib/catalog/live-maps.mjs — absorb recorded live captures into the catalog.
//
// WHY THIS FILE EXISTS
//
// Law 2: the spec is a cost-and-route source, NOT a schema source. Until 2026-08-31
// that left `field_map: null` on all 68 endpoints and `field_map_keys` derived from
// spec examples that are largely the literal string "example". The capture harness has
// since recorded 55 real responses, and reading them settled a question the spec had
// been answering wrongly:
//
//   email_finder   spec example says {confidence, email, provider}
//                  the SERVER answers {success, result:{email,...}, provider,
//                  providers_tried, execution_log}
//
// The map read `body.email`. The server puts it at `body.result.email`. So a paid
// 5-credit call delivered the provider name and threw the email away — the
// same zero-yield failure again, in a place the zero-column detector could not see because `provider`
// happened to match. Same shape on email_verifier (0 of 5 columns) and phone_finder
// (0 of 2, at 25 credits a call).
//
// SHIPPING BOUNDARY — the reason this is a digest and not a fixture read.
//
// The raw captures live in tests/fixtures/live/, which package.json `files` does NOT
// ship. A consumer who runs `richapi catalog gen` from an npm install therefore has no
// fixtures, and a generator that read them directly would silently regenerate a
// catalog with every live field map REMOVED — turning a working install back into the
// broken one, with no error. So the captures are distilled once into
// `_lib/live-field-maps.json`, which ships under `_lib/`, and the generator reads only
// that. `--absorb-live` rebuilds the digest and is a maintainer command.
//
// PROVENANCE IS ENFORCED, NOT ASSUMED.
//
// A capture is absorbed only when its `spec_sha256` matches the spec the catalog is
// being generated from. A recording made against a different spec is evidence about a
// different API, and silently folding it in would be exactly the "fabricate an actual"
// failure law 4 forbids — one level up, on the schema instead of the charge.

import fs from 'node:fs';
import path from 'node:path';

/** Status a row carries once a real response has been recorded for it. */
export const LIVE_STATUS = 'live_fixture';

/** Marker written on every digest row so its origin is never inferred. */
export const LIVE_SOURCE = 'live_capture';

export const DIGEST_SCHEMA_VERSION = 1;

/**
 * Flatten a recorded response body into dotted paths pointing at SCALARS only.
 *
 * Arrays are indexed (`positionGroups.0.company.name`) because that is how the runtime
 * reads them, and an index is honest about being positional. Objects recurse. Arrays
 * of scalars stop at the array itself — a list is not a column.
 *
 * `maxDepth` exists so a deeply recursive response cannot make the digest unbounded;
 * every real shape in the corpus resolves well inside it.
 */
export function scalarPaths (value, { maxDepth = 6, prefix = '', out = {} } = {}) {
  if (maxDepth < 0) return out;
  if (value === null || value === undefined) return out;
  if (typeof value !== 'object') {
    if (prefix) out[prefix] = typeof value;
    return out;
  }
  if (Array.isArray(value)) {
    // Only the first element is described. A capture is one sample: claiming anything
    // about element 7 from a recording that had three is inventing a schema.
    //
    // An array of SCALARS is indexed too — `industries.0` is the company's industry and
    // `specialities.0` its first speciality, both real, both useful, both recorded. The
    // index is honest about being positional, which is the whole reason it is written
    // as `.0` rather than flattened into a bare name that hides the ordering.
    if (value.length === 0) return out;
    const first = value[0];
    if (first === null || first === undefined) return out;
    if (typeof first === 'object') {
      scalarPaths(first, { maxDepth: maxDepth - 1, prefix: `${prefix}.0`, out });
    } else if (prefix) {
      out[`${prefix}.0`] = typeof first;
    }
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    scalarPaths(v, { maxDepth: maxDepth - 1, prefix: prefix ? `${prefix}.${k}` : k, out });
  }
  return out;
}

/**
 * The envelope key a body wraps its payload in, or null when it does not wrap.
 *
 * Recorded, never guessed: `result` is what email_finder, email_verifier and
 * phone_finder actually answer with; `data` is the shape the spec documents elsewhere.
 * An endpoint that wraps in neither returns null and is read at the top level.
 */
export function detectEnvelope (body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  for (const key of ['result', 'data']) {
    const v = body[key];
    if (v && typeof v === 'object' && !Array.isArray(v)) return key;
  }
  return null;
}

/**
 * Build one digest row from a raw capture.
 * @returns {object|null} null when the capture is not usable as evidence.
 */
export function digestRow (endpoint, capture) {
  if (!capture || typeof capture !== 'object') return null;
  // Any 2xx is a successful, billed answer: the scrapers answer 201.
  const status = Number(capture.http_status);
  if (!(status >= 200 && status < 300)) return null;
  let body = capture.body;
  if (!body || typeof body !== 'object') return null;

  // A bare array (the bulk endpoints) is described by its first element, whose field
  // names are the single endpoint's. `array` records that the runtime reads it as rows.
  let envelope;
  if (Array.isArray(body)) {
    const first = body.find((x) => x && typeof x === 'object' && !Array.isArray(x));
    if (!first) return null;
    body = first;
    envelope = 'array';
  } else {
    envelope = detectEnvelope(body);
  }
  const types = scalarPaths(body);
  const paths = Object.keys(types).sort();
  if (paths.length === 0) return null;

  return {
    endpoint,
    envelope,
    top_level_keys: Object.keys(body).sort(),
    scalar_paths: paths,
    observed_types: Object.fromEntries(paths.map((p) => [p, types[p]])),
    captured_at: capture.captured_at ?? null,
    spec_sha256: capture.spec_sha256 ?? null,
    source: LIVE_SOURCE,
  };
}

/**
 * Build the whole digest from a directory of raw captures.
 *
 * `specSha256` is required: a digest that does not record which spec its captures were
 * taken against cannot be checked for staleness later, and an uncheckable provenance
 * claim is worth nothing.
 */
export function buildDigest (capturesDir, { specSha256, now = () => new Date().toISOString() } = {}) {
  if (!specSha256) throw new Error('buildDigest requires specSha256 — a capture with no spec pin is not evidence');
  const endpoints = {};
  const skipped = [];
  if (!fs.existsSync(capturesDir)) {
    return { schema_version: DIGEST_SCHEMA_VERSION, built_at: now(), spec_sha256: specSha256, endpoints, skipped };
  }
  for (const file of fs.readdirSync(capturesDir).sort()) {
    if (!file.endsWith('.json')) continue;
    const name = file.replace(/\.json$/, '');
    if (name === 'capture-report' || name === 'sample-inputs') continue;
    let capture;
    try {
      capture = JSON.parse(fs.readFileSync(path.join(capturesDir, file), 'utf8'));
    } catch (err) {
      skipped.push({ endpoint: name, reason: `unreadable capture (${err.message})` });
      continue;
    }
    if (capture.spec_sha256 && capture.spec_sha256 !== specSha256) {
      skipped.push({ endpoint: name, reason: 'captured against a different spec sha256' });
      continue;
    }
    const row = digestRow(name, capture);
    if (!row) {
      skipped.push({ endpoint: name, reason: 'no usable 2xx body' });
      continue;
    }
    endpoints[name] = row;
  }
  return { schema_version: DIGEST_SCHEMA_VERSION, built_at: now(), spec_sha256: specSha256, endpoints, skipped };
}

/** Read a digest from disk, or null when absent/unreadable. Never throws. */
export function loadDigest (file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return d && typeof d === 'object' && d.endpoints ? d : null;
  } catch {
    return null;
  }
}

/**
 * Overlay a digest onto generated catalog endpoints, in place on a copy.
 *
 * Only rows whose capture matches `specSha256` are absorbed. Everything else keeps the
 * spec-derived state it already had, so a stale digest degrades to the previous
 * behaviour rather than to a wrong one.
 *
 * @returns {{endpoints: object, absorbed: string[], rejected: Array<{endpoint:string,reason:string}>}}
 */
export function overlayDigest (endpoints, digest, { specSha256 } = {}) {
  const out = {};
  for (const [k, v] of Object.entries(endpoints)) out[k] = { ...v };
  const absorbed = [];
  const rejected = [];
  if (!digest) return { endpoints: out, absorbed, rejected };

  if (specSha256 && digest.spec_sha256 && digest.spec_sha256 !== specSha256) {
    rejected.push({ endpoint: '*', reason: `digest was built against spec ${digest.spec_sha256.slice(0, 12)}…, catalog is ${String(specSha256).slice(0, 12)}…` });
    return { endpoints: out, absorbed, rejected };
  }

  for (const [name, row] of Object.entries(digest.endpoints ?? {})) {
    if (!out[name]) {
      rejected.push({ endpoint: name, reason: 'captured endpoint is not in the spec any more' });
      continue;
    }
    if (specSha256 && row.spec_sha256 && row.spec_sha256 !== specSha256) {
      rejected.push({ endpoint: name, reason: 'capture pins a different spec sha256' });
      continue;
    }
    out[name] = {
      ...out[name],
      // The mapping itself stays the runtime's business (RESPONSE_MAPS); what the
      // catalog publishes is the OBSERVED SHAPE, which is the evidence a map is
      // checked against. Publishing a map here would put two sources of truth for the
      // same decision in the tree.
      field_map: null,
      field_map_status: LIVE_STATUS,
      field_map_keys: row.scalar_paths,
      field_map_keys_source: LIVE_SOURCE,
      live_envelope: row.envelope,
      live_top_level_keys: row.top_level_keys,
      live_observed_types: row.observed_types,
      live_captured_at: row.captured_at,
    };
    absorbed.push(name);
  }
  absorbed.sort();
  return { endpoints: out, absorbed, rejected };
}

export default { scalarPaths, detectEnvelope, digestRow, buildDigest, loadDigest, overlayDigest, LIVE_STATUS, LIVE_SOURCE, DIGEST_SCHEMA_VERSION };
