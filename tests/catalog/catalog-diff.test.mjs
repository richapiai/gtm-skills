// richapi-catalog-diff.
// Verify criterion: each severity class fires against its purpose-built fixture, and
// only REPRICED_MAJOR / REMOVED_UNMAPPED / PRICING_SEMANTICS_CHANGED block.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { BLOCKING, SEVERITY, diffCatalogs, matchRenames, similarity } from '../../_lib/catalog/diff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BASE = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'diff-base.json'), 'utf8'));

/** Clone the base catalog and apply one purpose-built mutation. */
function fixture(mutate) {
  const next = structuredClone(BASE);
  mutate(next.endpoints, next);
  return next;
}

function classesOf(result) {
  return result.changes.map((c) => c.class).sort();
}

function only(result, cls) {
  return result.changes.filter((c) => c.class === cls);
}

// --- the severity contract ------------------------------------------------------

test('exactly three classes block, and they are the three the plan names', () => {
  assert.deepEqual([...BLOCKING].sort(), [
    'PRICING_SEMANTICS_CHANGED',
    'REMOVED_UNMAPPED',
    'REPRICED_MAJOR',
  ]);
  assert.equal(SEVERITY.RENAMED, 'warn');
  assert.equal(SEVERITY.REPRICED_MINOR, 'warn');
  assert.equal(SEVERITY.DEPRECATED, 'warn');
  assert.equal(SEVERITY.ADDED, 'info');
});

// --- one fixture per class ------------------------------------------------------

test('RENAMED fires, is auto-PR-able, and does not block', () => {
  const next = fixture((e) => {
    e.google_maps_places_scraper_keyword = {
      ...structuredClone(e.google_maps_places_scraper),
      name: 'google_maps_places_scraper_keyword',
      path: '/google_maps_places_scraper_keyword',
    };
    delete e.google_maps_places_scraper;
  });
  const r = diffCatalogs(BASE, next);
  assert.deepEqual(classesOf(r), ['RENAMED']);
  const [row] = only(r, 'RENAMED');
  assert.equal(row.from, 'google_maps_places_scraper');
  assert.equal(row.endpoint, 'google_maps_places_scraper_keyword');
  assert.equal(row.auto_prable, true);
  assert.equal(r.exitCode, 0, 'a rename must not stop the release');
  assert.equal(r.blocking.length, 0);
});

test('REPRICED_MINOR fires under 2x, in both directions, and does not block', () => {
  const up = diffCatalogs(BASE, fixture((e) => { e.web_scrape.pricing.credits_per_call = 3; }));
  assert.deepEqual(classesOf(up), ['REPRICED_MINOR']);
  assert.equal(up.exitCode, 0);
  assert.equal(only(up, 'REPRICED_MINOR')[0].ratio, 1.5);

  // A price CUT is never a major event. "Several went down" in the measured 4-month
  // window; spending a human decision on a discount is how a gate loses credibility.
  const down = diffCatalogs(BASE, fixture((e) => { e.web_scrape.pricing.credits_per_call = 0.5; }));
  assert.deepEqual(classesOf(down), ['REPRICED_MINOR']);
  assert.equal(down.exitCode, 0);
  assert.equal(only(down, 'REPRICED_MINOR')[0].ratio, 0.25);
});

test('REPRICED_MAJOR fires at >=2x and BLOCKS', () => {
  // The real event: phone_finder 3 -> 25 credits in four months.
  const r = diffCatalogs(BASE, fixture((e) => { e.phone_finder.pricing.credits_per_call = 25; }));
  assert.deepEqual(classesOf(r), ['REPRICED_MAJOR']);
  const [row] = only(r, 'REPRICED_MAJOR');
  assert.equal(row.from_credits, 3);
  assert.equal(row.to_credits, 25);
  assert.equal(row.ratio, 8.333);
  assert.equal(r.exitCode, 1);

  // Exactly 2x is major; a hair under is not.
  assert.equal(diffCatalogs(BASE, fixture((e) => { e.web_scrape.pricing.credits_per_call = 4; })).exitCode, 1);
  assert.equal(diffCatalogs(BASE, fixture((e) => { e.web_scrape.pricing.credits_per_call = 3.9; })).exitCode, 0);

  // Per-result endpoints compare on the per-result rate, not on a call price.
  const perResult = diffCatalogs(BASE, fixture((e) => { e.profile_search.pricing.credits_per_result = 0.4; }));
  assert.deepEqual(classesOf(perResult), ['REPRICED_MAJOR']);

  // Free -> charged has no finite ratio and is always major.
  const wasFree = diffCatalogs(
    fixture((e) => { e.clean_domain.pricing.credits_per_call = 0; }),
    fixture((e) => { e.clean_domain.pricing.credits_per_call = 1; })
  );
  assert.deepEqual(classesOf(wasFree), ['REPRICED_MAJOR']);
  assert.equal(only(wasFree, 'REPRICED_MAJOR')[0].ratio, null);
});

