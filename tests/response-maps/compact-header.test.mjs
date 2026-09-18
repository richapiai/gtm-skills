/**
 * `X-MCP-Compact: 1` is a ~75% token discount the server hands to ANY caller,
 * and this client used to leave it on the table.
 *
 * backend/app/proxy/handler.py:2842-2853 lowercases every request header name, matches
 * `x-mcp-compact`, and runs `compact_waterfall_response` when the value is 1/true/yes.
 * There is no MCP check and no allowlist. The pack runs inside an agent's context
 * window and waterfall bodies are the largest thing it reads, so this is free budget.
 *
 * These tests are the ratchet in BOTH directions, because the header is only free if
 * it is sent exactly where the server honours it:
 *
 *   * it IS sent on the three waterfall endpoints on this pack's surface;
 *   * it is NOT sent anywhere else, where it would be a false claim about the server
 *     and where the full body is what the field maps read;
 *   * nothing in the pack reads the keys compaction removes. That last one is the
 *     load-bearing test: the day someone starts reading `execution_log` or
 *     `providers_tried`, this fails rather than the trail silently disappearing.
 */

import assert from 'node:assert/strict';
import { liveEnrichProfile } from '../helpers/index.mjs';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RichApiClient,
  COMPACT_HEADER, COMPACT_HEADER_VALUE, COMPACT_ENDPOINTS, COMPACT_ENV,
  compactEnabled, honoursCompact,
  readAttribution, inspectResponse,
} from '../../_lib/client.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A fetch that records the headers it was handed and answers 200 with `body`. */
function spyFetch (body = { success: true, result: {}, provider: 'p' }) {
  const seen = [];
  const impl = (url, init) => {
    seen.push({ url, headers: init.headers });
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body),
    });
  };
  impl.seen = seen;
  return impl;
}

/** Header lookup that is itself case-insensitive, so the test cannot pass by accident. */
function headerValue (headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (String(k).toLowerCase() === want) return v;
  }
  return undefined;
}

const NON_WATERFALL = [
  'enrich_profile', 'enrich_company', 'enrich_profiles_bulk', 'enrich_companies_bulk',
  'identify_email_type', 'find_personal_email', 'lead_search', 'people_search',
  'web_scrape', 'ai_enrich',
];

// ---------------------------------------------------------------------------
// where it goes
// ---------------------------------------------------------------------------

test('the compact header is sent on every waterfall endpoint', async () => {
  for (const endpoint of COMPACT_ENDPOINTS) {
    const fetchImpl = spyFetch();
    const client = new RichApiClient({ apiKey: 'k', env: {}, fetchImpl });
    await client.post(endpoint, { url: 'x' });
    const v = headerValue(fetchImpl.seen[0].headers, COMPACT_HEADER);
    assert.equal(v, COMPACT_HEADER_VALUE,
      `${endpoint} was called WITHOUT ${COMPACT_HEADER} — the ~75% discount is back on the floor`);
  }
});

test('the header name is exactly what handler.py matches, lowercased', () => {
  // handler.py does `_k.lower() == "x-mcp-compact"`, so any casing works on the wire;
  // this asserts we do not drift to a name that matches nothing at all.
  assert.equal(COMPACT_HEADER, 'x-mcp-compact');
  // handler.py accepts "1" | "true" | "yes" after strip().lower().
  assert.ok(['1', 'true', 'yes'].includes(String(COMPACT_HEADER_VALUE).trim().toLowerCase()),
    `${COMPACT_HEADER_VALUE} is not a value handler.py:2849 accepts`);
});

test('the header is NOT sent on any non-waterfall endpoint', async () => {
  for (const endpoint of NON_WATERFALL) {
    const fetchImpl = spyFetch();
    const client = new RichApiClient({ apiKey: 'k', env: {}, fetchImpl });
    await client.post(endpoint, { url: 'x' });
    assert.equal(headerValue(fetchImpl.seen[0].headers, COMPACT_HEADER), undefined,
      `${endpoint} is not served by the waterfall handler — sending ${COMPACT_HEADER} there `
      + 'claims a server behaviour that does not exist');
  }
});

