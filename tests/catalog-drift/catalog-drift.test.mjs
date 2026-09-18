// richapi-catalog-drift: the pinned catalog vs the server's own catalog table.
//
// Verify criterion: every severity class fires against a purpose-built fixture, only
// the blocking classes exit non-zero, and the two REAL drift bugs that motivated the
// oracle are caught.
//
// Every fixture is a delta on `fixtures/live-baseline.json`, a verbatim slice of the
// live payload, against `fixtures/pinned-baseline.json`, a verbatim slice of the
// generated catalog. Both are FROZEN snapshots: nothing here reads
// `_lib/api-catalog.json` or the network, so a later repair of the live tree cannot
// make these tests stop testing what they were written to test.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  DRIFT_BLOCKING,
  DRIFT_SEVERITY,
  UnusableCatalogError,
  adaptLiveCatalog,
  driftCheck,
  formatDriftReport,
} from '../../bin/richapi-catalog-drift.mjs';
import { SEVERITY } from '../../_lib/catalog/diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(HERE, 'fixtures');

const PINNED = JSON.parse(fs.readFileSync(path.join(FIX, 'pinned-baseline.json'), 'utf8'));
const LIVE = JSON.parse(fs.readFileSync(path.join(FIX, 'live-baseline.json'), 'utf8'));
const REAL_DRIFT = JSON.parse(fs.readFileSync(path.join(FIX, 'live-real-drift.json'), 'utf8'));

/** Clone the live payload and apply one purpose-built server-side mutation. */
function live(mutate) {
  const next = structuredClone(LIVE);
  const byName = Object.fromEntries(next.tools.map((t) => [t.name, t]));
  mutate(byName, next);
  next.tools = Object.values(byName).sort((a, b) => a.name.localeCompare(b.name));
  next.total = next.tools.length;
  return next;
}

/** Clone the pinned catalog. Used only where the SPEC side is the thing that moved. */
function pinned(mutate) {
  const next = structuredClone(PINNED);
  mutate(next.endpoints, next);
  return next;
}

const classesOf = (r) => r.changes.map((c) => c.class).sort();
const only = (r, cls) => r.changes.filter((c) => c.class === cls);

// --- the severity contract ------------------------------------------------------

test('the shared severity vocabulary is reused verbatim, not forked', () => {
  // Every class _lib/catalog/diff.mjs defines keeps exactly the level it defines.
  // Two vocabularies in one repo is how one of them rots.
  for (const [cls, level] of Object.entries(SEVERITY)) {
    assert.equal(DRIFT_SEVERITY[cls], level, `${cls} must keep its absorb-mode severity`);
  }
});

test('drift adds exactly two classes, and they are the required-field pair', () => {
  const extra = Object.keys(DRIFT_SEVERITY).filter((k) => !(k in SEVERITY)).sort();
  assert.deepEqual(extra, ['REQUIRED_FIELD_ADDED', 'REQUIRED_FIELD_REMOVED']);
  // A field the server started requiring is a call-time 400 for every skill — the same
  // failure mode as REMOVED_UNMAPPED, which already blocks. Relaxing one is backwards
  // compatible, so it warns.
  assert.equal(DRIFT_SEVERITY.REQUIRED_FIELD_ADDED, 'block');
  assert.equal(DRIFT_SEVERITY.REQUIRED_FIELD_REMOVED, 'warn');
});

test('exactly four classes block', () => {
  assert.deepEqual(DRIFT_BLOCKING, [
    'PRICING_SEMANTICS_CHANGED',
    'REMOVED_UNMAPPED',
    'REPRICED_MAJOR',
    'REQUIRED_FIELD_ADDED',
  ]);
});

// --- fidelity: the adapter must not invent drift --------------------------------

test('the real live payload adapts to the real pinned catalog with ZERO changes', () => {
  const r = driftCheck(PINNED, LIVE);
  assert.deepEqual(r.changes, [], `spurious drift: ${JSON.stringify(r.summary)}`);
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.counts, { pinned: 10, live: 10 });
});

