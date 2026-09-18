// bin/richapi-capture-fixtures.mjs — the field-map capture harness.
//
// The harness spends real money, so the properties tested here are the ones
// that keep it honest: it plans before it calls, it makes ZERO calls until told
// to, it refuses to run without a key and says exactly what to do about it,
// and it redacts before writing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseArgs, estimateCredits, buildRequestBody, deriveFieldMap, classifySample,
  loadEndpoints, redact
} from '../../bin/richapi-capture-fixtures.mjs';
import { fieldMap, allFieldMaps, PLACEHOLDER_FIELD_MAPS } from '../helpers/fixtures.mjs';
import { makeGtmTree } from '../helpers/tmp-tree.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const BIN = join(ROOT, 'bin', 'richapi-capture-fixtures.mjs');

/** The RAW recorded response for an endpoint (status + body), or null when absent. */
function rawCapture (endpoint) {
  const p = join(ROOT, 'tests', 'fixtures', 'live', `${endpoint}.json`);
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function runCli (args, { env = {}, allowFail = true } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, richapi_API_KEY: '', RICHAPI_API_KEY: '', ...env }
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    if (!allowFail) throw e;
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ------------------------------------------------ plan before you spend
test('default mode plans and makes ZERO HTTP calls — proven, not asserted', () => {
  // A preload that replaces global fetch with one that cannot succeed. If the
  // harness reaches the network in plan mode, the child dies here.
  const tree = makeGtmTree();
  const guard = tree.write('no-network.mjs',
    "globalThis.fetch = () => { throw new Error('NETWORK CALL ATTEMPTED IN PLAN MODE'); };\n");

  const out = execFileSync(process.execPath, ['--import', pathToFileURL(guard).href, BIN], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, richapi_API_KEY: '', RICHAPI_API_KEY: '' }
  });
  tree.cleanup();

  assert.match(out, /CAPTURE PLAN — every paid call named and costed before it runs/);
  assert.match(out, /PLAN ONLY — zero HTTP calls were made and zero credits were spent/);
  assert.doesNotMatch(out, /NETWORK CALL ATTEMPTED/);
});

test('the plan names every endpoint and prints a total', () => {
  const { code, stdout } = runCli([]);
  assert.equal(code, 0);
  assert.match(stdout, /^\s+TOTAL\s+\S+/m);
  for (const n of ['phone_finder', 'email_finder', 'email_verifier']) {
    assert.match(stdout, new RegExp(`\\b${n}\\b`), `${n} must appear in the plan`);
  }
});

test('disabled state comes from the catalog, never from a name typed into the harness', () => {
  // The harness used to hard-code post_keyword_search as disabled with a 60,000-credit
  // reason. The 2026-09-17 re-pin priced it per result on the page and the catalog
  // enabled it; the hard-coded copy kept excluding it. Law 1: the catalog decides.
  const src = readFileSync(BIN, 'utf8');
  assert.doesNotMatch(src, /post_keyword_search/, 'no endpoint name is typed into the harness');

  const catalog = JSON.parse(readFileSync(join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));
  const { endpoints } = loadEndpoints();
  for (const ep of endpoints) {
    const p = catalog.endpoints[ep.name]?.pricing;
    if (!p) continue;
    assert.equal(ep.disabledByDefault, Boolean(p.disabled_by_default), ep.name);
  }

  // A catalog that disables an endpoint is obeyed, with the catalog's own reason.
  const fake = structuredClone(catalog);
  fake.endpoints.email_finder.pricing.disabled_by_default = true;
  fake.endpoints.email_finder.pricing.disabled_reason = 'test reason from the catalog';
  const ef = loadEndpoints({ catalog: fake }).endpoints.find((e) => e.name === 'email_finder');
  assert.equal(ef.disabledByDefault, true);
  assert.equal(ef.disabledReason, 'test reason from the catalog');

  // Nothing is disabled today, so the plan names post_keyword_search as a costed row.
  const { stdout } = runCli([]);
  assert.match(stdout, /^\s+post_keyword_search\s+per_result\s+0\.1\b/m);
  assert.doesNotMatch(stdout, /disabled_by_default/);
  assert.match(runCli(['--help']).stdout, /--include-disabled/);
});

