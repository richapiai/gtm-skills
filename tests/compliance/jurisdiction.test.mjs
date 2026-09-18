// tests/compliance/jurisdiction.test.mjs — the never-guess contract for _lib/jurisdiction.mjs.
//
// THE GAP THE MODULE CLOSES, AND THE ONE THIS FILE GUARDS
//
// `/comply` detects a jurisdiction from ISO codes. Enrichment produces free text —
// `enrich_profile`'s `field_map_keys` publishes `location`, which arrives as "Berlin,
// Germany" or "Greater London Area". With no mapper between them every row of a
// normal prospect list resolved nothing, stopped, and the operator learned it only
// after paying for the enrichment.
//
// A mapper fixes that, and introduces a strictly worse failure in its place: a row
// mislabelled `US` skips GDPR silently and permanently. An unresolved row merely
// stops. So the module's value is not its coverage — it is its refusals, and those
// are what this file asserts:
//
//   * an ambiguous name never becomes a country                    (never_guess_*)
//   * a GDPR country never becomes a non-GDPR country               (gdpr_*)
//   * a two-letter token is never interpreted                       (two_letter_*)
//   * contradictory evidence never picks a winner                   (contradiction_*)
//   * nothing outside the stated coverage table is ever named       (coverage_*)
//
// Lives with the compliance runtime tests — retention, erasure, suppression and the
// dual contract are its neighbours in this directory.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { REPO_ROOT } from './helpers.mjs';
import { validateDualContract, NULL_ENUM } from '../../_lib/dual-contract.mjs';
import {
  foldText, locationParts, inspectLocation, resolveLocation, proposeSubjectColumns,
  phraseIndex, COUNTRY_ALIASES, COVERED_COUNTRIES, CONFIDENCE, AUTOFILL_MIN_CONFIDENCE,
  DEFAULT_LOCATION_FIELDS, KIND, TABLE_VERSION, isCountryCode, countryOfSubdivision,
} from '../../_lib/jurisdiction.mjs';

const COMPLY_SKILL = join(REPO_ROOT, 'skills', 'comply', 'SKILL.md');