test('adaptation reproduces every compared field of the pinned catalog exactly', () => {
  // This is the claim the whole oracle rests on: the live table is run through the
  // SAME extractor that built the pinned catalog from the spec, so a reported
  // difference is a real server-vs-pin difference and not two parsers disagreeing.
  //
  // `capability_group` is deliberately NOT asserted here. It is not derived from either
  // catalog — it is looked up in _lib/catalog/taxonomy.mjs, an editorial table that is
  // edited by hand. At runtime both sides of the diff read the same table on the same run,
  // so it can never produce spurious drift; here the pinned side is a frozen snapshot
  // and the live side is computed fresh, so asserting equality would only measure how
  // long ago the fixture was captured. (It already caught one such edit mid-task.)
  // `diffCatalogs` does not compare it either.
  const { catalog, unobservableBillingField } = adaptLiveCatalog(LIVE, { pinned: PINNED });
  assert.deepEqual(Object.keys(catalog.endpoints), Object.keys(PINNED.endpoints));
  // Same reasoning for `disabled_by_default` / `disabled_reason`: those are OUR seed
  // list in _lib/catalog/generate.mjs, not anything the server publishes, so the live
  // side never carries them and comparing them would measure our own edits.
  const wire = ({ disabled_by_default, disabled_reason, ...rest }) => rest;
  for (const [name, want] of Object.entries(PINNED.endpoints)) {
    const got = catalog.endpoints[name];
    assert.deepEqual(wire(got.pricing), wire(want.pricing), `${name} pricing`);
    assert.deepEqual(got.required_request_fields, want.required_request_fields, `${name} required`);
    assert.equal(got.path, want.path, `${name} path`);
    assert.equal(got.max_batch, want.max_batch, `${name} max_batch`);
    assert.equal(got.bulk_variant, want.bulk_variant, `${name} bulk_variant`);
  }
  // The one field the wire cannot express, named rather than silently faked. Widened
  // 2026-09-17 to EVERY endpoint: the flag now means "a recorded 2xx body carried a
  // billing field", and a price list is a recording of nothing, so the live side is
  // evidence about it for no row. It used to list only the metered four, because flat
  // rows were `true` by construction on both sides and so could not drift.
  assert.deepEqual(unobservableBillingField, Object.keys(PINNED.endpoints).sort());
});

test('billing-field presence is carried forward, never fabricated from a missing example', () => {
  // The live catalog carries no response bodies, so the extractor derives `false` for
  // every row. Letting that stand would report a PRICING_SEMANTICS_CHANGED BLOCK
  // ("billing field disappeared") on a clean run — a lie, and a gate that lies gets
  // switched off. LAW #4: never fabricate an actual.
  //
  // The carry-forward covers FLAT rows too since 2026-09-17. This assertion fails
  // against the old METERED-only loop: `ai_enrich` is flat, the pin below says true,
  // and the extractor now derives false for it.
  const { catalog } = adaptLiveCatalog(LIVE, { pinned: PINNED });
  assert.equal(catalog.endpoints.lead_search.pricing.billing_field_present_in_response, true);
  assert.equal(catalog.endpoints.ai_enrich.pricing.billing_field_present_in_response, true,
    'a flat pin is carried forward exactly like a metered one');
  assert.equal(catalog.endpoints.enrich_profiles_bulk.pricing.billing_field_present_in_response, false);

  // Without the pinned side to carry forward, the derived value stands and is listed.
  const bare = adaptLiveCatalog(LIVE, { pinned: null });
  assert.equal(bare.catalog.endpoints.lead_search.pricing.billing_field_present_in_response, false);
  assert.equal(bare.catalog.endpoints.ai_enrich.pricing.billing_field_present_in_response, false);
  assert.ok(bare.unobservableBillingField.includes('lead_search'));
});