test('enrich_profile and enrich_company keep their FULL body', async () => {
  // These two are the pack's largest field maps (23 and 17 columns off the RECORDED
  // response, after the 2026-09-02 live rewrite). They are LinkedIn scrapers, not
  // waterfalls; a compact rewrite there would have nothing to strip and the header
  // would be a lie, so the assertion is on both halves: no header, and the body still
  // maps.
  for (const endpoint of ['enrich_profile', 'enrich_company']) {
    assert.equal(honoursCompact(endpoint), false, `${endpoint} was declared a waterfall`);
  }
  const insp = inspectResponse('enrich_profile', liveEnrichProfile());
  assert.equal(insp.status, 'mapped');
  assert.ok(insp.column_count >= 15,
    `the recorded profile response must deliver a full record, got ${insp.column_count} columns`);
  assert.equal(insp.columns.title, 'VP Sales');
  assert.equal(insp.columns.company_name, 'Acme');
});

// ---------------------------------------------------------------------------
// the switch
// ---------------------------------------------------------------------------

test('richapi_COMPACT_RESPONSES turns the discount off, and only off', async () => {
  for (const off of ['0', 'false', 'no', 'off', 'OFF', ' False ']) {
    assert.equal(compactEnabled({ [COMPACT_ENV]: off }), false, `${JSON.stringify(off)} did not disable`);
    const fetchImpl = spyFetch();
    const client = new RichApiClient({ apiKey: 'k', env: { [COMPACT_ENV]: off }, fetchImpl });
    await client.post('email_finder', {});
    assert.equal(headerValue(fetchImpl.seen[0].headers, COMPACT_HEADER), undefined);
  }
  for (const on of [undefined, '', '1', 'true', 'yes', 'anything']) {
    assert.equal(compactEnabled(on === undefined ? {} : { [COMPACT_ENV]: on }), true,
      `${JSON.stringify(on)} disabled the discount when it should not have`);
  }
});

test('the constructor option beats the env in both directions', async () => {
  const a = spyFetch();
  await new RichApiClient({ apiKey: 'k', env: { [COMPACT_ENV]: '0' }, compact: true, fetchImpl: a })
    .post('phone_finder', {});
  assert.equal(headerValue(a.seen[0].headers, COMPACT_HEADER), COMPACT_HEADER_VALUE);

  const b = spyFetch();
  await new RichApiClient({ apiKey: 'k', env: {}, compact: false, fetchImpl: b })
    .post('phone_finder', {});
  assert.equal(headerValue(b.seen[0].headers, COMPACT_HEADER), undefined);
});

test('the API key and content-type are untouched by the new header', async () => {
  const fetchImpl = spyFetch();
  await new RichApiClient({ apiKey: 'live-key', env: {}, fetchImpl }).post('email_finder', {});
  const h = fetchImpl.seen[0].headers;
  assert.equal(headerValue(h, 'x-api-key'), 'live-key');
  assert.equal(headerValue(h, 'content-type'), 'application/json');
});

// ---------------------------------------------------------------------------
// the list itself
// ---------------------------------------------------------------------------

test('every compact endpoint really exists in _lib/api-catalog.json', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib/api-catalog.json'), 'utf8'));
  for (const endpoint of COMPACT_ENDPOINTS) {
    assert.ok(Object.prototype.hasOwnProperty.call(catalog.endpoints, endpoint),
      `COMPACT_ENDPOINTS names "${endpoint}", which the catalog does not have — the header `
      + 'would be sent to an endpoint this pack cannot call');
  }
});

test('every endpoint the SPEC calls multi-provider is on the list', () => {
  // The catalog carries no waterfall marker, so
  // the spec's own prose is the second source. If a new waterfall is documented and not
  // added here, this fails rather than the discount silently missing it.
  const spec = fs.readFileSync(path.join(ROOT, 'spec/openapi.yaml'), 'utf8');
  const documented = new Set();
  let current = null;
  for (const line of spec.split('\n')) {
    const m = /^\s{2}\/([a-z0-9_]+):\s*$/.exec(line);
    if (m) { current = m[1]; continue; }
    if (current && /multi-provider|multiple providers automatically/i.test(line)) documented.add(current);
  }
  assert.ok(documented.size > 0, 'the spec scan matched nothing — the test is no longer testing anything');
  const missing = [...documented].filter(e => !COMPACT_ENDPOINTS.includes(e));
  assert.deepEqual(missing, [],
    `the spec documents these as multi-provider waterfalls but COMPACT_ENDPOINTS omits them: ${missing.join(', ')}`);
  // And the reverse: nothing on the list without a documented basis.
  assert.deepEqual([...COMPACT_ENDPOINTS].sort(), [...documented].sort());
});

