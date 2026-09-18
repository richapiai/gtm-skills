// Verify: the TTL sweep removes expired enrichment-cache rows and keeps fresh
// ones; an unknown endpoint gets the SHORTEST TTL (fail closed), never the longest.
// Plus: every PII artifact carries source endpoint + fetched_at, enforced by the
// writer and the reader.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp, write, jsonl, DAY, ago } from './helpers.mjs';
import {
  sweepEnrichmentCache, ttlForEndpoint, shortestTtlMs, loadTtlTable, isExpired,
  DEFAULT_TTL_CLASSES, stampPii, assertPiiProvenance, appendPiiRow, readPiiJsonl,
  PiiProvenanceError, parseDuration, parseSimpleYaml,
} from '../../_lib/pii.mjs';

test.after(cleanupTmp);

const NOW = new Date('2026-08-28T12:00:00.000Z');

// --- provenance ------------------------------------------------------------

test('a PII record cannot be written without its source endpoint', () => {
  assert.throws(() => stampPii({ email: 'bob@acme.com' }, {}), PiiProvenanceError);
  assert.throws(() => stampPii({ email: 'bob@acme.com' }, { endpoint: '   ' }), PiiProvenanceError);
  const r = stampPii({ email: 'bob@acme.com' }, { endpoint: 'email_finder', now: NOW });
  assert.equal(r.source_endpoint, 'email_finder');
  assert.equal(r.fetched_at, NOW.toISOString());
  assertPiiProvenance(r);
});

test('the reader refuses PII rows that lack provenance', () => {
  const root = tmpRoot('compliance-prov-');
  const f = join(root, 'gtm', 'enrichment-cache', 'email_finder.jsonl');
  appendPiiRow(f, { email: 'bob@acme.com' }, { endpoint: 'email_finder', now: NOW });
  assert.equal(readPiiJsonl(f).rows.length, 1);

  write(root, 'gtm/enrichment-cache/legacy.jsonl', jsonl([{ email: 'bob@acme.com' }]));
  const legacy = join(root, 'gtm', 'enrichment-cache', 'legacy.jsonl');
  assert.throws(() => readPiiJsonl(legacy), PiiProvenanceError);
  assert.equal(readPiiJsonl(legacy, { strict: false }).unprovenanced.length, 1);
});

// --- TTL table -------------------------------------------------------------

test('the default TTL table is the four documented classes plus a fail-closed floor', () => {
  assert.equal(DEFAULT_TTL_CLASSES.firmographics, 90 * DAY);
  assert.equal(DEFAULT_TTL_CLASSES.funding_tech, 30 * DAY);
  assert.equal(DEFAULT_TTL_CLASSES.email_verification, 7 * DAY);
  assert.equal(DEFAULT_TTL_CLASSES.posts_activity, 1 * DAY);
  assert.equal(DEFAULT_TTL_CLASSES.unknown, 1 * DAY);
});

test('an UNKNOWN endpoint gets the SHORTEST TTL, not the longest', () => {
  const t = loadTtlTable({ gatesPath: '/nonexistent/gates.yaml' });
  assert.equal(t.source, 'defaults');
  const shortest = shortestTtlMs(t);
  assert.equal(shortest, 1 * DAY);
  assert.equal(ttlForEndpoint('some_endpoint_added_next_quarter', t), shortest);
  assert.equal(ttlForEndpoint('', t), shortest);
  assert.equal(ttlForEndpoint(undefined, t), shortest);
  // and it is genuinely shorter than every classified endpoint
  assert.ok(ttlForEndpoint('enrich_company', t) > shortest);
  assert.equal(ttlForEndpoint('enrich_company', t), 90 * DAY);
  assert.equal(ttlForEndpoint('web_tech_stack', t), 30 * DAY);
  assert.equal(ttlForEndpoint('email_verifier', t), 7 * DAY);
  assert.equal(ttlForEndpoint('linkedin_company_posts', t), 1 * DAY);
});

