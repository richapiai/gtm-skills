// tests/skills/crm-sync-expert/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint. CI already fails on an endpoint owned by nobody; it cannot see the other
// direction — a SKILL.md quietly calling something it does not own, or naming an
// endpoint that does not exist at all.
//
// That second defect is not hypothetical. An earlier sibling skill was
// caught invoking endpoints that no longer exist (13 endpoints were removed in four
// months, mostly renames: find_emails, verify_emails, person_enricher, ad_search), and
// the validator will not catch a name written WITHOUT call parentheses. This suite's two
// skills invoke nothing, so prose is the only place a phantom endpoint can hide, and
// prose is where this file looks.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  skillBody, invokedEndpoints, backtickedIdentifiers, ownedEndpoints, loadCatalog, loadOwners,
} from './helpers.mjs';

const NAME = 'crm-sync-expert';
const body = skillBody(NAME);
const catalog = loadCatalog();

// Backticked snake_case tokens that are deliberately NOT endpoint names. Each one is
// justified, because an unexplained allowlist is how a phantom endpoint gets waved
// through: this is the escape hatch the test is guarding, so it stays short.
const NOT_ENDPOINTS = new Set([
  'field_map_status',    // a key of _lib/api-catalog.json
  'field_map',           // ditto
  'field_map_keys',      // ditto — the published top-level response key NAMES
  'keys_from_spec_example', // a field_map_status VALUE, in the frozen contract's enum
  'not_found',           // _lib/dual-contract.schema.json null enum
  'not_verifiable',      // ditto
  'not_applicable',      // ditto
  'create_only',         // a collision rule this skill defines
  'update_blank_only',   // ditto
  'co_name',             // an example CSV column
]);

test('the owners file assigns this skill no endpoints at all', () => {
  // Pinned. An advisory skill that quietly acquires a paid endpoint is an advisory
  // skill that quietly acquires a bill, and nothing else in CI would notice.
  assert.deepEqual([...ownedEndpoints(NAME)].sort(), []);
});

test('the SKILL.md invokes nothing — zero paid calls, and the body proves it', () => {
  assert.deepEqual([...invokedEndpoints(body)].sort(), [],
    'this skill claims to make zero API calls; the body invokes an endpoint');
});

test('every endpoint the prose names actually exists in the generated catalog', () => {
  const suspects = [...backtickedIdentifiers(body)].filter(t => !NOT_ENDPOINTS.has(t));
  assert.ok(suspects.length > 0, 'the token scan found nothing; the regex has stopped working');
  for (const tok of suspects) {
    assert.ok(catalog.endpoints[tok],
      `\`${tok}\` reads as an endpoint but is not in _lib/api-catalog.json. `
      + 'Either it does not exist, or it belongs in the justified NOT_ENDPOINTS list.');
  }
});

test('no retired endpoint name is named anywhere in the body', () => {
  // 13 endpoints disappeared from the API in four months. These are the named
  // renames, and they are exactly what a skill rewritten from an
  // old one carries forward by accident.
  for (const dead of ['find_emails', 'verify_emails', 'person_enricher', 'ad_search',
                      'company_enricher', 'email_validator']) {
    assert.doesNotMatch(body, new RegExp(`\\b${dead}\\b`),
      `${dead} is not in the pinned spec; it is a retired endpoint name`);
  }
});

test('no endpoint it names is unclaimed or disabled by default', () => {
  const owners = loadOwners();
  for (const tok of [...backtickedIdentifiers(body)].filter(t => catalog.endpoints[t])) {
    assert.ok(!(tok in (owners.unclaimed || {})),
      `${tok} is unclaimed (${owners.unclaimed?.[tok]}) and should not be held out as usable`);
    assert.notEqual(catalog.endpoints[tok].pricing?.disabled_by_default, true,
      `${tok} is disabled by default (${catalog.endpoints[tok].pricing?.disabled_reason})`);
  }
});

test('the "spends nothing" claim is made explicitly, not left to inference', () => {
  assert.match(body, /^##.*what it spends/im,
    'a skill that spends nothing should say so plainly rather than look substantial');
  assert.match(body, /zero paid calls|makes no paid call/i);
  assert.match(body, /owns \*\*no endpoints\*\*|owns no endpoints/i);
});

test('it routes cost questions to the skill that actually prices them', () => {
  assert.match(body, /enrich-waterfall/,
    'a mapping that needs a missing column becomes an enrichment bill; name the owner');
});
