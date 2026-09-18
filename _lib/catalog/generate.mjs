// Catalog generation: spec bytes in, _lib/api-catalog.json out.
// The CLI shell lives in bin/richapi-catalog-gen.mjs; everything testable lives here.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { extractEndpoints } from './extract.mjs';
import { loadDigest, overlayDigest } from './live-maps.mjs';

export const SCHEMA_VERSION = 1;

/**
 * The shipped digest of recorded live responses. See _lib/catalog/live-maps.mjs for
 * why this is a digest under `_lib/` rather than a read of `tests/fixtures/live/`:
 * `tests/` is not in package.json `files`, so a generator that read the fixtures
 * directly would silently strip every live field map on a consumer's regen.
 */
export const LIVE_DIGEST_FILE = 'live-field-maps.json';

/**
 * Endpoints shipped disabled. Seeded, not derived: the spec has no vocabulary for
 * "this billing rule cannot be costed safely". Empty today.
 *
 * post_keyword_search was listed here while its x-pricing billed 6 credits per result
 * on `totalElements` (every match, not the page), so one call could not be bounded.
 * The spec re-priced it on 2026-09-17 to 0.1 credit per result on `numberOfElements`,
 * the page actually returned, which the page gate bounds like any other search.
 */
/*
 * NOT DISABLED, AND DO NOT RE-DISABLE IT: `profile_social_metrics`.
 *
 * It looks like a phantom in every curated artefact — the backend working copy's
 * generated endpoint manifest, its newer openapi.yaml, the endpoint-configuration
 * migrations, the MCP tool registry, the Postman collection, both SDKs, the docs and
 * the marketing site all omit it. An earlier audit read that as "not on the server" on
 * 2026-08-30 and disabled it. That was wrong: those are PRE-DEPLOYMENT / CURATED
 * artefacts, and the endpoint is an uncurated passthrough. It is live.
 *
 * Evidence from the RUNNING SERVER, 2026-08-30, both checks free (no key sent, and the
 * API bills 2xx only):
 *
 *   GET  https://api.richapi.ai/api/v1/catalog
 *        -> 200, {tools:[...68...], total:68}, and `profile_social_metrics` IS one of
 *           the 68 rows. Its `description` is the auto-generated
 *           "API endpoint: profile_social_metrics", which is exactly why the curated
 *           artefacts skip it — nobody wrote it a description, not nobody deployed it.
 *
 *   POST /api/v1/{name} with no Authorization header and body `{}`:
 *        profile_social_metrics -> 401   route exists, behind auth
 *        enrich_company         -> 401   control, known-good route
 *        company_enricher       -> 404   route absent (this one really was a phantom;
 *                                        it was removed from the spec in the same change)
 *
 * 401 means the router matched and auth rejected; 404 means no route. The endpoint is
 * routable, so it is a normal enabled endpoint here and stays claimed in
 * ../endpoint-owners.yaml. /evidence-score, /account-research and
 * /pre-meeting-briefing invoke it and were correct all along.
 *
 * Before disabling this again, re-run the two curls above. Absence from a curated
 * artefact is not absence from the wire (law 6: evidence over vibes).
 */
export const DISABLED_BY_DEFAULT = {};

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Parse the `<sha>  <name>` line shasum(1) writes. */
export function parseChecksumFile(text) {
  const m = /^([a-f0-9]{64})\s/i.exec(text.trim());
  if (!m) throw new Error('checksum file is not in `<sha256>  <filename>` form');
  return m[1].toLowerCase();
}

/**
 * Build the catalog object from raw spec bytes.
 * @param {Buffer|string} specBytes
 * @param {object} [opts]
 * @param {string} [opts.generatedAt] ISO timestamp to stamp (defaults to now)
 */
export function buildCatalog(specBytes, opts = {}) {
  const text = Buffer.isBuffer(specBytes) ? specBytes.toString('utf8') : specBytes;
  const doc = YAML.parse(text);
  const digest = opts.liveDigest ?? null;
  const { endpoints, warnings, stats } = extractEndpoints(doc, {
    disabledByDefault: DISABLED_BY_DEFAULT,
    // `billing_field_present_in_response` is an EVIDENCE flag: only a recorded 2xx body
    // can make it true. Without the digest every row fails closed to false.
    liveDigest: digest,
  });

  for (const name of Object.keys(DISABLED_BY_DEFAULT)) {
    if (!endpoints[name]) {
      warnings.push(`disabled-by-default seed "${name}" is not in the spec any more`);
    }
  }

  const specSha = sha256(Buffer.isBuffer(specBytes) ? specBytes : Buffer.from(text, 'utf8'));

  // Absorb recorded live responses over the spec-derived rows. This is the one place
  // the catalog stops describing what the spec CLAIMS and starts describing what the
  // server ANSWERED. Provenance-gated: a capture pinned to a different spec is
  // rejected with a reason rather than folded in (law 6).
  let finalEndpoints = endpoints;
  let absorbedStats = { absorbed: [], rejected: [] };
  if (digest) {
    const res = overlayDigest(endpoints, digest, { specSha256: specSha });
    finalEndpoints = res.endpoints;
    absorbedStats = { absorbed: res.absorbed, rejected: res.rejected };
    for (const r of res.rejected) {
      warnings.push(`live capture not absorbed for ${r.endpoint}: ${r.reason}`);
    }
  }

  const catalog = {
    schema_version: SCHEMA_VERSION,
    generated_at: opts.generatedAt ?? new Date().toISOString(),
    spec_sha256: specSha,
    spec_version: String(doc?.info?.version ?? 'unknown'),
    endpoints: finalEndpoints,
  };
  return {
    catalog,
    warnings,
    stats: { ...stats, live_absorbed: absorbedStats.absorbed, live_rejected: absorbedStats.rejected },
  };
}