// --- TWO SYNTHETIC DRIFTS -------------------------------------------------------
//
// Both were once believed to be real drifts observed on the server. Neither is:
// measured 2026-08-30, profile_social_metrics IS in the live catalog and answers 401
// (route exists, behind auth) like the enrich_company control, and company_enricher is
// NOT in the live catalog and answers 404. See fixtures/live-real-drift.json.
// The fixtures and every assertion below are unchanged and still correct — they prove
// the oracle FIRES on each drift class. Only the claim that they were observed is gone.

test('REMOVED_UNMAPPED fires when a pinned endpoint is missing from the server', () => {
  const r = driftCheck(PINNED, REAL_DRIFT);
  const removed = only(r, 'REMOVED_UNMAPPED');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].endpoint, 'profile_social_metrics');
  assert.equal(removed[0].severity, 'block');
  assert.equal(r.exitCode, 1, 'an endpoint the pack routes to that the server does not serve MUST block');
  assert.match(
    formatDriftReport(r, { pinnedLabel: 'pinned', liveLabel: 'live' }),
    /BLOCK REMOVED_UNMAPPED[\s\S]*profile_social_metrics/
  );
});

test('ADDED fires when the server carries an endpoint the pin does not', () => {
  const r = driftCheck(PINNED, REAL_DRIFT);
  const added = only(r, 'ADDED');
  assert.equal(added.length, 1);
  assert.equal(added[0].endpoint, 'company_enricher');
  // Visible, not fatal: skills route through the catalog, so an endpoint absent from
  // the catalog cannot be called and cannot spend a credit. Lost capability, not risk.
  assert.equal(added[0].severity, 'info');
  assert.equal(r.summary.ADDED, 1);
  assert.match(
    formatDriftReport(r, { pinnedLabel: 'pinned', liveLabel: 'live' }),
    /info  ADDED[\s\S]*company_enricher/
  );
});

test('the two drifts together produce exactly one blocker and one notice', () => {
  const r = driftCheck(PINNED, REAL_DRIFT);
  assert.deepEqual(classesOf(r), ['ADDED', 'REMOVED_UNMAPPED']);
  assert.equal(r.blocking.length, 1);
  // The pair is not a rename in disguise, and must not be reported as one.
  assert.deepEqual(r.renameHints, []);
});

// --- one fixture per remaining class --------------------------------------------

test('REPRICED_MINOR fires under 2x, in both directions, and does not block', () => {
  const up = driftCheck(PINNED, live((t) => { t.web_scrape.pricing.credits_per_call = 1.5; }));
  assert.deepEqual(classesOf(up), ['REPRICED_MINOR']);
  assert.equal(only(up, 'REPRICED_MINOR')[0].ratio, 1.5);
  assert.equal(up.exitCode, 0);

  const down = driftCheck(PINNED, live((t) => { t.phone_finder.pricing.credits_per_call = 3; }));
  assert.deepEqual(classesOf(down), ['REPRICED_MINOR']);
  assert.equal(down.exitCode, 0, 'a price CUT is never worth a human decision');
});

test('REPRICED_MAJOR fires at >=2x and BLOCKS — the measured phone_finder 3 -> 25', () => {
  // The event the whole pack is calibrated against, run in the direction drift sees it:
  // the pin still says 3, the server is already charging 25.
  const stalePin = pinned((e) => { e.phone_finder.pricing.credits_per_call = 3; });
  const r = driftCheck(stalePin, LIVE);
  assert.deepEqual(classesOf(r), ['REPRICED_MAJOR']);
  const [row] = only(r, 'REPRICED_MAJOR');
  assert.equal(row.from_credits, 3);
  assert.equal(row.to_credits, 25);
  assert.equal(row.ratio, 8.333);
  assert.equal(r.exitCode, 1);

  // The boundary: exactly 2x blocks, a hair under does not.
  assert.equal(driftCheck(PINNED, live((t) => { t.web_scrape.pricing.credits_per_call = 2; })).exitCode, 1);
  assert.equal(driftCheck(PINNED, live((t) => { t.web_scrape.pricing.credits_per_call = 1.9; })).exitCode, 0);

  // Per-result endpoints compare on the per-result rate, not on a call price.
  const perResult = driftCheck(PINNED, live((t) => { t.profile_search.pricing.credits_per_result = 0.4; }));
  assert.deepEqual(classesOf(perResult), ['REPRICED_MAJOR']);
  assert.equal(perResult.exitCode, 1);
});