test('gates.yaml overrides the defaults when it parses; defaults when it does not', () => {
  const root = tmpRoot('compliance-gates-');
  const p = write(root, '_lib/gates.yaml', [
    '# Spend and retention gates.',
    'session_budget: 500',
    'cache_ttl:',
    '  classes:',
    '    firmographics: 45d',
    '    funding_tech: 30d',
    '    email_verification: 7d',
    '    posts_activity: 12h',
    '  endpoints:',
    '    enrich_company: firmographics',
    '    phone_finder: 3d',
    '',
  ].join('\n'));
  const t = loadTtlTable({ gatesPath: p });
  assert.equal(t.source, p);
  assert.equal(ttlForEndpoint('enrich_company', t), 45 * DAY);
  assert.equal(ttlForEndpoint('phone_finder', t), 3 * DAY);
  assert.equal(ttlForEndpoint('linkedin_company_posts', t), 12 * 3600_000);
  // the fail-closed floor survives a policy file
  assert.equal(ttlForEndpoint('brand_new_endpoint', t), shortestTtlMs(t));
  assert.ok(shortestTtlMs(t) <= 12 * 3600_000);

  // This fixture used to be `classes: &anchor`, because the original hand-rolled
  // reader threw on anchors. That reader was replaced with the real `yaml` package
  // (it was throwing on the ACTUAL gates.yaml and silently
  // discarding the whole policy). `yaml` parses anchors fine, so the old fixture no
  // longer proved anything. The assertion below is unchanged; only the fixture is,
  // to something genuinely malformed.
  const bad = write(root, '_lib/broken.yaml', 'cache_ttl:\n\tclasses:\n\t\tx: 1\n');
  const t2 = loadTtlTable({ gatesPath: bad });
  assert.equal(t2.source, 'defaults', 'an unparseable policy file must never widen a TTL');
  assert.match(t2.notes.join(' '), /unparseable/);

  const noBlock = write(root, '_lib/nottl.yaml', 'session_budget: 500\n');
  assert.equal(loadTtlTable({ gatesPath: noBlock }).source, 'defaults');
});

test('duration + minimal YAML parsing', () => {
  assert.equal(parseDuration('90d'), 90 * DAY);
  assert.equal(parseDuration('7 d'), 7 * DAY);
  assert.equal(parseDuration('36h'), 36 * 3600_000);
  assert.equal(parseDuration(3600), 3600_000);
  assert.equal(parseDuration('nonsense'), null);
  const y = parseSimpleYaml('a:\n  b: 1\n  c: "x"  # comment\nd: true\n');
  assert.deepEqual(y, { a: { b: 1, c: 'x' }, d: true });
});

// --- the sweep -------------------------------------------------------------

test('sweep drops expired rows and keeps fresh ones, per endpoint', () => {
  const root = tmpRoot('compliance-sweep-');
  write(root, 'gtm/enrichment-cache/enrich_company.jsonl', jsonl([
    { source_endpoint: 'enrich_company', fetched_at: ago(NOW, 10 * DAY), key: 'acme.com', data: { size: 200 } },
    { source_endpoint: 'enrich_company', fetched_at: ago(NOW, 100 * DAY), key: 'stale.com', data: { size: 5 } },
  ]));
  write(root, 'gtm/enrichment-cache/linkedin_company_posts.jsonl', jsonl([
    { source_endpoint: 'linkedin_company_posts', fetched_at: ago(NOW, 2 * 3600_000), key: 'acme', data: {} },
    { source_endpoint: 'linkedin_company_posts', fetched_at: ago(NOW, 2 * DAY), key: 'old', data: {} },
  ]));
  write(root, 'gtm/enrichment-cache/email_verifier.jsonl', jsonl([
    { source_endpoint: 'email_verifier', fetched_at: ago(NOW, 3 * DAY), key: 'bob@acme.com', data: { valid: true } },
    { source_endpoint: 'email_verifier', fetched_at: ago(NOW, 8 * DAY), key: 'old@acme.com', data: { valid: true } },
  ]));

  const r = sweepEnrichmentCache({ root, now: NOW });
  assert.equal(r.rows_kept, 3);
  assert.equal(r.rows_expired, 3);
  assert.equal(r.files_scanned, 3);

  const read = f => readFileSync(join(root, 'gtm', 'enrichment-cache', f), 'utf8');
  assert.match(read('enrich_company.jsonl'), /acme\.com/);
  assert.doesNotMatch(read('enrich_company.jsonl'), /stale\.com/);
  assert.doesNotMatch(read('linkedin_company_posts.jsonl'), /"old"/);
  assert.doesNotMatch(read('email_verifier.jsonl'), /old@acme\.com/);
  assert.match(read('email_verifier.jsonl'), /bob@acme\.com/);
});