/** Stable serialisation. Key order is fixed by construction; this only adds newline + indent. */
export function serialize(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function withoutTimestamp(catalog) {
  const { generated_at, ...rest } = catalog;
  return JSON.stringify(rest);
}

/**
 * Reuse the previous `generated_at` when nothing else changed.
 *
 * This is what makes the catalog-is-current CI check true for a real invocation and not only for
 * a test that pins the clock: regenerating an unchanged spec produces byte-identical
 * output, so `git diff` after `npm run catalog:gen` is empty unless the API actually
 * moved. Without it every run would churn one line and train people to ignore the diff.
 */
export function stabilizeTimestamp(next, previous) {
  if (!previous) return next;
  if (withoutTimestamp(next) !== withoutTimestamp(previous)) return next;
  if (typeof previous.generated_at !== 'string') return next;
  return { ...next, generated_at: previous.generated_at };
}

export function readCatalogIfPresent(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Load spec bytes, preferring a URL when one is given and falling back to the pinned
 * local file. Never throws on a network problem — LAW: offline must not wedge.
 * @returns {{bytes: Buffer|null, source: string, warnings: string[]}}
 */
export async function loadSpec({ specFile, specUrl, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  const warnings = [];
  if (specUrl) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      let res;
      try {
        res = await fetchImpl(specUrl, { signal: ac.signal });
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, source: specUrl, warnings };
    } catch (err) {
      warnings.push(`spec fetch failed (${err.message}); falling back to pinned ${specFile}`);
    }
  }
  try {
    return { bytes: fs.readFileSync(specFile), source: specFile, warnings };
  } catch (err) {
    warnings.push(`pinned spec unreadable (${err.message})`);
    return { bytes: null, source: specFile, warnings };
  }
}

/**
 * Full generation run.
 * @returns {Promise<{code: number, wrote: boolean, warnings: string[], errors: string[], stats: object|null, catalog: object|null}>}
 */
export async function run({
  specFile,
  checksumFile,
  outFile,
  specUrl = null,
  allowShaMismatch = false,
  generatedAt = null,
  write = true,
  fetchImpl = globalThis.fetch,
  liveDigestFile = null,
} = {}) {
  const warnings = [];
  const errors = [];
  const previous = readCatalogIfPresent(outFile);

  const loaded = await loadSpec({ specFile, specUrl, fetchImpl });
  warnings.push(...loaded.warnings);

  if (!loaded.bytes) {
    // Offline / unreachable / missing. Keep the cache, warn, never wedge.
    if (previous) {
      warnings.push(`keeping cached catalog ${outFile} (generated ${previous.generated_at})`);
      return { code: 0, wrote: false, warnings, errors, stats: null, catalog: previous };
    }
    errors.push('no spec and no cached catalog to fall back to');
    return { code: 1, wrote: false, warnings, errors, stats: null, catalog: null };
  }

  const actualSha = sha256(loaded.bytes);
  if (checksumFile) {
    let expected = null;
    try {
      expected = parseChecksumFile(fs.readFileSync(checksumFile, 'utf8'));
    } catch (err) {
      warnings.push(`checksum file unusable (${err.message}); skipping pin verification`);
    }
    if (expected && expected !== actualSha) {
      const msg =
        `spec sha256 mismatch: pinned ${expected}, got ${actualSha} from ${loaded.source}. ` +
        `The pin exists so a silent upstream edit cannot reprice the pack.`;
      if (allowShaMismatch) {
        warnings.push(`${msg} (--allow-sha-mismatch given, continuing)`);
      } else {
        errors.push(msg);
        // Integrity failure, not an outage: the cached catalog stays valid and usable,
        // so the pack keeps working while a human resolves the pin.
        if (previous) warnings.push(`cached catalog ${outFile} left intact`);
        return { code: 1, wrote: false, warnings, errors, stats: null, catalog: previous };
      }
    }
  }

  // A digest file that is NAMED but unreadable is a different thing from one that was
  // never asked for: the first means the live evidence went missing, and regenerating
  // silently without it would strip every live field map from a working catalog.
  let liveDigest = null;
  if (liveDigestFile) {
    liveDigest = loadDigest(liveDigestFile);
    if (!liveDigest) {
      warnings.push(
        `live field-map digest ${liveDigestFile} is missing or unreadable — regenerating from the SPEC ALONE. `
        + 'Every live-captured response shape will be dropped from the catalog. '
        + 'Rebuild it with `richapi catalog gen --absorb-live` from a checkout that has tests/fixtures/live/.'
      );
    }
  }

  const built = buildCatalog(loaded.bytes, {
    generatedAt: generatedAt ?? undefined,
    liveDigest,
  });
  warnings.push(...built.warnings);
  const catalog = stabilizeTimestamp(built.catalog, previous);
  const text = serialize(catalog);

  let wrote = false;
  if (write) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const before = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : null;
    if (before !== text) {
      fs.writeFileSync(outFile, text);
      wrote = true;
    }
  }
  return { code: 0, wrote, warnings, errors, stats: built.stats, catalog };
}
