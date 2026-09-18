// tests/skills/local-business-prospecting/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by NOBODY. It cannot see the two
// directions that matter here: a SKILL.md quietly calling something it does not own,
// and a SKILL.md silently dropping something it is responsible for.
//
// This skill has a third case, and it is the interesting one. The owners file predates
// it: the four maps-and-directory endpoints are still assigned to /tam-map and
// /account-research. These tests may not edit that file, so the rule enforced here is
// "invoke exactly the capability group you were scoped for, and DISCLOSE every endpoint
// the owners file has not transferred yet". Once the orchestrator applies the transfer,
// the disclosure clause simply stops having anything to check and this file stays green.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL, catalog, owners, skillBody, skillProse, invokedEndpoints,
  capabilityGroupEndpoints, ownedEndpoints, currentOwners,
} from './helpers.mjs';

const body = skillBody();
const prose = skillProse();
const scoped = capabilityGroupEndpoints('maps_directories');
const invoked = invokedEndpoints(body);

test('the maps-and-directory group is still exactly the four endpoints this skill was scoped for', () => {
  assert.deepEqual([...scoped].sort(), [
    'directory_yellowpages',
    'google_maps_places_scraper_keyword',
    'google_maps_places_scraper_sync_using_url',
    'google_maps_reviews_scraper_sync',
  ], 'the capability group changed — a new maps/directory endpoint is this skill\'s to '
    + 'claim or to unclaim with a reason, not to leave silently unhandled');
});

test('the SKILL.md invokes exactly that group — no more, no fewer', () => {
  const missing = [...scoped].filter((e) => !invoked.has(e)).sort();
  const extra = [...invoked].filter((e) => !scoped.has(e)).sort();
  assert.deepEqual(missing, [],
    `scoped but never invoked: ${missing.join(', ')} — call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but outside this skill's capability group: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invoked) {
    assert.ok(catalog.endpoints[name],
      `${name} is not in _lib/api-catalog.json. An earlier version of this skill invoked `
      + 'three endpoint names that do not exist; every name here is verified against the '
      + 'catalog rather than carried over.');
  }
});

test('retired phantom endpoint names did not survive the port', () => {
  // An earlier local-business-prospecting called google_maps_places_scraper,
  // google_maps_places_scraper_url and google_maps_reviews_scraper. None of the three
  // is in this API. A stale name is not a typo; it is a call that cannot be planned.
  // Two of the three are PREFIXES of real endpoint names, so matching bare substrings
  // would flag the correct names. Match the invocation form, which is what the
  // validator resolves against the catalog and what a reader would copy.
  for (const phantom of [
    'google_maps_places_scraper',
    'google_maps_places_scraper_url',
    'google_maps_reviews_scraper',
  ]) {
    assert.ok(!catalog.endpoints[phantom], `${phantom} unexpectedly exists — re-check this test`);
    assert.ok(!invoked.has(phantom),
      `the SKILL.md still invokes the retired phantom endpoint ${phantom}()`);
  }
});

test('no invoked endpoint is disabled or unclaimed', () => {
  for (const name of invoked) {
    assert.ok(!(name in (owners.unclaimed || {})),
      `${name} is unclaimed (${owners.unclaimed?.[name]}) and must not be invoked`);
    assert.notEqual(catalog.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default (${catalog.endpoints[name].pricing?.disabled_reason})`);
  }
});

test('every endpoint the owners file has not transferred yet is disclosed by name', () => {
  const mine = ownedEndpoints(SKILL);
  const pending = [...scoped].filter((e) => !mine.has(e)).sort();
  if (pending.length === 0) return;   // transfer applied; nothing left to disclose

  assert.match(prose, /endpoint-owners\.yaml/,
    'the owners file must be named where the gap is disclosed');
  for (const ep of pending) {
    assert.ok(prose.includes(ep),
      `${ep} is invoked but still assigned elsewhere in the owners file, and the SKILL.md `
      + 'does not name it in the disclosure');
    for (const holder of currentOwners(ep)) {
      assert.ok(prose.includes('/' + holder),
        `the disclosure must name the current owner of ${ep} (/${holder}), so a reader can `
        + 'see which skill to route to until the transfer lands');
    }
  }
});

test('the owners file assigns this skill nothing it does not invoke', () => {
  // The other direction, for after the transfer: an endpoint handed to this skill and
  // never called is a coverage claim with nothing behind it.
  const mine = [...ownedEndpoints(SKILL)];
  for (const ep of mine) {
    assert.ok(invoked.has(ep), `owners.yaml gives ${SKILL} ${ep} but the SKILL.md never calls it`);
  }
});

test('endpoints this skill depends on but does not own are handed over, never called', () => {
  // Website resolution, email discovery, verification, phone/domain normalisation and
  // tech-stack reads are all real dependencies of a local prospect list. Every one of
  // them belongs to another skill, and the owners file cannot catch a skill that calls
  // across the line — only that the endpoint has AN owner.
  const foreign = [
    'find_website_by_company_name', 'web_emails', 'email_finder', 'email_verifier',
    'identify_email_type', 'web_tech_stack', 'normalize_phone', 'clean_domain',
    'find_personal_email', 'ai_enrich',
  ];
  for (const ep of foreign) {
    assert.ok(catalog.endpoints[ep], `${ep} should exist in the catalog`);
    assert.ok(!body.includes(`${ep}()`),
      `${ep}() is invoked but owned by another skill — route to that skill instead`);
  }
  // Naming the dependency is required; a skill that silently omits it teaches the user
  // the pack cannot do it at all.
  assert.match(prose, /normalis|normaliz/i, 'the normalisation dependency must be named');
  assert.match(prose, /enrich-waterfall/, 'the enrichment hand-off must be named');
  assert.match(prose, /list-hygiene/, 'the hygiene hand-off must be named');
});

test('personal email is refused rather than merely omitted', () => {
  // find_personal_email is in always_ask AND carries a consent question. A local-SMB
  // skill is precisely where somebody reaches for it.
  assert.match(prose, /[Pp]ersonal email/,
    'the skill must say out loud that it does not reach past the published business address');
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /personal email/i, 'the refusal belongs in the boundary section');
});

test('this skill spends, so law 3 applies to it', () => {
  const metered = [...invoked].filter((n) => {
    const p = catalog.endpoints[n].pricing;
    return p && p.metered !== false;
  });
  assert.ok(metered.length > 0, 'the fixture must reflect that this skill spends');
  assert.ok(/dry[- ]?run/i.test(body) && /gates\.yaml/.test(body),
    'a skill that invokes a metered endpoint must show a dry-run plan or a gates.yaml threshold');
});