test('REMOVED_UNMAPPED fires when nothing plausibly replaces the endpoint, and BLOCKS', () => {
  const r = diffCatalogs(BASE, fixture((e) => { delete e.find_emails; }));
  assert.deepEqual(classesOf(r), ['REMOVED_UNMAPPED']);
  assert.equal(only(r, 'REMOVED_UNMAPPED')[0].endpoint, 'find_emails');
  assert.equal(r.exitCode, 1);
});

test('PRICING_SEMANTICS_CHANGED fires on the per-success -> flat migration, and BLOCKS', () => {
  // The change that already bit us: `2 success / 1 soft-fail / 0 hard-fail` became a
  // flat credits_per_call, and the pack's cost model silently inherited a new meaning.
  const r = diffCatalogs(
    BASE,
    fixture((e) => {
      e.email_finder.pricing.model = 'flat';
      e.email_finder.pricing.credits_per_call = 5;
    })
  );
  assert.deepEqual(classesOf(r), ['PRICING_SEMANTICS_CHANGED']);
  assert.match(only(r, 'PRICING_SEMANTICS_CHANGED')[0].detail, /pricing model unknown -> flat/);
  assert.equal(r.exitCode, 1);
});

test('PRICING_SEMANTICS_CHANGED also covers the three silent formula changes', () => {
  const billingFieldLost = diffCatalogs(
    BASE,
    fixture((e) => { e.profile_search.pricing.billing_field_present_in_response = false; })
  );
  assert.deepEqual(classesOf(billingFieldLost), ['PRICING_SEMANTICS_CHANGED']);
  assert.match(billingFieldLost.changes[0].detail, /actuals become unverifiable/);

  const boundLost = diffCatalogs(BASE, fixture((e) => { e.profile_search.pricing.bounded = false; }));
  assert.deepEqual(classesOf(boundLost), ['PRICING_SEMANTICS_CHANGED']);
  assert.match(boundLost.changes[0].detail, /no longer bounded/);

  const countFieldMoved = diffCatalogs(
    BASE,
    fixture((e) => { e.profile_search.pricing.result_count_field = 'totalElements'; })
  );
  assert.deepEqual(classesOf(countFieldMoved), ['PRICING_SEMANTICS_CHANGED']);

  // ...but the pack merely LEARNING which field it is billed on is not a change of
  // formula. This false alarm fired 8 times on the real 2026-05 -> 2026-08 diff.
  const learned = diffCatalogs(
    fixture((e) => { e.profile_search.pricing.result_count_field = null; }),
    BASE
  );
  assert.deepEqual(classesOf(learned), []);
  assert.equal(learned.exitCode, 0);
});

test('a formula change is not double-reported as a repricing', () => {
  const r = diffCatalogs(
    BASE,
    fixture((e) => {
      e.web_scrape.pricing.model = 'per_result';
      e.web_scrape.pricing.credits_per_call = null;
      e.web_scrape.pricing.credits_per_result = 90;
      e.web_scrape.pricing.result_count_field = 'elements';
    })
  );
  assert.deepEqual(classesOf(r), ['PRICING_SEMANTICS_CHANGED']);
});

test('DEPRECATED fires and only warns', () => {
  const r = diffCatalogs(BASE, fixture((e) => { e.clean_domain.deprecated = true; }));
  assert.deepEqual(classesOf(r), ['DEPRECATED']);
  assert.equal(r.exitCode, 0);
  assert.match(only(r, 'DEPRECATED')[0].detail, /preflight/);
});