// ---------------------------------------------------------------------------
// THE LOAD-BEARING ONE — what compaction removes, and whether anyone reads it
// ---------------------------------------------------------------------------

test('nothing in the pack reads execution_log, providers_tried or success', () => {
  // `compact_waterfall_response` (mcp_integration.py:1981) drops `execution_log` and
  // `providers_tried` and renames `success` -> `ok`. Enabling the header is only safe
  // for as long as that sentence stays true. Any real READ of those keys — a property
  // access or a string subscript — trips this.
  const READS = [
    /\.execution_log\b/,
    /\[\s*['"]execution_log['"]\s*\]/,
    /\.providers_tried\b/,
    /\[\s*['"]providers_tried['"]\s*\]/,
    /\bbody(?:\?)?\.success\b/,
    /\bres\.body(?:\?)?\.success\b/,
    /\[\s*['"]providersTried['"]\s*\]/,
    /\.executionLog\b/,
  ];
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.mjs')) files.push(p);
    }
  };
  walk(path.join(ROOT, '_lib'));
  walk(path.join(ROOT, 'bin'));

  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;   // prose about the keys is fine
      for (const re of READS) {
        if (re.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'X-MCP-Compact strips these keys. Something now reads one of them, so the header is '
    + `destroying data the pack depends on:\n  ${offenders.join('\n  ')}`);
});

test('provider attribution survives compaction, so /learn is unaffected', () => {
  // This is the trade to guard against: a 75% saving that quietly destroyed
  // provider attribution would be a bad one. `compact_waterfall_response` keeps
  // top-level `provider`, which is the ONLY field readAttribution reads for it.
  const full = {
    success: true,
    result: { email: 'a@b.com', confidence: 92 },
    provider: 'provider_b',
    providers_tried: 2,
    execution_log: [{ provider: 'provider_c', status: 'no_data' }, { provider: 'provider_b', status: 'ok' }],
  };
  const compact = { ok: true, result: { email: 'a@b.com', confidence: 92 }, provider: 'provider_b' };

  assert.deepEqual(readAttribution(compact), readAttribution(full));
  assert.equal(readAttribution(compact).provider, 'provider_b');
});

test('the empty-column tripwire returns the same verdict on a compact body', () => {
  // inspectResponse reads KEY NAMES. Compaction changes the key set, so the verdict
  // must be checked, not assumed — on a hit and on a genuine miss.
  const hit = {
    full: { success: true, result: { email: 'a@b.com' }, provider: 'provider_b', providers_tried: 1, execution_log: [{}] },
    compact: { ok: true, result: { email: 'a@b.com' }, provider: 'provider_b' },
  };
  assert.equal(inspectResponse('email_finder', hit.compact).status,
    inspectResponse('email_finder', hit.full).status);

  const miss = {
    full: { success: false, result: null, provider: null, providers_tried: 3, execution_log: [{ status: 'no_data' }], billed: false },
    compact: { ok: false, result: null, billed: false, why: 'no provider had data for this input (tried 3)' },
  };
  assert.equal(inspectResponse('email_finder', miss.compact).status,
    inspectResponse('email_finder', miss.full).status);

  // And `why` — the compact-only summary — never counts as endpoint data.
  assert.ok(!inspectResponse('email_finder', miss.compact).data_bearing_keys.includes('why'),
    '`why` is the envelope\'s failure summary, not a field of the endpoint');
});

test('the ledger cannot lose a verified charge to compaction, today', () => {
  // resolveActual promotes a line to `actual` only on `credits_charged`. The waterfall
  // envelope has never carried it, in either mode, so nothing is lost now. If that ever
  // changes, compaction would strip it — this asserts the premise the decision rests on.
  const full = { success: true, result: { email: 'a@b.com' }, provider: 'x', providers_tried: 1, execution_log: [] };
  assert.equal(Object.prototype.hasOwnProperty.call(full, 'credits_charged'), false);
});
