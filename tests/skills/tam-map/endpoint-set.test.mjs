// tests/skills/tam-map/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by nobody. It cannot see the other
// direction: a SKILL.md that quietly calls something it does not own, or that silently
// drops an endpoint the owners file says it is responsible for.
//
// The pack hit exactly this class once — two components independently computing "the 11
// unbounded endpoints" and getting different sets — so the set is asserted, not eyeballed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, catalog, owners, skillBody, ownedEndpoints, invokedEndpoints } from './helpers.mjs';

const owned = ownedEndpoints();

test('the owners file assigns this skill exactly the seven endpoints it was scoped for', () => {
  assert.deepEqual([...owned].sort(), [
    'crunchbase_company_scraper_sync',
    'directory_yellowpages',
    'find_website_by_company_name',
    'google_maps_places_scraper_keyword',
    'google_maps_places_scraper_sync_using_url',
    'linkedin_company_search',
    'similarweb_scraper_sync',
  ]);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(skillBody());
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra   = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(catalog.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is disabled or unclaimed', () => {
  for (const name of invokedEndpoints(skillBody())) {
    assert.ok(!(name in (owners.unclaimed || {})),
      `${name} is unclaimed (${owners.unclaimed?.[name]}) and must not be invoked`);
    assert.notEqual(catalog.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default (${catalog.endpoints[name].pricing?.disabled_reason})`);
  }
});

test('endpoints this skill deliberately leans on but does not own are handed over, not called', () => {
  const body = skillBody();
  // Geo-ID resolution and domain/company normalisation are real dependencies of a TAM
  // map, and both belong to other skills. Naming them is required; invoking them is a
  // ownership violation the owners file cannot catch on its own.
  for (const foreign of ['geo_id_search', 'clean_domain', 'normalize_company']) {
    assert.ok(!body.includes(`${foreign}()`),
      `${foreign}() is invoked but owned by another skill — route to that skill instead`);
  }
  assert.match(body, /geo[- ]?id/i, 'the geo-ID dependency must be named, and handed off');
  assert.match(body, /normalis(?:ation|ing)|normaliz(?:ation|ing)/i,
    'the normalisation dependency must be named, and handed off');
});

test('this skill does spend credits, so law 3 applies to it', () => {
  const metered = [...invokedEndpoints(skillBody())].filter(n => {
    const p = catalog.endpoints[n].pricing;
    return p && p.metered !== false;
  });
  assert.ok(metered.length > 0, 'the fixture must reflect that this skill spends');
  const body = skillBody();
  assert.ok(/dry[- ]?run/i.test(body) && /gates\.yaml/.test(body),
    'a skill that invokes a metered endpoint must show a dry-run plan or a gates.yaml threshold');
});