test('unbounded per-result endpoints are excluded by default', () => {
  const { stdout } = runCli([]);
  // 11 endpoints charge per result with no limit-style parameter. Their cost
  // cannot be bounded in advance, so they cannot be named-and-costed (law 3).
  for (const n of ['enrich_profiles_bulk', 'enrich_companies_bulk', 'lead_search']) {
    assert.match(stdout, new RegExp(`${n}\\s+cost cannot be bounded in advance`));
  }
  assert.match(stdout, /--include-unbounded/);
});

test('the three example-less endpoints can be costed as a narrow run', () => {
  const { code, stdout } = runCli(['--only', 'email_finder,enrich_profiles_bulk,enrich_companies_bulk', '--include-unbounded']);
  assert.equal(code, 0);
  const total = stdout.match(/TOTAL\s+(\d+(?:\.\d+)?)/)[1];
  assert.equal(Number(total), 7, 'email_finder 5 + two bulk endpoints at 1 credit for a 1-item batch');
});

// -------------------------------------------------------- refuses safely
test('--run without a key exits 2 with an actionable message and spends nothing', () => {
  const { code, stdout, stderr } = runCli(['--only', 'email_finder', '--run']);
  assert.equal(code, 2);
  assert.match(stderr, /no API key/);
  assert.match(stderr, /export richapi_API_KEY=/);
  assert.match(stderr, /approximately 5 credits/);
  assert.match(stderr, /Nothing has been called and nothing has been charged/);
  assert.match(stdout, /CAPTURE PLAN/, 'the plan is still shown, so the cost is known before the key is found');
});

test('--run in a non-interactive shell without --yes refuses rather than assuming consent', () => {
  const { code, stderr } = runCli(['--only', 'email_finder', '--run'], { env: { richapi_API_KEY: 'not-a-real-key' } });
  assert.equal(code, 2);
  assert.match(stderr, /needs an interactive terminal to confirm the cost/);
});

test('unknown arguments and unknown endpoint names are hard errors', () => {
  assert.equal(runCli(['--bogus']).code, 1);
  assert.equal(runCli(['--only', 'not_an_endpoint']).code, 1);
  assert.match(runCli(['--only', 'not_an_endpoint']).stderr, /not in the spec/);
});

test('--help exits 0 and documents the cost-before-spend contract', () => {
  const { code, stdout } = runCli(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, /makes zero HTTP requests/);
  assert.match(stdout, /Requires a typed confirmation of the\s+total credit cost/);
});

// ------------------------------------------------------------- costing
test('cost estimation follows the pricing model, not a guess', () => {
  const { endpoints } = loadEndpoints();
  const byName = Object.fromEntries(endpoints.map(e => [e.name, e]));

  assert.deepEqual(estimateCredits(byName.phone_finder, 1), { credits: 25, model: 'flat', certain: true });
  assert.deepEqual(estimateCredits(byName.search_reference_data, 1), { credits: 0, model: 'flat', certain: true });

  const bulk = estimateCredits(byName.enrich_profiles_bulk, 10);
  assert.equal(bulk.credits, 10);
  assert.equal(bulk.model, 'per_result');
  assert.equal(bulk.certain, false, 'no limit-style parameter, so the cost is not certain');

  const lead = estimateCredits(byName.lead_search, 10);
  assert.equal(lead.model, 'base_plus_per_result');
  assert.equal(lead.credits, 15, '10 base + 0.5/result x 10 — the base is charged even for zero results');
});

test('parseArgs defaults to plan mode', () => {
  const o = parseArgs([]);
  assert.equal(o.run, false);
  assert.equal(o.yes, false);
  assert.equal(o.includeDisabled, false);
  assert.equal(o.includeUnbounded, false);
  assert.equal(o.assumeResults, 1);
});

// ------------------------------------------------------ request bodies
test('request bodies are synthesised from public, non-personal placeholders', () => {
  const { endpoints } = loadEndpoints();
  const overrides = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'live', 'sample-inputs.json'), 'utf8')).inputs;
  const skipped = [];
  for (const ep of endpoints) {
    const { body, unknownFields } = buildRequestBody(ep, overrides);
    if (unknownFields.length) { skipped.push(ep.name); continue; }
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /@(gmail|yahoo|hotmail|outlook)\./i, `${ep.name} must not send a personal mailbox`);
  }
  assert.deepEqual(skipped, ['slack_channel_members'],
    'only the endpoint declared uncapturable (needs the caller\'s own Slack token) may be skipped');
});

