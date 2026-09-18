// _lib/cache.mjs — the read-through cache.
//
// Checked BEFORE any paid call. Recurring research otherwise re-pays for data that
// changes quarterly: a weekly signal sweep over 500 accounts re-buys the same
// firmographics 13 times a year.
//
// Three things it is deliberately NOT:
//
//   Not a general KV store. The key is the exact request payload, so a cache hit
//   means "we already asked this API this exact question", never a fuzzy match.
//
//   Not TTL-free. Every row carries `source_endpoint` + `fetched_at` and is read back
//   through _lib/pii.mjs's per-endpoint TTL table, which fails closed: an endpoint nobody
//   classified gets the SHORTEST TTL, and ai_enrich gets 0 (never cached, because its
//   output is non-deterministic).
//
//   Not exempt from PII rules. It writes through `appendPiiRow`, so a row that cannot
//   name the endpoint it came from cannot be written at all. `/comply erase` sweeps it
//   and the TTL sweep expires it, both already implemented in _lib/pii.mjs.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { appendPiiRow, readPiiJsonl, isExpired, loadTtlTable, ttlForEndpoint } from './pii.mjs';
import { buildRequest } from './client.mjs';
import { billingVerdict } from './ledger.mjs';

/**
 * A RESPONSE THAT WAS NOT BILLED IS NOT AN ANSWER.
 *
 * Recorded live on 2026-09-17: email_finder answered 200 with
 * `{ok:false, billed:false, why:"2/5 providers returned an error — retry later"}`.
 * That went into the cache, and the NEXT run served it as `skipped_cache` — so a
 * transient provider outage became a permanent hole in the list, and the run then
 * planned paid email_verifier calls against rows that have no email.
 *
 * "Retry later" cannot be cached. It is checked on the way in AND on the way out,
 * because a cache poisoned by an earlier version of this code must still expire.
 */
function isRetryLater (response) {
  return billingVerdict(response, 200).billed === false;
}

export const CACHE_SUBDIR = 'enrichment-cache';

/** One file per endpoint, which is what the PII TTL sweep walks. */
export function cacheFile (root, dir, endpoint) {
  return path.join(path.resolve(root, dir), CACHE_SUBDIR, `${endpoint}.jsonl`);
}

/**
 * The cache key IS the request. Canonicalised (sorted keys, arrays preserved) so that
 * `{a:1,b:2}` and `{b:2,a:1}` are the same question, and hashed so the key itself
 * carries no contact data.
 */
export function cacheKey (payload) {
  const canon = (v) => {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((o, k) => { o[k] = canon(v[k]); return o; }, {});
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(canon(payload ?? {}))).digest('hex').slice(0, 32);
}

/** A cache that always misses. Used by --no-cache and by callers that pass no cache. */
export function nullCache (reason = 'cache disabled') {
  return {
    enabled: false, reason,
    has: () => false, get: () => null, put: () => null,
    stats: { hits: 0, misses: 0, writes: 0, expired: 0, not_billed: 0, endpoints: {} },
  };
}

/**
 * Read-through cache over `gtm/enrichment-cache/`.
 *
 * The index is loaded once per run. Rows are filtered through the TTL table at LOAD
 * time, so an expired row is a miss even if the sweep has not run yet — the sweep
 * reclaims disk, it is not what enforces freshness.
 */
export function createCache ({
  root = process.cwd(),
  dir = 'gtm',
  table = null,
  now = () => new Date(),
  enabled = true,
} = {}) {
  if (!enabled) return nullCache('--no-cache');

  // gates.yaml ships WITH the package, not with the user's project, so the policy is
  // read from here rather than from the caller's root (which is a GTM workspace).
  const shippedGates = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gates.yaml');
  const ttl = table || loadTtlTable({ root, gatesPath: shippedGates });
  const stats = { hits: 0, misses: 0, writes: 0, expired: 0, not_billed: 0, unusable: 0, endpoints: {} };
  const index = new Map(); // endpoint -> Map(key -> row)

  const bump = (endpoint, field) => {
    stats.endpoints[endpoint] ??= { hits: 0, misses: 0, writes: 0, expired: 0, not_billed: 0 };
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
      // Non-strict: an unattributed row is dropped, not fatal. A damaged cache must
      // degrade to a miss and cost credits, never wedge a run or serve unprovenanced PII.
      ({ rows } = readPiiJsonl(file, { strict: false }));
    } catch {
      stats.unusable += 1;
      return map;
    }
    const clock = now();
    for (const row of rows) {
      if (!row.key) continue;
      if (isExpired(row, { now: clock, table: ttl })) { bump(endpoint, 'expired'); map.delete(row.key); continue; }
      // Poisoned by an earlier run: a "retry later" body already on disk is a miss.
      if (isRetryLater(row.response)) { bump(endpoint, 'not_billed'); map.delete(row.key); continue; }
      map.set(row.key, row); // append-only: a later row for the same key wins
    }
    return map;
  };

  return {
    enabled: true,
    ttl_source: ttl.source,

    /** TTL for an endpoint, in ms. 0 means never cached. */
    ttlMs (endpoint) { return ttlForEndpoint(endpoint, ttl); },

    /** Would a call for this record hit? Used to build the plan descriptor. */
    has (endpoint, record) {
      if (ttlForEndpoint(endpoint, ttl) === 0) return false; // never-cache sentinel
      const req = buildRequest(endpoint, record);
      if (!req.ok) return false;
      return load(endpoint).has(cacheKey(req.payload));
    },

    /** The cached response for a record, or null. */
    get (endpoint, record) {
      if (ttlForEndpoint(endpoint, ttl) === 0) return null;
      const req = buildRequest(endpoint, record);
      if (!req.ok) return null;
      const row = load(endpoint).get(cacheKey(req.payload));
      if (!row) { bump(endpoint, 'misses'); return null; }
      bump(endpoint, 'hits');
      return row.response ?? null;
    },

    /**
     * Store a response. Silently declines for never-cache endpoints, so a caller
     * never has to know which those are.
     */
    put (endpoint, record, response) {
      if (ttlForEndpoint(endpoint, ttl) === 0) return null;
      if (isRetryLater(response)) { bump(endpoint, 'not_billed'); return null; }
      const req = buildRequest(endpoint, record);
      if (!req.ok) return null;
      const key = cacheKey(req.payload);
      const file = cacheFile(root, dir, endpoint);
      const stamped = appendPiiRow(file, { key, response: response ?? null }, { endpoint, now: now(), key });
      load(endpoint).set(key, stamped);
      bump(endpoint, 'writes');
      return stamped;
    },

    stats,
  };
}