test('sweep is fail-closed: unknown endpoint = 1d, unprovenanced and malformed rows are dropped', () => {
  const root = tmpRoot('compliance-sweep2-');
  write(root, 'gtm/enrichment-cache/mystery.jsonl',
    jsonl([
      { source_endpoint: 'mystery_endpoint', fetched_at: ago(NOW, 2 * 3600_000), key: 'fresh' },
      { source_endpoint: 'mystery_endpoint', fetched_at: ago(NOW, 2 * DAY), key: 'twoDaysOld' },
    ])
    + JSON.stringify({ email: 'bob@acme.com', fetched_at: ago(NOW, 60_000) }) + '\n' // no endpoint
    + JSON.stringify({ source_endpoint: 'enrich_company', key: 'noclock' }) + '\n'    // no fetched_at
    + '{ this is not json\n');

  const r = sweepEnrichmentCache({ root, now: NOW });
  assert.equal(r.rows_kept, 1, 'only the 2h-old unknown-endpoint row survives a 1d TTL');
  assert.equal(r.rows_unprovenanced, 1, 'the row with no source_endpoint');
  assert.equal(r.rows_malformed, 1);
  assert.equal(r.rows_expired, 4, 'stale + noclock + unprovenanced + malformed');
  const left = readFileSync(join(root, 'gtm', 'enrichment-cache', 'mystery.jsonl'), 'utf8');
  assert.match(left, /"fresh"/);
  assert.doesNotMatch(left, /twoDaysOld/);
  assert.doesNotMatch(left, /noclock/, 'a row with no fetched_at cannot prove it is fresh');
  assert.doesNotMatch(left, /bob@acme\.com/, 'an unattributable PII row is not kept');
});

test('isExpired treats a missing clock or missing endpoint as expired', () => {
  const t = loadTtlTable({ gatesPath: '/nonexistent' });
  assert.equal(isExpired({ source_endpoint: 'enrich_company', fetched_at: ago(NOW, DAY) }, { now: NOW, table: t }), false);
  assert.equal(isExpired({ source_endpoint: 'enrich_company' }, { now: NOW, table: t }), true);
  assert.equal(isExpired({ fetched_at: ago(NOW, 1000) }, { now: NOW, table: t }), true);
  assert.equal(isExpired(null, { now: NOW, table: t }), true);
});

test('sweep --dry-run reports without writing', () => {
  const root = tmpRoot('compliance-sweepdry-');
  const f = 'gtm/enrichment-cache/enrich_company.jsonl';
  const body = jsonl([{ source_endpoint: 'enrich_company', fetched_at: ago(NOW, 200 * DAY), key: 'stale.com' }]);
  write(root, f, body);
  const r = sweepEnrichmentCache({ root, now: NOW, dryRun: true });
  assert.equal(r.rows_expired, 1);
  assert.equal(readFileSync(join(root, f), 'utf8'), body, 'dry run wrote nothing');
});

test('sweep on a repo with no cache dir is a no-op, not a crash', () => {
  const root = tmpRoot('compliance-sweepnone-');
  const r = sweepEnrichmentCache({ root, now: NOW });
  assert.equal(r.files_scanned, 0);
  assert.equal(r.rows_expired, 0);
});