test('a limit-style field is pinned to its minimum so per-result calls stay cheap', () => {
  const { endpoints } = loadEndpoints();
  const ps = endpoints.find(e => e.name === 'people_search');
  const { body } = buildRequestBody(ps, {});
  assert.equal(body.limit, 1);
});

// ---------------------------------------------------------- redaction
test('redaction removes PII but preserves the SHAPE — the only thing the fixture is for', () => {
  const live = {
    email: 'ada.lovelace@analytical-engines.co.uk',
    confidence: 0.94,
    provider: 'vendor-z',
    phone: '+1 (415) 555-2671',
    profile: {
      first_name: 'Ada',
      last_name: 'Lovelace',
      linkedin_url: 'https://www.linkedin.com/in/ada-lovelace-1815/',
      headline: 'Analyst at Analytical Engines',
      followers: 4200
    },
    elements: [
      { email: 'a@b.com', valid: true },
      { email: 'c@d.com', valid: false },
      { email: 'e@f.com', valid: true },
      { email: 'g@h.com', valid: true }
    ],
    _list_count: 4,
    bio: 'Reach Ada at ada.lovelace@analytical-engines.co.uk or +1 415 555 2671.'
  };
  const out = redact(live);

  // shape survives
  assert.deepEqual(Object.keys(out).sort(), Object.keys(live).sort());
  assert.equal(typeof out.confidence, 'number');
  assert.equal(out.confidence, 0.94, 'non-PII values are untouched — they are the field map');
  assert.equal(out.provider, 'provider_1', 'an upstream provider name is aliased');
  assert.equal(out._list_count, 4, 'the billing field must survive redaction');
  assert.equal(typeof out.elements[0].valid, 'boolean');
  assert.deepEqual(Object.keys(out.profile).sort(), Object.keys(live.profile).sort());
  assert.equal(out.profile.followers, 4200);

  // PII does not
  assert.equal(out.email, 'redacted@example.invalid');
  assert.equal(out.phone, '+10000000000');
  assert.equal(out.profile.first_name, 'REDACTED');
  assert.equal(out.profile.last_name, 'REDACTED');
  assert.equal(out.profile.linkedin_url, 'https://www.linkedin.com/in/REDACTED/');
  assert.equal(out.profile.headline, 'REDACTED');

  // free text is scrubbed too, not just keyed fields
  assert.doesNotMatch(out.bio, /ada\.lovelace/);
  assert.doesNotMatch(out.bio, /555/);

  // no original value survives anywhere
  const serialised = JSON.stringify(out);
  for (const leak of ['ada.lovelace', 'analytical-engines.co.uk', 'Lovelace', '4155552671', 'ada-lovelace-1815']) {
    assert.equal(serialised.includes(leak), false, `"${leak}" leaked into the committed fixture`);
  }
});

test('redaction caps long arrays so a committed fixture stays a sample, not a dataset', () => {
  const out = redact({ elements: Array.from({ length: 50 }, (_, i) => ({ email: `p${i}@x.com` })) });
  assert.equal(out.elements.length, 3);
});

// -------------------------------------------------------- field maps
test('a response with real values yields a live field map', () => {
  const { fieldMap: fm, unmapped } = deriveFieldMap({ email: 'a@b.com', confidence: 0.9, provider: 'p1', mystery_key: 1 });
  assert.deepEqual(fm, { email: 'email', confidence: 'confidence', provider: 'provider' });
  assert.deepEqual(unmapped, ['mystery_key'], 'an unrecognised key is surfaced, never given a plausible name nobody verified');
});

test('an all-null response is classified as a miss, not a field map', () => {
  assert.equal(classifySample({ email: null, confidence: null, provider: null }), 'miss');
  assert.equal(classifySample({ email: 'a@b.com' }), 'hit');
  assert.equal(classifySample({}), 'empty_object');
  assert.equal(classifySample({ error: 'Insufficient credits' }), 'error_body');
});

test('the remaining uncaptured endpoints ship hand-authored placeholders, not invented field maps', () => {
  // Empty since 2026-09-17: both bulk endpoints were recorded. The loop still guards
  // any endpoint that is added back to the list.
  assert.deepEqual([...PLACEHOLDER_FIELD_MAPS], []);
  for (const name of PLACEHOLDER_FIELD_MAPS) {
    const fm = fieldMap(name);
    assert.ok(fm, `${name} placeholder field map must exist so downstream work is unblocked`);
    assert.equal(fm.field_map_status, 'TODO_no_usable_example',
      `${name} must declare the gap; the api-catalog contract allows exactly this status`);
    assert.equal(fm.field_map, null, 'a placeholder must not contain an invented map (law 2)');
    assert.equal(fm.source, 'hand_authored_placeholder');
    assert.ok(fm.why_placeholder.length > 40, 'it must say WHY, or someone will "fix" it by guessing');
    assert.ok(Array.isArray(fm.unknown_until_captured) && fm.unknown_until_captured.length > 0);
    assert.match(fm.how_to_resolve, /richapi-capture-fixtures\.mjs/, 'it must name the command that resolves it');
  }
});