test('ADDED fires, is informational, and points at the ownership file', () => {
  const r = diffCatalogs(
    BASE,
    fixture((e) => {
      e.similarweb_scraper_sync = {
        ...structuredClone(e.web_scrape),
        name: 'similarweb_scraper_sync',
        path: '/similarweb_scraper_sync',
        capability_group: 'web_intelligence',
      };
    })
  );
  assert.deepEqual(classesOf(r), ['ADDED']);
  assert.equal(r.exitCode, 0);
  assert.match(only(r, 'ADDED')[0].detail, /endpoint-owners\.yaml/);
});

test('an identical catalog produces nothing at all', () => {
  const r = diffCatalogs(BASE, structuredClone(BASE));
  assert.deepEqual(r.changes, []);
  assert.equal(r.exitCode, 0);
});

// --- rename matching guardrails -------------------------------------------------

test('rename matching recognises the real historical renames', () => {
  assert.ok(similarity('google_search_scraper', 'google_search_scraper_sync') >= 0.99);
  assert.ok(similarity('ad_search', 'linkedin_ad_search') >= 0.6);
  assert.ok(similarity('ad_details', 'linkedin_ad_details') >= 0.6);
  assert.ok(similarity('find_emails', 'email_finder') >= 0.6, 'stemming folds finder->find, emails->email');
  // ...and refuses to pair two genuinely different endpoints.
  assert.ok(similarity('phone_finder', 'web_sitemap') < 0.3);
});

test('a removal never collapses onto an added endpoint from another known group', () => {
  const oldE = {
    phone_finder: { capability_group: 'email_and_phone' },
  };
  const newE = {
    phone_search: { capability_group: 'people_search' },
  };
  assert.deepEqual(matchRenames(['phone_finder'], ['phone_search'], oldE, newE), []);
});

test('two removals never claim the same replacement', () => {
  const oldE = {
    email_finder_a: { capability_group: 'email_and_phone' },
    email_finder_b: { capability_group: 'email_and_phone' },
  };
  const newE = { email_finder: { capability_group: 'email_and_phone' } };
  const pairs = matchRenames(['email_finder_a', 'email_finder_b'], ['email_finder'], oldE, newE);
  assert.equal(pairs.length, 1);
});

// --- the CLI --------------------------------------------------------------------

test('the CLI exits non-zero only for blocking classes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-diff-'));
  const oldFile = path.join(dir, 'old.json');
  fs.writeFileSync(oldFile, JSON.stringify(BASE));

  const runCli = (next) => {
    const newFile = path.join(dir, 'new.json');
    fs.writeFileSync(newFile, JSON.stringify(next));
    try {
      const stdout = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'richapi-catalog-diff.mjs'), oldFile, newFile], {
        encoding: 'utf8',
      });
      return { code: 0, stdout };
    } catch (err) {
      return { code: err.status, stdout: err.stdout };
    }
  };

  const warnCase = runCli(fixture((e) => { e.clean_domain.deprecated = true; }));
  assert.equal(warnCase.code, 0);
  assert.match(warnCase.stdout, /DEPRECATED/);
  assert.match(warnCase.stdout, /No blocking changes/);

  const blockCase = runCli(fixture((e) => { e.phone_finder.pricing.credits_per_call = 25; }));
  assert.equal(blockCase.code, 1);
  assert.match(blockCase.stdout, /BLOCK REPRICED_MAJOR/);
  assert.match(blockCase.stdout, /1 blocking change/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the committed catalog matches the pinned spec (CI default mode)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'richapi-catalog-diff.mjs')], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.match(out, /no changes/);
});

test('the price-changed spec fixture produces exactly the findings its manifest declares', async () => {
  // The manifest describes a diff; this runs it, so a re-derived fixture cannot quietly
  // stop producing the classes it claims to demonstrate.
  const { buildCatalog } = await import('../../_lib/catalog/generate.mjs');
  const dir = path.join(ROOT, 'tests', 'fixtures', 'spec');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const cat = (f) => buildCatalog(fs.readFileSync(path.join(dir, f)), { generatedAt: 'x' }).catalog;
  const r = diffCatalogs(cat('price-changed.yaml'), cat('current.yaml'));
  const got = r.changes.filter((c) => c.class !== 'UNCHANGED').map((c) => `${c.class}:${c.endpoint}`).sort();
  const want = manifest.fixtures['price-changed'].expected_findings.map((f) => `${f.severity}:${f.endpoint}`).sort();
  assert.deepEqual(got, want);
});