/** The gdpr / casl country lists straight out of the shipped gate table. */
function complyDetection () {
  const src = readFileSync(COMPLY_SKILL, 'utf8');
  const blocks = [];
  let open = null;
  for (const line of src.split(/\r?\n/)) {
    if (open === null) { if (/^```yaml[ \t]+comply-rules[ \t]*$/.test(line)) open = []; continue; }
    if (/^```\s*$/.test(line)) { blocks.push(open.join('\n')); open = null; continue; }
    open.push(line);
  }
  assert.equal(blocks.length, 1, 'skills/comply/SKILL.md must carry exactly one comply-rules block');
  return parseYaml(blocks[0]).detection;
}

const countryOf = (contract) => (typeof contract.result === 'object' ? contract.result.country : null);
const resolved = (text, field = 'location') => resolveLocation(text, { field });

// ---------------------------------------------------------------------------
// The shapes the field actually emits
// ---------------------------------------------------------------------------

test('the documented LinkedIn shapes resolve exactly as specified', () => {
  const berlin = resolved('Berlin, Germany');
  assert.equal(berlin.result.country, 'DE');
  assert.equal(berlin.result.region, 'DE-BE');
  assert.equal(berlin.confidence, CONFIDENCE.country_name);

  const london = resolved('Greater London Area, United Kingdom');
  assert.equal(london.result.country, 'GB');
  assert.equal(london.result.region, 'GB-LND');

  const paris = resolved('Paris, Île-de-France, France');
  assert.equal(paris.result.country, 'FR');
  assert.equal(paris.result.region, 'FR-IDF');

  assert.equal(resolved('Remote').result, 'not_applicable');
  assert.equal(resolved('').result, 'not_found');
  assert.equal(resolved('   ').result, 'not_found');
});

test('a bare city this table trusts resolves the country but not above the autofill floor', () => {
  const munich = resolved('Munich');
  assert.equal(munich.result.country, 'DE');
  assert.equal(munich.result.confidence_basis, KIND.CITY);
  assert.equal(munich.confidence, CONFIDENCE.city_name);
  assert.ok(munich.confidence < AUTOFILL_MIN_CONFIDENCE,
    'a city-only match must sit below the autofill floor — the city table is the least trusted one');
});

test('a subdivision alone pins its country', () => {
  const la = resolved('Los Angeles, California');
  assert.equal(la.result.country, 'US');
  assert.equal(la.result.region, 'US-CA');
  assert.equal(la.confidence, CONFIDENCE.subdivision_name);
  assert.ok(la.confidence >= AUTOFILL_MIN_CONFIDENCE);
});

test('two subdivisions of one country pin the country and no region', () => {
  const seen = inspectLocation('Bavaria and Hesse, Germany');
  assert.equal(seen.country, 'DE');
  assert.equal(seen.region, null, 'two regions named means no single region is determinable');
  assert.deepEqual(seen.regions, ['DE-BY', 'DE-HE']);
});

// ---------------------------------------------------------------------------
// never_guess — the property the whole module exists for
// ---------------------------------------------------------------------------

test('never_guess_ambiguous_city — a name shared across countries never yields a country', () => {
  for (const text of [
    'London', 'Paris', 'Berlin', 'Dublin', 'Cambridge', 'Vienna', 'Athens', 'Rome',
    'Naples', 'Milan', 'Florence', 'Venice', 'Toledo', 'Valencia', 'Warsaw',
    'Amsterdam', 'Rotterdam', 'Lisbon', 'Prague', 'Geneva', 'Boston', 'York',
    'Hamilton', 'Victoria', 'Perth', 'Sydney', 'Melbourne', 'Wellington', 'Ontario',
    'Georgia', 'Hamburg', 'Manchester', 'Birmingham',
  ]) {
    const got = resolved(text);
    assert.equal(typeof got.result, 'string',
      `"${text}" resolved to ${JSON.stringify(got.result)} — an ambiguous name must never yield a country`);
    assert.equal(got.result, 'not_verifiable', `"${text}" must be reported as ambiguous, not absent`);
    assert.equal(got.confidence, 0, `"${text}" must carry no confidence`);
  }
});

test('never_guess_ambiguous_names_its_candidates — the caller can act on the refusal', () => {
  const got = resolved('London');
  assert.match(got.reasoning, /GB/);
  assert.match(got.reasoning, /US-OH/);
  assert.match(got.reasoning, /CA-ON/);
  const seen = inspectLocation('London');
  assert.deepEqual(seen.candidates.map((c) => c.country).sort(), ['CA', 'GB', 'US']);
});

test('never_guess_metro_label — a metropolitan area implies a country and states none', () => {
  for (const text of ['San Francisco Bay Area', 'Greater Boston Area', 'Dallas Fort Worth Metroplex']) {
    const got = resolved(text);
    assert.equal(got.result, 'not_verifiable', `"${text}" must not resolve to a country`);
    assert.match(got.reasoning, /does not state one|more than one country|multi-country/i);
  }
});

test('never_guess_multi_country_region — EMEA and "European Union" are not countries', () => {
  for (const text of ['EMEA', 'Europe', 'European Union', 'APAC', 'Nordics', 'Benelux']) {
    assert.equal(resolved(text).result, 'not_verifiable',
      `"${text}" spans several regimes and must not stand in for one country`);
  }
});

test('never_guess_unknown — a place outside the coverage table is an explicit null, not a guess', () => {
  for (const text of ['Sunnyvale', 'Ulaanbaatar', 'Nairobi, Kenya', 'Kyiv, Ukraine', 'Tokyo, Japan']) {
    const got = resolved(text);
    assert.equal(typeof got.result, 'string', `"${text}" must not be guessed at`);
    assert.ok(NULL_ENUM.includes(got.result));
  }
});

test('two_letter_tokens_are_never_interpreted — "CA" is not read as California OR Canada', () => {
  // Appending a two-letter code must not change the answer by one bit. `CA` is
  // Canada as ISO 3166-1 and California as a US state abbreviation, and free text
  // does not say which — so it contributes nothing either way.
  for (const [bare, coded] of [
    ['San Francisco', 'San Francisco, CA'],
    ['Toronto', 'Toronto, CA'],
    ['Berlin', 'Berlin, DE'],
    ['Mumbai', 'Mumbai, IN'],
    ['Austin', 'Austin, TX'],
    ['Springfield', 'Springfield, IL'],
  ]) {
    assert.deepEqual(resolved(coded).result, resolved(bare).result,
      `"${coded}" answered differently from "${bare}" — the two-letter token was interpreted`);
  }
  // And where the code is the ONLY signal, nothing resolves.
  for (const text of ['San Francisco, CA', 'Austin, TX', 'Springfield, IL']) {
    assert.equal(typeof resolved(text).result, 'string',
      `"${text}" resolved to a country on the strength of a two-letter token alone`);
  }
  // The named exceptions, which collide with no subdivision abbreviation.
  assert.equal(resolved('Leeds, UK').result.country, 'GB');
  assert.equal(resolved('Austin, USA').result.country, 'US');
});

test('contradiction_two_countries — naming two countries refuses instead of choosing', () => {
  const got = resolved('Vancouver, Canada / London, United Kingdom');
  assert.equal(got.result, 'not_verifiable');
  assert.match(got.reasoning, /more than one country/);
  assert.match(got.reasoning, /CA/);
  assert.match(got.reasoning, /GB/);
});

test('contradiction_impossible_pair — a city that cannot be in the named country refuses', () => {
  const got = resolved('London, Germany');
  assert.equal(got.result, 'not_verifiable',
    'a contradiction must refuse, not silently trust the country token');
  assert.match(got.reasoning, /contradicts itself/);
});

// ---------------------------------------------------------------------------
// gdpr — the asymmetry that makes a wrong answer worse than no answer
// ---------------------------------------------------------------------------

test('gdpr_every_country_in_the_shipped_gate_table_is_reachable_by_name', () => {
  const gdpr = complyDetection().countries.gdpr;
  assert.ok(gdpr.length > 0);
  for (const code of gdpr) {
    assert.ok(COVERED_COUNTRIES.includes(code),
      `comply screens ${code} under GDPR but _lib/jurisdiction.mjs cannot name it — `
      + 'a GDPR country this table cannot resolve is a GDPR subject nobody classifies');
    const name = COUNTRY_ALIASES[code][0];
    const got = resolved(`Somewheresville, ${name}`);
    assert.equal(countryOf(got), code, `"${name}" must resolve to ${code}`);
    assert.ok(got.confidence >= AUTOFILL_MIN_CONFIDENCE);
  }
});

test('gdpr_a_gdpr_subject_is_never_classified_as_a_non_gdpr_country', () => {
  const gdpr = new Set(complyDetection().countries.gdpr);
  const nonGdpr = COVERED_COUNTRIES.filter((c) => !gdpr.has(c));
  for (const code of gdpr) {
    for (const name of COUNTRY_ALIASES[code]) {
      for (const text of [name, `Office, ${name}`, `${name}`, `Remote — ${name}`]) {
        const got = countryOf(resolved(text));
        if (got === null) continue;               // a refusal is always allowed
        assert.equal(got, code,
          `"${text}" resolved to ${got}; it names ${code}. Mapping a GDPR subject onto `
          + `${nonGdpr.includes(got) ? 'a non-GDPR country' : 'another country'} skips the regime entirely.`);
      }
    }
  }
});

test('gdpr_every_covered_city_and_region_agrees_with_its_own_country', () => {
  // Every city/subdivision phrase, matched alone, must either refuse or name the
  // country the table filed it under. A phrase that drifts to another country is
  // exactly the mislabelling this module exists to prevent.
  for (const p of phraseIndex()) {
    if (p.kind !== KIND.CITY && p.kind !== KIND.SUBDIVISION) continue;
    const got = countryOf(resolved(p.display));
    if (got === null) continue;
    assert.equal(got, p.country, `"${p.display}" is filed under ${p.country} but resolved to ${got}`);
  }
});

// ---------------------------------------------------------------------------
// coverage — the stated boundary, asserted rather than described
// ---------------------------------------------------------------------------

test('coverage_no_resolution_ever_names_a_country_outside_the_table', () => {
  const covered = new Set(COVERED_COUNTRIES);
  const corpus = [
    'Berlin, Germany', 'Tbilisi, Georgia', 'Mexico City, Mexico', 'São Paulo, Brazil',
    'Shanghai, China', 'Lagos, Nigeria', 'Buenos Aires, Argentina', 'Dubai, UAE',
    'Seoul, South Korea', 'Tel Aviv, Israel', 'Bogotá, Colombia', 'Oslo, Norway',
    ...phraseIndex().map((p) => p.display),
  ];
  for (const text of corpus) {
    const got = countryOf(resolved(text));
    if (got === null) continue;
    assert.ok(covered.has(got), `"${text}" produced ${got}, which is outside the stated coverage table`);
  }
});

test('coverage_us_and_canadian_cities_are_deliberately_not_resolved_by_name', () => {
  for (const text of ['San Francisco', 'Chicago', 'Austin', 'Seattle', 'Denver', 'Portland']) {
    const got = resolved(text);
    assert.equal(typeof got.result, 'string',
      `"${text}" resolved to a country; US city names are borrowed from Europe and are the `
      + 'single most likely way to mislabel a European subject');
  }
});

test('coverage_the_boundary_is_stated_in_the_module_header', () => {
  const src = readFileSync(join(REPO_ROOT, '_lib', 'jurisdiction.mjs'), 'utf8');
  const header = src.slice(0, src.indexOf('// ------'));
  assert.match(header, /COVERAGE BOUNDARY/,
    'the header must state what the table does not cover — an unstated limit reads as a promise');
  assert.match(header, new RegExp(String(COVERED_COUNTRIES.length)),
    `the header must state the real country count (${COVERED_COUNTRIES.length})`);
});

// ---------------------------------------------------------------------------
// The dual contract
// ---------------------------------------------------------------------------

test('every return value validates against _lib/dual-contract.schema.json', () => {
  const corpus = [
    '', '   ', 'Remote', 'Worldwide', 'London', 'Berlin, Germany', 'EMEA',
    'San Francisco Bay Area', 'Greater London Area, United Kingdom', 'Munich',
    'Los Angeles, California', 'Vancouver, Canada / London, United Kingdom',
    'London, Germany', 'Sunnyvale', 'Paris, Île-de-France, France', 'Toronto, Ontario, Canada',
    null, undefined, 42, {},
  ];
  for (const text of corpus) {
    const got = resolveLocation(text, { field: 'location' });
    const { valid, errors } = validateDualContract(got);
    assert.ok(valid, `${JSON.stringify(text)} produced an invalid contract: ${errors.join('; ')}`);
  }
});

test('an explicit null is one of the three enum values and never an alias', () => {
  for (const text of ['', 'Remote', 'London', 'Sunnyvale', 'EMEA']) {
    const { result } = resolved(text);
    if (typeof result !== 'string') continue;
    assert.ok(NULL_ENUM.includes(result), `"${text}" answered "${result}", which is not the null enum`);
  }
});

test('the three nulls carry three different meanings, and all three are used', () => {
  assert.equal(resolved('').result, 'not_found', 'empty input: looked, nothing there');
  assert.equal(resolved('Sunnyvale').result, 'not_found', 'unlisted place: looked, nothing there');
  assert.equal(resolved('London').result, 'not_verifiable', 'ambiguous: there, cannot be confirmed');
  assert.equal(resolved('Remote').result, 'not_applicable', 'not a place: the question does not apply');
});

test('every answer, including a refusal, carries reasoning and a source naming the field', () => {
  for (const text of ['', 'Remote', 'London', 'Berlin, Germany', 'EMEA', 'Sunnyvale']) {
    const got = resolveLocation(text, { field: 'person_location' });
    assert.ok(got.reasoning.length > 0, `"${text}" answered with no reasoning`);
    assert.match(got.source, /person_location/, `"${text}" lost the field name from its provenance`);
    assert.match(got.source, new RegExp(`v${TABLE_VERSION}`));
  }
});

test('a resolution records which field and which token produced it', () => {
  const got = resolveLocation('Greater London Area, United Kingdom', { field: 'profile_location' });
  const kinds = got.result.evidence.map((e) => e.kind).sort();
  assert.deepEqual(kinds, [KIND.COUNTRY, KIND.SUBDIVISION]);
  for (const e of got.result.evidence) {
    assert.equal(e.field, 'profile_location');
    assert.ok(e.matched, 'evidence must name the token that matched');
    assert.ok(typeof e.part_index === 'number', 'evidence must name which part of the string matched');
    assert.ok(e.part, 'evidence must quote the part it came from');
  }
  const tokens = got.result.evidence.map((e) => e.matched);
  assert.ok(tokens.includes('Greater London'));
  assert.ok(tokens.includes('United Kingdom'));
});

// ---------------------------------------------------------------------------
// Table hygiene — an inconsistent table is a silent mislabel
// ---------------------------------------------------------------------------

test('no name is filed as both unambiguous and ambiguous', () => {
  const byPhrase = new Map();
  for (const p of phraseIndex()) {
    if (!byPhrase.has(p.phrase)) byPhrase.set(p.phrase, new Set());
    byPhrase.get(p.phrase).add(p.kind);
  }
  for (const [phrase, kinds] of byPhrase) {
    if (!kinds.has(KIND.AMBIGUOUS)) continue;
    assert.deepEqual([...kinds], [KIND.AMBIGUOUS],
      `"${phrase}" is filed as ambiguous AND as ${[...kinds].join('/')} — the unambiguous entry `
      + 'would win and the ambiguity check would never fire');
  }
});

test('every ambiguous entry names at least two candidate countries', () => {
  for (const p of phraseIndex()) {
    if (p.kind !== KIND.AMBIGUOUS) continue;
    const countries = new Set(p.candidates.map((c) => c.country));
    assert.ok(countries.size >= 2,
      `"${p.display}" is filed as ambiguous but names ${countries.size} country — file it as a city instead`);
  }
});

test('every subdivision code belongs to the country it is filed under', () => {
  for (const p of phraseIndex()) {
    if (p.kind !== KIND.SUBDIVISION || !p.code) continue;
    assert.match(p.code, /^[A-Z]{2}-[A-Z0-9]{1,3}$/, `"${p.code}" is not an ISO 3166-2 shape`);
    assert.equal(p.code.slice(0, 2), p.country, `"${p.code}" is filed under ${p.country}`);
  }
});

test('every covered country has at least one alias, and every alias folds to something', () => {
  for (const code of COVERED_COUNTRIES) {
    assert.ok(COUNTRY_ALIASES[code].length > 0, `${code} has no name`);
    for (const alias of COUNTRY_ALIASES[code]) {
      assert.notEqual(foldText(alias), '', `${code} alias "${alias}" folds to nothing`);
    }
  }
});

test("Iceland's endonym is absent, because it folds onto every US island", () => {
  assert.equal(foldText('Ísland'), 'island');
  assert.equal(countryOf(resolved('Long Island')), null);
  assert.equal(countryOf(resolved('Rhode Island')), 'US');   // the state, by name
  assert.equal(countryOf(resolved('Reykjavik')), 'IS');      // the city, which is unique
});

// ---------------------------------------------------------------------------
// Determinism and offline-ness
// ---------------------------------------------------------------------------

test('the same input always produces the same output', () => {
  for (const text of ['Berlin, Germany', 'London', 'Remote', 'San Francisco Bay Area']) {
    const a = resolved(text);
    const b = resolved(text);
    assert.deepEqual(a, b, `"${text}" is not deterministic`);
  }
});

test('the module imports nothing that could make a network call or spend a credit', () => {
  const src = readFileSync(join(REPO_ROOT, '_lib', 'jurisdiction.mjs'), 'utf8');
  const imports = [...src.matchAll(/^\s*import\s[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports, [], 'this module must stay dependency-free, offline and free');
  assert.ok(!/\bfetch\b|node:https?|richapi|ai_enrich/.test(src),
    'no network hop, no endpoint, no LLM — resolution is a local table lookup');
});

test('folding and part splitting behave the way the tables assume', () => {
  assert.equal(foldText('Île-de-France'), 'ile de france');
  assert.equal(foldText('München'), 'munchen');
  assert.equal(foldText('Łódź'), 'lodz');
  assert.equal(foldText('København'), 'kobenhavn');
  assert.deepEqual(locationParts('Berlin, Germany').map((p) => p.folded), ['berlin', 'germany']);
  assert.deepEqual(locationParts('  ,  ').map((p) => p.folded), []);
});

// ---------------------------------------------------------------------------
// The row-level proposal — what /comply reads
// ---------------------------------------------------------------------------

test('a confident resolution proposes the ISO columns comply detects on', () => {
  const p = proposeSubjectColumns({ location: 'Berlin, Germany' });
  assert.equal(p.apply, true);
  assert.deepEqual(p.columns, { subject_country: 'DE', subject_region: 'DE-BE' });
  assert.equal(p.field, 'location');
});

test('a city-only resolution proposes columns but refuses to apply them unattended', () => {
  const p = proposeSubjectColumns({ location: 'Munich' });
  assert.equal(p.apply, false, 'the least trusted table must never populate a column on its own');
  assert.deepEqual(p.columns, { subject_country: 'DE' });
  assert.ok(p.contract.confidence < AUTOFILL_MIN_CONFIDENCE);
});

test('an ambiguous or absent location proposes nothing and says why', () => {
  for (const row of [{ location: 'London' }, { location: 'Remote' }, { location: 'Sunnyvale' }, {}]) {
    const p = proposeSubjectColumns(row);
    assert.equal(p.apply, false);
    assert.deepEqual(p.columns, {});
    assert.equal(typeof p.contract.result, 'string');
    assert.ok(p.contract.reasoning.length > 0);
  }
});

test('an operator-supplied subject_country outranks the table and is never overwritten', () => {
  const p = proposeSubjectColumns({ subject_country: 'FR', location: 'Berlin, Germany' });
  assert.equal(p.apply, false);
  assert.deepEqual(p.columns, {});
  assert.equal(p.contract.result, 'not_applicable');
  assert.match(p.contract.reasoning, /already declares subject_country/);
});

test('the row helper reads the location fields it advertises, in order', () => {
  assert.ok(DEFAULT_LOCATION_FIELDS.includes('location'),
    'enrich_profile publishes `location`; the default field list must include it');
  const p = proposeSubjectColumns({ subject_location: 'Madrid, Spain', location: 'Remote' });
  assert.equal(p.field, 'subject_location');
  assert.equal(p.columns.subject_country, 'ES');
});

// ---------------------------------------------------------------------------
// The gate is unchanged — this module reports, it does not decide
// ---------------------------------------------------------------------------

test('the module never returns a regime name — only ISO codes comply then screens', () => {
  const regimes = ['gdpr', 'ccpa', 'casl'];
  for (const text of ['Berlin, Germany', 'Toronto, Ontario, Canada', 'Los Angeles, California']) {
    const got = resolved(text);
    const blob = JSON.stringify(got.result).toLowerCase();
    for (const r of regimes) {
      assert.ok(!blob.includes(r), `"${text}" leaked the regime "${r}" into a jurisdiction result — `
        + 'which regime applies is the gate table\'s decision, not this table\'s');
    }
  }
});

test('an unresolved location leaves comply exactly where it was: with nothing to detect on', () => {
  for (const text of ['London', 'Remote', 'San Francisco Bay Area', '', 'EMEA']) {
    const p = proposeSubjectColumns({ location: text });
    assert.deepEqual(p.columns, {},
      `"${text}" must contribute no detection signal, so comply's unresolved_verdict still applies`);
  }
});

// ---------------------------------------------------------------------------
// The code tables /comply reads to tell its two refusals apart.
//
// Before these existed, "this row states a country we have no rules for" and "this row
// states nothing" were the same refusal with the same fix message — and that message
// told a Seattle operator to add the `subject_country` their row already carried.
// ---------------------------------------------------------------------------

test('isCountryCode knows an assigned code from a typo, and is not a coverage table', () => {
  for (const code of ['US', 'DE', 'JP', 'BR', 'NZ', 'gb', ' fr ']) {
    assert.ok(isCountryCode(code), `${code} is an assigned ISO 3166-1 alpha-2 code`);
  }
  // JP and BR are real countries this module resolves NOTHING for. Membership here is
  // not coverage, and reading it as coverage would be the fabrication this file exists
  // to prevent.
  for (const code of ['JP', 'BR']) assert.ok(!COVERED_COUNTRIES.includes(code));
  for (const code of ['XX', 'ZZ', 'QQ', 'YY', 'USA', 'U', '', null, undefined, 'US-CA']) {
    assert.ok(!isCountryCode(code), `${JSON.stringify(code)} is not an assigned country code`);
  }
  // Every country the module DOES resolve must be an assigned code, or it is producing
  // a country nobody can act on.
  for (const code of COVERED_COUNTRIES) assert.ok(isCountryCode(code), code);
});

test('countryOfSubdivision reads the country out of an ISO 3166-2 code, and nothing else', () => {
  assert.equal(countryOfSubdivision('US-WA'), 'US');
  assert.equal(countryOfSubdivision('US-CA'), 'US');
  assert.equal(countryOfSubdivision('ca-on'), 'CA');
  assert.equal(countryOfSubdivision('AT-9'), 'AT');
  // Not a subdivision code: a bare country, free text, and a code whose country is
  // not assigned. None of these may invent a country.
  for (const v of ['US', 'Washington', 'US-', 'XX-YY', '', null, 'Seattle, WA']) {
    assert.equal(countryOfSubdivision(v), null, `${JSON.stringify(v)} produced a country`);
  }
});

// ---------------------------------------------------------------------------
// The enrichment columns, and the country NAME in them
//
// A live run on 2026-09-17 enriched a list and then could not comply-check a single
// row of it. `enrich_profile` answers with `location.country: "United States"`, which
// `_lib/client.mjs` writes into `location_country` (recorded:
// tests/fixtures/live/enrich_profile.json). `/comply` detects on `subject_country` and
// wants an ISO code, so every enriched row stopped on `unknown_jurisdiction` and the
// operator hand-mapped a column they had already paid to have filled.
//
// Four cases, because four things can be in those columns: a name, a code, a
// subdivision, and something nobody can act on.
// ---------------------------------------------------------------------------

test('a country NAME in an enrichment column resolves, so an enriched row is gate-ready', () => {
  // The exact value the recorded 200 produces.
  const live = JSON.parse(readFileSync(
    join(REPO_ROOT, 'tests', 'fixtures', 'live', 'enrich_profile.json'), 'utf8'));
  assert.equal(live.body.location.country, 'United States',
    'the recording no longer carries a country NAME — re-read it before trusting this test');

  const row = { location_country: live.body.location.country, location_state: live.body.location.state };
  const p = proposeSubjectColumns(row);
  assert.equal(p.apply, true, 'a named country is at or above the autofill floor');
  assert.equal(p.columns.subject_country, 'US');
  assert.equal(p.field, 'location_country');
  assert.equal(p.contract.result.confidence_basis, KIND.COUNTRY);
});

test('the three spellings of the United States all resolve in a country column', () => {
  for (const name of ['United States', 'USA', 'US', 'united states of america', 'U.S.']) {
    const c = resolveLocation(name, { field: 'location_country' });
    assert.equal(typeof c.result, 'object', `${name} resolved nothing`);
    assert.equal(c.result.country, 'US', name);
    assert.ok(c.confidence >= AUTOFILL_MIN_CONFIDENCE, name);
  }
});

test('a bare ISO code is read in a COUNTRY column and refused everywhere else', () => {
  // The column name is what removes the CA ambiguity. Where there is no column name
  // saying "country", the two-letter rule stands exactly as it did.
  const inColumn = resolveLocation('CA', { field: 'subject_country' });
  assert.equal(inColumn.result.country, 'CA');
  assert.equal(inColumn.result.confidence_basis, KIND.COUNTRY_CODE);
  assert.equal(inColumn.confidence, CONFIDENCE.country_code);

  for (const field of ['location', 'city', 'subject_location', 'location_state', 'subject_region']) {
    const c = resolveLocation('CA', { field });
    assert.equal(c.result, 'not_found', `${field} interpreted a bare two-letter token`);
  }
  // And an unassigned code is not a code, whatever column it sits in.
  assert.equal(resolveLocation('XX', { field: 'subject_country' }).result, 'not_found');
});

test('a subdivision code names its country, and a subdivision NAME tops up the region', () => {
  const byCode = proposeSubjectColumns({ subject_region: 'US-WA' });
  assert.deepEqual(byCode.columns, { subject_country: 'US', subject_region: 'US-WA' });
  assert.equal(byCode.contract.result.confidence_basis, KIND.SUBDIVISION_CODE);

  // US-CA is the difference between a CCPA row and a plain CAN-SPAM one, and it is
  // spelled "California" in the column the pack writes.
  const byName = proposeSubjectColumns({ location_country: 'United States', location_state: 'California' });
  assert.deepEqual(byName.columns, { subject_country: 'US', subject_region: 'US-CA' });

  // A region that disagrees with the resolved country is discarded, never believed.
  const clash = proposeSubjectColumns({ location_country: 'Germany', location_state: 'California' });
  assert.equal(clash.columns.subject_country, 'DE');
  assert.equal(clash.columns.subject_region, undefined);
});

test('an unrecognised value in a declared column is not_found, with the fix that fits it', () => {
  const country = resolveLocation('Freedonia', { field: 'location_country' });
  assert.equal(country.result, 'not_found');
  assert.equal(country.confidence, 0);
  assert.match(country.reasoning, /`location_country` is a country column/);
  assert.match(country.reasoning, /alpha-2 code in `subject_country`/,
    'the fix for a country column is a code, not "add a country column"');

  // A region column gets the OTHER fix: the full ISO form, not a country column.
  const region = resolveLocation('WA', { field: 'location_state' });
  assert.equal(region.result, 'not_found');
  assert.match(region.reasoning, /full ISO 3166-2 code/);

  // And nothing is applied, so the row reaches the gate exactly as it arrived.
  const p = proposeSubjectColumns({ location_country: 'Freedonia', location_state: 'WA' });
  assert.equal(p.apply, false);
  assert.deepEqual(p.columns, {});
});

test('a subject_country holding a NAME is resolved, not waved through as a code', () => {
  // The short circuit is for an operator-supplied CODE. A name in that column resolves
  // nothing in /comply's detection order, so leaving it alone was a silent stop.
  const p = proposeSubjectColumns({ subject_country: 'United States' });
  assert.equal(p.apply, true);
  assert.equal(p.columns.subject_country, 'US');

  // A real code still outranks everything, including a contradicting free-text field.
  const declared = proposeSubjectColumns({ subject_country: 'FR', location: 'Berlin, Germany' });
  assert.equal(declared.apply, false);
  assert.equal(declared.contract.result, 'not_applicable');
});

test('a column HEADED for a country reads any ISO country name; free text still does not', () => {
  // Live 2026-09-17: a row reading `Japan` refused as "states no country at all".
  // The curated aliases cover the countries with rule sets; refusing well needs the
  // rest, so the runtime's own ISO names fill in behind them.
  for (const [name, code] of [['Japan', 'JP'], ['Brazil', 'BR'], ['Kenya', 'KE'], ['United States', 'US']]) {
    const r = resolveLocation(name, { field: 'subject_country' });
    assert.equal(r.result?.country, code, `${name} must resolve to ${code}`);
  }
  // A name two places share is still refused rather than guessed.
  for (const name of ['Georgia', 'Ontario']) {
    assert.equal(resolveLocation(name, { field: 'subject_country' }).result, 'not_verifiable', name);
  }
  assert.equal(resolveLocation('Nowhereland', { field: 'subject_country' }).result, 'not_found');
  // And the coverage rule for FREE TEXT is untouched: the header is the promise.
  for (const text of ['Tokyo, Japan', 'Nairobi, Kenya']) {
    assert.equal(typeof resolveLocation(text, { field: 'location' }).result, 'string', text);
  }
});