test('email_finder is now a RECORDING, and the recording contradicted the spec', () => {
  // This test used to assert that email_finder shipped a hand-authored placeholder
  // carrying the spec's key names (`confidence`, `email`, `provider`) and a proposal
  // marked UNVERIFIED. The 2026-08-31 capture replaced it, and settled the question the
  // "UNVERIFIED" marker existed to flag: the server answers
  // {success, result:{email, email_status, esp}, provider, providers_tried, execution_log}.
  //
  // Two of the three spec key names were wrong. `email` is real but one level down, and
  // `confidence` does not exist at all. The map read the top level, so a 5-credit call
  // returned the provider name and threw the address away.
  const fm = fieldMap('email_finder');
  assert.equal(fm.source, 'live_capture', 'a recording, not a placeholder');
  assert.equal(fm.field_map_status, 'live_fixture');
  assert.equal(fm.sample_status, 'hit', 'the recorded sample found an address');
  assert.ok(fm.observed_types.result === 'object',
    'the payload is wrapped in `result` — the fact the spec did not record');
  assert.ok(!('confidence' in fm.observed_types),
    '`confidence` was a spec fiction; the server never sends it');
});

test('the bulk endpoints are recorded: a bare array, and no billing field in it', () => {
  // They used to ship placeholders because the spec has no 200 example for either. The
  // 2026-09-17 run recorded both. The body is a bare array, and `_list_count` — the field
  // x-pricing bills against — is not in it, so every ledger row stays
  // estimated_unverifiable (law 4).
  for (const name of ['enrich_profiles_bulk', 'enrich_companies_bulk']) {
    const fm = fieldMap(name);
    assert.equal(fm.source, 'live_capture', name);
    assert.equal(fm.field_map_status, 'live_fixture', name);
    assert.equal(fm.observed_types._root, 'array', `${name} answers a bare array`);
    assert.equal(fm.billing_field, '_list_count');
    assert.equal(fm.billing_field_present_in_response, false,
      'recorded absent — every ledger row here is estimated_unverifiable');
    assert.ok(Array.isArray(rawCapture(name).body), `${name}: the raw capture is an array`);
  }
});

test('a live_fixture status exists only where a recording backs it', () => {
  // INVERTED 2026-08-31. This test used to assert that NO live response had been
  // captured. One has — 55 of them — so the invariant that survives is the one that
  // always mattered: the two statuses may never disagree with the `source` field, in
  // either direction. A `live_fixture` with no recording is a fabricated field map; a
  // recording still labelled `hand_authored_placeholder` hides real evidence.
  const all = allFieldMaps();
  assert.ok(Object.keys(all).length > 0, 'there is a corpus to check');

  for (const [name, m] of Object.entries(all)) {
    if (m.source === 'live_capture') {
      // A capture only teaches the RESPONSE SHAPE when it succeeded. The 2026-08-31 run
      // also recorded 4xx bodies and 201 async acknowledgements; those say the endpoint
      // exists and that the inputs were wrong, which is worth keeping and is NOT
      // evidence about what a successful answer looks like. So the status is gated on
      // the raw capture's HTTP status, not on the mere existence of a recording.
      // UPDATED 2026-09-17: any 2xx counts — the scrapers answer 201 with the full,
      // billed result — and a bare-array body is a body.
      const raw = rawCapture(name);
      const succeeded = raw && raw.http_status >= 200 && raw.http_status < 300
        && raw.body !== null && typeof raw.body === 'object';
      if (succeeded) {
        assert.equal(m.field_map_status, 'live_fixture',
          `${name} recorded a 2xx but does not say so in its status`);
        assert.equal(m.field_map_derived, m.field_map !== null,
          `${name}: field_map_derived must say whether a semantic map was read off it`);
        assert.ok(m.captured_at, `${name} is a recording with no capture timestamp`);
        assert.ok(m.observed_types && Object.keys(m.observed_types).length > 0,
          `${name} claims a recording but records no observed shape`);
      } else {
        assert.notEqual(m.field_map_status, 'live_fixture',
          `${name} claims live_fixture off a ${raw ? raw.http_status : 'missing'} capture — `
          + 'a non-200 is not evidence about the shape of a successful response');
      }
    } else {
      assert.equal(m.source, 'hand_authored_placeholder', `${name}: unknown provenance`);
      assert.notEqual(m.field_map_status, 'live_fixture',
        `${name} claims live_fixture without a live capture — a fabricated field map`);
      assert.equal(m.field_map, null, 'a placeholder must not contain an invented map (law 2)');
    }
  }

  // And the placeholder list is exactly what is left, so it cannot silently rot.
  const stillPlaceholders = Object.entries(all)
    .filter(([, m]) => m.source === 'hand_authored_placeholder').map(([n]) => n).sort();
  assert.deepEqual(stillPlaceholders, [...PLACEHOLDER_FIELD_MAPS].sort());
});

