// Cross-module contract: _lib/pii.mjs reads the `cache_ttl` block in
// _lib/gates.yaml for the PII retention sweep.
//
// The failure they exist to catch is silent: if the PII
// reader cannot parse gates.yaml it falls back to its own built-in defaults,
// and the gates.yaml retention policy is simply ignored with no error anywhere.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

import * as G from '../../_lib/gates.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PII = join(ROOT, '_lib', 'pii.mjs');
const GATES = join(ROOT, '_lib', 'gates.yaml');
const DAY_MS = 86400000;

test('the PII sweep reads OUR gates.yaml, not its built-in defaults', async () => {
  const pii = await import(PII);
  const t = pii.loadTtlTable({ root: ROOT });
  assert.notEqual(t.source, 'defaults',
    'the PII sweep fell back to its built-in defaults — gates.yaml was unparseable or had no cache_ttl block');
  assert.deepEqual(t.notes, [],
    `the PII sweep logged fallback notes while reading gates.yaml: ${JSON.stringify(t.notes)}`);
});

test('gates.yaml and the PII sweep agree on the TTL for every endpoint we classify', async () => {
  const pii = await import(PII);
  const t = pii.loadTtlTable({ root: ROOT });
  const gates = G.loadGates(GATES);
  const endpoints = G.gateValue(gates, 'cache_ttl.endpoints');

  for (const name of Object.keys(endpoints)) {
    const ours = G.cacheTtlDays(gates, { endpoint: name });
    assert.equal(ours.decision, G.ALLOW);
    const theirs = pii.ttlForEndpoint(name, t) / DAY_MS;
    assert.equal(theirs, ours.ttl_days,
      `${name}: gates.mjs says ${ours.ttl_days}d, pii.mjs says ${theirs}d`);
  }
});

test('an endpoint neither module classifies gets the SHORTEST TTL in both', async () => {
  const pii = await import(PII);
  const t = pii.loadTtlTable({ root: ROOT });
  const gates = G.loadGates(GATES);
  const ours = G.cacheTtlDays(gates, { endpoint: 'an_endpoint_nobody_has_classified' });
  const theirs = pii.ttlForEndpoint('an_endpoint_nobody_has_classified', t) / DAY_MS;
  assert.equal(ours.unmatched, true);
  assert.equal(theirs, ours.ttl_days);
  assert.equal(theirs, pii.shortestTtlMs(t) / DAY_MS);
});

// This one needs no _lib/pii.mjs code: it guards the shape.
test('the classes the PII sweep hard-codes as defaults all exist in our gates.yaml', () => {
  const classes = G.gateValue(G.loadGates(GATES), 'cache_ttl.classes');
  // _lib/pii.mjs's DEFAULT_TTL_CLASSES keys — if we drop one, its endpoint map
  // silently resolves against a class we no longer define.
  for (const [name, days] of Object.entries({
    firmographics: 90, funding_tech: 30, email_verification: 7, posts_activity: 1, unknown: 1
  })) {
    assert.ok(name in classes, `gates.yaml dropped the \`${name}\` class _lib/pii.mjs depends on`);
    assert.equal(G.parseDuration(classes[name]), days, `\`${name}\` drifted from the agreed ${days}d`);
  }
});

test('`unknown` is the shortest class, so the fail-closed floor really is the floor', () => {
  const classes = G.gateValue(G.loadGates(GATES), 'cache_ttl.classes');
  const days = Object.values(classes).map(G.parseDuration);
  assert.equal(G.parseDuration(classes.unknown), Math.min(...days),
    '`unknown` is no longer the shortest class — the fail-closed floor would widen');
});

test('every endpoint value is a class name we define, or a literal duration', () => {
  const gates = G.loadGates(GATES);
  const classes = G.gateValue(gates, 'cache_ttl.classes');
  for (const map of ['cache_ttl.endpoints', 'cache_ttl.capability_groups']) {
    for (const [k, v] of Object.entries(G.gateValue(gates, map))) {
      const ok = G.parseDuration(v) !== null || v in classes;
      assert.ok(ok, `${map}.${k} = "${v}" is neither a duration nor a defined class`);
    }
  }
});

test('the whole gates.yaml round-trips, not just the cache_ttl block', () => {
  // _lib/pii.mjs parses the ENTIRE file, so a construct anywhere in it can make the
  // cache_ttl block unreachable.
  const doc = parseYaml(readFileSync(GATES, 'utf8'));
  assert.ok(doc.cache_ttl && typeof doc.cache_ttl === 'object');
  assert.ok(doc.session_budget && doc.unbounded_endpoints);
});