test('PRICING_SEMANTICS_CHANGED fires when the bill is computed a new way, and BLOCKS', () => {
  // per_result -> flat: every estimate the pack ever wrote used the other formula.
  const model = driftCheck(PINNED, live((t) => {
    t.profile_search.pricing = { credits_per_call: 5 };
  }));
  assert.deepEqual(classesOf(model), ['PRICING_SEMANTICS_CHANGED']);
  assert.match(only(model, 'PRICING_SEMANTICS_CHANGED')[0].reasons[0], /per_result -> flat/);
  assert.equal(model.exitCode, 1);

  // The count field the charge is computed from moved.
  const countField = driftCheck(PINNED, live((t) => {
    t.profile_search.pricing.result_count_field = 'totalElements';
  }));
  assert.deepEqual(classesOf(countField), ['PRICING_SEMANTICS_CHANGED']);
  assert.match(only(countField, 'PRICING_SEMANTICS_CHANGED')[0].reasons[0], /elements -> totalElements/);
  assert.equal(countField.exitCode, 1);

  // The base appearing on a previously per-result endpoint.
  const base = driftCheck(PINNED, live((t) => {
    t.profile_search.pricing = { base_credits_per_call: 10, credits_per_result: 0.1, result_count_field: 'elements' };
  }));
  assert.equal(base.exitCode, 1);
  assert.ok(only(base, 'PRICING_SEMANTICS_CHANGED').length);
});

test('losing the result-limit parameter is a semantics change and BLOCKS', () => {
  // people_search is metered and bounded only because it declares `limit`. If the
  // server drops it, spend per call is no longer bounded — the one shape of drift that
  // turns a costed call into an open-ended one.
  const r = driftCheck(PINNED, live((t) => { delete t.people_search.input_schema.limit; }));
  assert.ok(classesOf(r).includes('PRICING_SEMANTICS_CHANGED'));
  assert.match(
    only(r, 'PRICING_SEMANTICS_CHANGED')[0].reasons.join(' '),
    /spend is no longer bounded/
  );
  assert.equal(r.exitCode, 1);
});

test('REQUIRED_FIELD_ADDED fires and BLOCKS — the pack cannot build a valid request', () => {
  const r = driftCheck(PINNED, live((t) => { t.web_scrape.input_schema.formats.required = true; }));
  assert.deepEqual(classesOf(r), ['REQUIRED_FIELD_ADDED']);
  const [row] = only(r, 'REQUIRED_FIELD_ADDED');
  assert.equal(row.endpoint, 'web_scrape');
  assert.deepEqual(row.fields, ['formats']);
  assert.equal(r.exitCode, 1);
});

test('REQUIRED_FIELD_REMOVED fires and does NOT block — relaxing is compatible', () => {
  const r = driftCheck(PINNED, live((t) => { t.enrich_profile.input_schema.url.required = false; }));
  assert.deepEqual(classesOf(r), ['REQUIRED_FIELD_REMOVED']);
  assert.deepEqual(only(r, 'REQUIRED_FIELD_REMOVED')[0].fields, ['url']);
  assert.equal(r.exitCode, 0);
});

test('required-field drift is only reported for endpoints BOTH sides know about', () => {
  // An endpoint that is only on one side is REMOVED_UNMAPPED / ADDED business. Counting
  // its whole required set as "added" or "removed" would double-report one event.
  const r = driftCheck(PINNED, REAL_DRIFT);
  assert.equal(r.summary.REQUIRED_FIELD_ADDED, undefined);
  assert.equal(r.summary.REQUIRED_FIELD_REMOVED, undefined);
});

// --- the two deliberate deviations from absorb mode -----------------------------