test('a recorded 200 is exactly what the catalog absorbs, and nothing else is', () => {
  // The join between the two halves of the absorption: the recordings on disk, and the
  // `live_fixture` rows in the generated catalog. If they disagree, either the catalog
  // is claiming evidence it does not have or a recording is being thrown away.
  const catalog = JSON.parse(readFileSync(join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));
  const absorbed = Object.entries(catalog.endpoints)
    .filter(([, e]) => e.field_map_status === 'live_fixture').map(([n]) => n).sort();

  const digest = JSON.parse(readFileSync(join(ROOT, '_lib', 'live-field-maps.json'), 'utf8'));
  assert.deepEqual(absorbed, Object.keys(digest.endpoints).sort(),
    'the catalog absorbs exactly the digest, no more and no less');

  for (const name of absorbed) {
    const raw = rawCapture(name);
    assert.ok(raw && raw.http_status >= 200 && raw.http_status < 300,
      `${name} is live_fixture in the catalog but has no recorded 2xx behind it`);
    assert.ok((catalog.endpoints[name].field_map_keys ?? []).length > 0,
      `${name} claims a recording and publishes no paths from it`);
  }
});

// ---------------------------------------------------------------------------
// Identity redaction — the gap that put a real person in a test fixture
// ---------------------------------------------------------------------------

test('the redactor covers CONCATENATED identity keys, not just snake_case ones', () => {
  // `PII_KEY` is anchored on `(^|_)` … `($|_)`, so it matched `first_name` and NOT
  // `firstname` — which is the form the server actually sends. Same root cause as the
  // 2026-09-02 response-map defect: a pattern written for the spec's shape rather than
  // the wire's. The 2026-08-31 run therefore wrote a real, non-public person's name and
  // LinkedIn identifier into a fixture while stamping it `redacted: true`.
  const out = redact({
    firstname: 'Cristian', lastname: 'Giardina', middleName: 'X',
    identifier: 'cristian-giardina-67a620243',
    entityUrn: 'ACoAADxtHb4BEN9ECB1OfO84hkGUiu2gszOUdJw',
    objectUrn: 1013783998,
  });
  for (const k of ['firstname', 'lastname', 'identifier', 'entityUrn']) {
    assert.equal(out[k], 'REDACTED', `${k} must be redacted`);
  }
  assert.equal(out.objectUrn, 0,
    'a NUMERIC identifier never reached the string branch, so it survived untouched');
});

test('business names stay readable — over-redaction makes a fixture useless', () => {
  // A company name is a business fact, not personal data. Redacting it would strip the
  // fixture of the thing it exists to demonstrate.
  const out = redact({ companyName: 'Acme Corp', universalName: 'acme', name: 'Acme' });
  assert.equal(out.companyName, 'Acme Corp');
  assert.equal(out.universalName, 'acme');
});

