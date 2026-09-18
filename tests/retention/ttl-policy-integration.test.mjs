/**
 * INTEGRATION TEST — _lib/gates.yaml x the TTL sweep in _lib/pii.mjs.
 *
 * Why this file exists: the gates.yaml retention policy was once SILENTLY IGNORED.
 * _lib/pii.mjs shipped a minimal YAML reader (written before gates.yaml existed) that
 * threw on the real file and fell back to built-in defaults. Each module's own tests
 * passed, because each tested only its own half. This file asserts the seam between them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTtlTable, ttlForEndpoint, shortestTtlMs,
  capabilityGroupOf, _resetCapabilityGroupCache,
} from '../../_lib/pii.mjs';

const DAY = 86_400_000;
const days = (ms) => ms / DAY;
const table = () => loadTtlTable({ root: process.cwd() });

test('gates.yaml is actually parsed, not silently fallen back to defaults', () => {
  const t = table();
  assert.match(t.source, /_lib\/gates\.yaml$/, 'must read the real policy file');
  assert.deepEqual(t.notes, [], `policy must load cleanly, got: ${JSON.stringify(t.notes)}`);
});

test('capability_groups cover the whole catalog taxonomy, so a NEW endpoint inherits a sane TTL', () => {
  const t = table();
  assert.ok(Object.keys(t.groups).length >= 13,
    'every capability_group in the catalog enum needs a policy, or new endpoints rot on the floor');
});

test('resolution precedence: policy endpoint > policy group > built-in > shortest', () => {
  _resetCapabilityGroupCache();
  const t = table();
  assert.equal(capabilityGroupOf('enrich_company'), 'enrichment');
  assert.equal(days(ttlForEndpoint('enrich_company', t)), 90, 'explicit policy endpoint wins');
  assert.equal(days(ttlForEndpoint('web_tech_stack', t)), 30, 'literal duration in policy');
  assert.equal(days(ttlForEndpoint('linkedin_job_search', t)), 7, 'resolved via capability_group');
  assert.equal(days(ttlForEndpoint('youtube_search', t)), 7, 'resolved via capability_group');
});

test('ai_enrich is never served from cache, and that 0 does not become the global floor', () => {
  const t = table();
  assert.equal(ttlForEndpoint('ai_enrich', t), 0,
    'ai output is non-deterministic; a cached answer is a wrong answer');
  assert.ok(shortestTtlMs(t) > 0,
    'a never-cache sentinel must not drag every UNCLASSIFIED endpoint to uncacheable');
});

test('an unclassified endpoint fails closed to the shortest POSITIVE TTL', () => {
  const t = table();
  const ttl = ttlForEndpoint('endpoint_that_does_not_exist', t);
  assert.equal(days(ttl), 1, 'unknown gets the shortest positive TTL');
  assert.ok(ttl < Math.max(...Object.values(t.groups)), 'unknown must never inherit a long TTL');
});

test('a policy file that names an endpoint with an unusable value still fails closed', () => {
  const t = table();
  t.policyEndpoints.bogus_endpoint = 'not_a_class_and_not_a_duration';
  assert.equal(ttlForEndpoint('bogus_endpoint', t), shortestTtlMs(t));
});
