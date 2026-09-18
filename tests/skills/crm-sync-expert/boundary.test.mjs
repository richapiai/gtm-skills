// tests/skills/crm-sync-expert/boundary.test.mjs
//
// The failure this file exists to prevent: a user reads a confident summary, believes
// their CRM has been updated, and it has not. Nothing in the runtime can catch that —
// the skill makes no calls, so there is no journal line, no ledger line and no gate to
// fire. The only defence is the prose, so the prose is asserted.
//
// The claim is also pinned to DATA rather than to a phrase: `_lib/api-catalog.json` is
// checked directly for the CRM write endpoint the skill says does not exist. If one
// ever lands, this test goes red and the skill has to be rewritten rather than quietly
// becoming wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, boundarySection, loadCatalog, completedActionClaims } from './helpers.mjs';

const NAME = 'crm-sync-expert';
const body = skillBody(NAME);
const boundary = boundarySection(body);

test('the catalog really does contain no CRM write endpoint', () => {
  // The skill's central claim, checked against the source of truth for routing rather
  // than taken on faith. Every endpoint is a read.
  const catalog = loadCatalog();
  const WRITEY = /(crm|hubspot|salesforce|pipedrive|highlevel|upsert|create_contact|update_contact)/i;
  const offenders = Object.keys(catalog.endpoints).filter(n => WRITEY.test(n));
  assert.deepEqual(offenders, [],
    `the catalog now has ${offenders.join(', ')}; /crm-sync-expert claims no CRM endpoint exists`);
});

test('the boundary states that execution does not happen, and why', () => {
  assert.match(boundary, /will not sync|does not sync|not sync anything/i,
    'the boundary must say in plain words that no sync happens');
  assert.match(boundary, /no CRM write endpoint/i,
    'the boundary must name the reason: there is no endpoint');
  // Citation moved from the internal backlog to ROADMAP.md on 2026-09-01. That backlog
  // was the developers' build log — 14 skills were sending USERS into it. Law 6 is
  // unchanged (cite the boundary, do not assert it); only the target is now a
  // document written for the reader.
  assert.match(boundary, /ROADMAP\.md#blocked-on-the-api-growing/i,
    'the boundary must cite the stated boundary rather than asserting it (law 6)');
  assert.match(boundary, /blocked on (the )?API grow(th|ing)/i,
    'ROADMAP.md files two-way CRM sync execution as BLOCKED, not as unbuilt; say which');
});

test('the boundary names who performs the write instead', () => {
  assert.match(boundary, /user|importer|integration platform/i,
    'a boundary that says "not us" without saying "them" leaves the user with no next step');
});

test('the skill forbids itself the word that causes the misunderstanding', () => {
  assert.match(body, /never say "synced"|Never say "synced"/i,
    'the skill must explicitly forbid reporting a sync it cannot observe');
  assert.match(body, /mapped|prepared|planned/i,
    'forbidding a word without offering the replacement gets the word used anyway');
});

test('the skill never itself claims a completed write', () => {
  // Adversarial read of our own copy: any sentence that would leave a skimming user
  // believing the CRM changed. Denials are exempt — a skill whose whole job is to say
  // "this did not happen" must be allowed to say it — so the scan is negation-aware.
  const hits = completedActionClaims(body, [
    /\b(?:has been|have been|was|were|successfully)\s+(?:synced|synchronised|synchronized|upserted)\b/i,
    /\brecords (?:were|have been) (?:created|updated)\b/i,
    /\bwrote \d+ records\b/i,
  ]);
  assert.deepEqual(hits, [], 'these lines read as a completed write:\n' + hits.join('\n'));
});

test('the skill refuses to assert response field names the pack cannot verify', () => {
  // Law 2: the spec is a cost-and-route source, NOT a schema source. An earlier version
  // published a mapping table keyed on remembered response fields.
  //
  // UPDATED 2026-09-02. This used to assert that NO endpoint carried `live_fixture`,
  // on the grounds that nothing had been captured. 35 now do. The rule the skill
  // actually depends on is narrower and still holds: the catalog publishes an OBSERVED
  // SHAPE, never a semantic mapping, so a skill may not read a field's MEANING out of
  // it. `field_map === null` on every endpoint is the assertion that carries law 2 —
  // and it is the one that must never quietly become false.
  //
  // The three statuses each describe where a row's paths came from:
  //   * live_fixture            — scalar paths off a recorded 200
  //   * keys_from_spec_example  — the spec's 200 example key names, unverified
  //   * TODO_no_usable_example  — neither
  const catalog = loadCatalog();
  const statuses = new Set(Object.values(catalog.endpoints).map(e => e.field_map_status));
  const allowed = new Set(['live_fixture', 'keys_from_spec_example', 'TODO_no_usable_example']);
  const unexpected = [...statuses].filter(s => !allowed.has(s)).sort();
  assert.deepEqual(unexpected, [], 'an unknown field_map_status appeared in the catalog');
  assert.ok(Object.values(catalog.endpoints).every(e => e.field_map === null),
    'a field_map exists now; the catalog publishes observed shape, not meaning — a skill '
    + 'that reads a field\'s MEANING out of the catalog is back to guessing at a schema');
  assert.match(body, /field_map_status/,
    'the skill must name the catalog field that proves the mapping cannot come from the spec');
  assert.match(boundary, /field_map_status|response field name/i,
    'the boundary must carry the "no verified field names" limitation, not only the body');
  // An earlier version's exact defect: a dotted endpoint.field claim.
  assert.doesNotMatch(body, /\benrich_profile\.[a-zA-Z]/,
    'asserts a response field name off enrich_profile; no field map has been captured');
  assert.doesNotMatch(body, /\benrich_company\.[a-zA-Z]/,
    'asserts a response field name off enrich_company; no field map has been captured');
});

test('the explicit-null enum is never allowed to reach a CRM field', () => {
  assert.match(body, /not_found/, 'the pack\'s explicit nulls must be named');
  assert.match(body, /Never let those strings reach a CRM text field/i,
    'an explicit null written into a CRM text field becomes a job title; say so');
});

test('the suppression store is named as the thing a CRM import bypasses', () => {
  assert.match(body, /SUPPRESSION: STOP/,
    'the preflight key that blocks the handoff must be named');
  assert.match(body, /re-sequence|re-arms/i,
    'the specific harm — the CRM re-contacting a suppressed person — must be stated');
});

test('the boundary restates every permanently-external capability', () => {
  for (const [what, re] of [
    ['sending', /send/i],
    ['LinkedIn actions', /LinkedIn/i],
    ['dialing', /dial/i],
    ['inbox hosting', /inbox/i],
  ]) {
    assert.match(boundary, re, `the boundary never mentions ${what}; an unstated ceiling reads as a promise`);
  }
});