test('no recorded capture carries an identity except the documented demo target', () => {
  // The `unclaimed:` pattern, applied to PII: a real identity in the corpus is allowed
  // ONLY when it is listed here with a reason. A deliberate exception and an accidental
  // leak must never look alike.
  //
  // This pack ships a /comply skill about establishing a lawful basis before contacting
  // someone. An unconsented individual sitting in its own test fixtures is the exact
  // thing that skill warns about, so the bar here is higher than "probably fine".
  const ALLOWED = {
    'enrich_profile.json':
      'Bill Gates / williamhgates. A public figure, deliberately chosen as the demo '
      + 'target in sample-inputs.json, and the recorded profile shape is materially more '
      + 'legible with a real one in it. Reviewed and kept on 2026-09-02.',
  };

  const dir = join(ROOT, 'tests', 'fixtures', 'live');
  const offenders = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue;
    const src = readFileSync(join(dir, file), 'utf8');
    const values = (key) => [...src.matchAll(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`, 'g'))]
      .map((m) => m[1])
      .filter((v) => !/^REDACTED$/i.test(v) && !/example|redacted/i.test(v));
    const found = [...values('firstname'), ...values('lastname'), ...values('identifier')];
    if (found.length && !ALLOWED[file]) {
      offenders.push(`${file}: ${found.join(', ')}`);
    }
  }
  assert.deepEqual(offenders, [],
    'a recorded capture carries a real identity that is not on the allowlist. Redact it, '
    + 'or add it to ALLOWED with the reason it is defensible to ship.');

  for (const [file, reason] of Object.entries(ALLOWED)) {
    assert.ok(existsSync(join(dir, file)), `${file} is allowlisted but is not on disk`);
    assert.ok(reason.length > 80, `${file}: an allowlist entry needs a real reason`);
  }
});

test('redaction replaces upstream provider names with stable aliases', () => {
  const body = {
    provider: 'vendor-x',
    execution_log: [{ provider: 'vendor-y' }, { provider: 'vendor-y' }, { provider: 'vendor-x' }],
  };
  const out = redact(body);
  assert.equal(out.provider, 'provider_1');
  assert.deepEqual(out.execution_log.map((e) => e.provider), ['provider_2', 'provider_2', 'provider_1']);
  assert.equal(redact({ provider: 'openai' }).provider, 'openai', 'a model provider the caller chose is public');
});

test('no committed recording names an upstream data provider', () => {
  const dir = join(HERE, 'live');
  const found = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const names = [...readFileSync(join(dir, f), 'utf8').matchAll(/"(?:provider|providers?_used|vendor)"\s*:\s*"([^"]+)"/gi)]
      .map((m) => m[1])
      .filter((n) => !/^(provider(_\d+)?|string|openai|anthropic|gemini|google|perplexity)$/i.test(n));
    if (names.length) found.push(`${f}: ${[...new Set(names)].join(', ')}`);
  }
  assert.deepEqual(found, []);
});

test('redaction keeps long digit runs that are identifiers, and still masks phone numbers', () => {
  const out = redact({
    urn: 'urn:li:activity:7506360360753364993',
    id: 'urn:li:comment:(ugcPost:7506353323579457536,7506381025418231808)',
    url: 'https://www.example.com/posts/acme_launch-activity-7506360360753364993-AbCd',
    note: 'Call us on +1 415 555 2671 today',
  });
  assert.equal(out.urn, 'urn:li:activity:7506360360753364993');
  assert.equal(out.id, 'urn:li:comment:(ugcPost:7506353323579457536,7506381025418231808)');
  assert.match(out.url, /activity-7506360360753364993-/);
  assert.equal(out.note, 'Call us on +10000000000 today');
});

test('redaction leaves dates and bare ids alone, and masks phone fields by key', () => {
  const out = redact({
    start: '2026-09-17T00:00:00.000Z',
    id: '15512345678901',
    phoneUnformatted: '4155552671',
    phone: '(415) 555-2671',
  });
  assert.equal(out.start, '2026-09-17T00:00:00.000Z');
  assert.equal(out.id, '15512345678901');
  assert.equal(out.phoneUnformatted, '+10000000000');
  assert.equal(out.phone, '+10000000000');
});

test('redaction masks what a person wrote and pictures of them', () => {
  const out = redact({
    comment: 'Great insights from a real person',
    commentary: 'A post body',
    profilePicture: 'https://media.licdn.com/dms/image/abc',
    note: 'see https://media.licdn.com/dms/image/xyz here',
    title: 'Microsoft Frontier Playbook',
  });
  assert.equal(out.comment, 'REDACTED');
  assert.equal(out.commentary, 'REDACTED');
  assert.equal(out.profilePicture, 'https://media.example.invalid/REDACTED');
  assert.equal(out.note, 'see https://media.example.invalid/REDACTED here');
  assert.equal(out.title, 'Microsoft Frontier Playbook');
});