test('a server-side rename is a BLOCK, not a warn — drift mode absorbs nothing', () => {
  // In absorb mode `web_scrape -> web_scraper` is a warn: the fix is mechanical and
  // lands in the same pass. Here nothing lands. The old name is dead on the wire and
  // every skill routing to it fails, exactly as if it had been deleted.
  const r = driftCheck(PINNED, live((t, payload) => {
    t.web_scraper = { ...structuredClone(t.web_scrape), name: 'web_scraper', api_path: 'web_scraper' };
    delete t.web_scrape;
    void payload;
  }));
  assert.deepEqual(classesOf(r), ['ADDED', 'REMOVED_UNMAPPED']);
  assert.equal(r.summary.RENAMED, undefined, 'RENAMED must never fire in drift mode');
  assert.equal(r.exitCode, 1);

  // No information is lost: the fuzzy match is still computed and printed as a hint.
  assert.equal(r.renameHints.length, 1);
  assert.equal(r.renameHints[0].from, 'web_scrape');
  assert.equal(r.renameHints[0].to, 'web_scraper');
  assert.match(
    formatDriftReport(r, { pinnedLabel: 'pinned', liveLabel: 'live' }),
    /likely renamed to `web_scraper`/
  );
});

test('DEPRECATED cannot fire, and the report says so instead of implying coverage', () => {
  // The live catalog carries no deprecation flag. Reporting "nothing deprecated" would
  // be a claim the wire does not support (law 6).
  const r = driftCheck(PINNED, LIVE);
  assert.equal(r.summary.DEPRECATED, undefined);
  const report = formatDriftReport(r, { pinnedLabel: 'pinned', liveLabel: 'live' });
  assert.match(report, /not compared — the live catalog does not carry it/);
  assert.match(report, /deprecation flags, so the DEPRECATED class cannot fire/);
  assert.match(report, /billing_field_present_in_response is carried forward/);
});

// --- refusing to read a payload it cannot trust ---------------------------------

test('a truncated payload is REFUSED, not read as a mass removal', () => {
  // A short read would otherwise present as nine REMOVED_UNMAPPED blocks — CI red on a
  // lie, which is worse than CI silent on an outage.
  const truncated = structuredClone(LIVE);
  truncated.tools = truncated.tools.slice(0, 3);
  assert.throws(() => driftCheck(PINNED, truncated), UnusableCatalogError);
  assert.throws(() => driftCheck(PINNED, truncated), /truncated/);
});

test('a payload with no tools array, no tools, or an unnamed tool is REFUSED', () => {
  assert.throws(() => driftCheck(PINNED, { ok: true }), UnusableCatalogError);
  assert.throws(() => driftCheck(PINNED, { tools: [], total: 0 }), UnusableCatalogError);
  const unnamed = structuredClone(LIVE);
  delete unnamed.tools[0].name;
  assert.throws(() => driftCheck(PINNED, unnamed), /no `name`/);
});

test('a payload with no `total` is accepted — the guard must not require the field', () => {
  const noTotal = structuredClone(LIVE);
  delete noTotal.total;
  assert.equal(driftCheck(PINNED, noTotal).exitCode, 0);
});

// --- fixtures stay frozen -------------------------------------------------------

test('the fixtures reproduce both drifts independently of the live tree', () => {
  // _lib/api-catalog.json gets repaired over time. These tests must keep testing the
  // drift they were written for regardless, so the fixtures carry the endpoints themselves.
  assert.ok('profile_social_metrics' in PINNED.endpoints, 'pinned fixture must keep the bug');
  assert.ok(!REAL_DRIFT.tools.some((t) => t.name === 'profile_social_metrics'));
  assert.ok(REAL_DRIFT.tools.some((t) => t.name === 'company_enricher'));
  assert.ok(!('company_enricher' in PINNED.endpoints));
  for (const f of ['pinned-baseline.json', 'live-baseline.json', 'live-real-drift.json']) {
    const j = JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'));
    assert.equal(typeof j._provenance, 'string', `${f} must record where it came from`);
    assert.ok(j._provenance.length > 80, `${f} provenance must actually say something`);
  }
});
