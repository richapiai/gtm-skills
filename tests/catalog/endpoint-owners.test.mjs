// _lib/endpoint-owners.yaml + the CI gate.
// Verify criterion: adding an endpoint to the fixture spec fails the checker until it
// is claimed.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { checkOwners, loadOwners, renderCoverage } from '../../_lib/catalog/owners.mjs';
import { buildCatalog } from '../../_lib/catalog/generate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURES = path.join(HERE, 'fixtures');
const OWNERS_FILE = path.join(ROOT, '_lib', 'endpoint-owners.yaml');
const CATALOG_FILE = path.join(ROOT, '_lib', 'api-catalog.json');
const COVERAGE_FILE = path.join(ROOT, '_lib', 'catalog', 'coverage.md');
const CHECKER = path.join(ROOT, '_lib', 'catalog', 'owners-check.mjs');

const owners = loadOwners(OWNERS_FILE);
const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-owners-'));
}

/** A minimal owners doc that claims everything in a catalog. */
function ownersFor(cat, extra = {}) {
  const endpoints = {};
  for (const n of Object.keys(cat.endpoints)) endpoints[n] = ['test-skill'];
  const defaults = {};
  for (const e of Object.values(cat.endpoints)) defaults[e.capability_group] = ['test-skill'];
  return { defaults_by_capability_group: defaults, endpoints, unclaimed: {}, ...extra };
}

// --- the verify criterion -------------------------------------------------------

test('adding an endpoint to the fixture spec fails the checker until it is claimed', () => {
  const before = buildCatalog(fs.readFileSync(path.join(FIXTURES, 'mini-spec.yaml')), {
    generatedAt: '2026-01-01T00:00:00.000Z',
  }).catalog;
  const fixtureOwners = ownersFor(before);

  // The ownership file is complete for the spec it was written against.
  assert.equal(checkOwners(fixtureOwners, before).ok, true);

  // The API ships a release. The ownership file has not moved.
  const after = buildCatalog(fs.readFileSync(path.join(FIXTURES, 'mini-spec-plus-one.yaml')), {
    generatedAt: '2026-01-01T00:00:00.000Z',
  }).catalog;
  assert.ok(after.endpoints.brand_new_endpoint);

  const failed = checkOwners(fixtureOwners, after);
  assert.equal(failed.ok, false, 'CI must fail on an endpoint nobody has claimed');
  assert.equal(failed.counts.unmapped, 1);
  const [problem] = failed.problems.filter((p) => p.code === 'UNMAPPED');
  assert.equal(problem.endpoint, 'brand_new_endpoint');
  assert.match(problem.message, /endpoints:.*unclaimed:/s);

  // Claiming it clears the gate.
  const claimed = { ...fixtureOwners, endpoints: { ...fixtureOwners.endpoints, brand_new_endpoint: ['enrich-waterfall'] } };
  assert.equal(checkOwners(claimed, after).ok, true);

  // ...and so does deliberately declining it WITH a reason.
  const declined = {
    ...fixtureOwners,
    unclaimed: { brand_new_endpoint: 'no GTM use until the response shape is known' },
  };
  assert.equal(checkOwners(declined, after).ok, true);
});

test('a bare `unclaimed:` with no real reason is not a way out', () => {
  const cat = buildCatalog(fs.readFileSync(path.join(FIXTURES, 'mini-spec-plus-one.yaml')), {
    generatedAt: '2026-01-01T00:00:00.000Z',
  }).catalog;
  const base = ownersFor(cat);
  delete base.endpoints.brand_new_endpoint;

  for (const reason of [null, '', 'tbd', '   ']) {
    const doc = { ...base, unclaimed: { brand_new_endpoint: reason } };
    const r = checkOwners(doc, cat);
    assert.equal(r.ok, false, `reason ${JSON.stringify(reason)} should not pass`);
    assert.ok(r.problems.some((p) => p.code === 'MISSING_REASON'));
  }
});

test('the checker CLI exits 1 on UNMAPPED and 0 once claimed', () => {
  const dir = tmpdir();
  const catFile = path.join(dir, 'catalog.json');
  const ownFile = path.join(dir, 'owners.yaml');
  const cat = buildCatalog(fs.readFileSync(path.join(FIXTURES, 'mini-spec-plus-one.yaml')), {
    generatedAt: '2026-01-01T00:00:00.000Z',
  }).catalog;
  fs.writeFileSync(catFile, JSON.stringify(cat, null, 2));

  const writeOwners = (doc) => fs.writeFileSync(ownFile, JSON.stringify(doc, null, 2)); // JSON is valid YAML
  const runChecker = () => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [CHECKER, '--owners', ownFile, '--catalog', catFile], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  const incomplete = ownersFor(cat);
  delete incomplete.endpoints.brand_new_endpoint;
  writeOwners(incomplete);
  const failed = runChecker();
  assert.equal(failed.code, 1);
  assert.match(failed.out, /UNMAPPED/);

  writeOwners(ownersFor(cat));
  const passed = runChecker();
  assert.equal(passed.code, 0);
  assert.match(passed.out, /0 UNMAPPED/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// --- the real ownership file ----------------------------------------------------

test('every one of the 68 spec endpoints is claimed or explicitly unclaimed', () => {
  const r = checkOwners(owners, catalog);
  assert.deepEqual(r.problems, [], r.problems.map((p) => `${p.code}: ${p.message}`).join('\n'));
  assert.equal(r.counts.spec_endpoints, 68);
  assert.equal(r.counts.claimed + r.counts.unclaimed, 68);
  assert.equal(r.counts.unmapped, 0);
});

test('company_enricher is not in the spec, the catalog, or the owners table', () => {
  // REVERSAL, 2026-08-30. This name was added to all three on the strength of the
  // backend WORKING COPY — its generated endpoint manifest, migrations 007/014/016/035,
  // the MCP registry, the Postman collection, the marketing site. Those are
  // pre-deployment artefacts. The running server does not serve it:
  //
  //   GET /api/v1/catalog -> 200, 68 rows, company_enricher is not among them
  //   POST /api/v1/company_enricher (no key, body {}) -> 404   no such route
  //   POST /api/v1/enrich_company   (no key, body {}) -> 401   control: route exists
  //
  // A catalog row for a 404 route is a skill that fails mid-run, and an owners entry
  // for it is a claim on capability the pack does not have. Re-run the curls before
  // putting it back.
  assert.equal(catalog.endpoints.company_enricher, undefined, 'back in the catalog');
  assert.equal(owners.endpoints.company_enricher, undefined, 'back in the owners table');
  assert.equal(owners.unclaimed.company_enricher, undefined, 'back in the unclaimed table');
});

test('profile_social_metrics is live, enabled, and claimed', () => {
  // The other half of the same reversal, and it went the other way. This one IS on the
  // wire — GET /api/v1/catalog lists it among the 68, and an unauthenticated POST
  // answers 401 (route exists, auth rejected), not 404. It reads as a phantom only
  // because every CURATED artefact omits it: its description on the live catalog is the
  // auto-generated "API endpoint: profile_social_metrics", i.e. nobody wrote it a
  // description. That is an uncurated passthrough, not a missing deployment.
  //
  // /evidence-score, /account-research and /pre-meeting-briefing route through it and
  // were correct all along.
  const e = catalog.endpoints.profile_social_metrics;
  assert.ok(e, 'dropped from the catalog');
  assert.equal(e.pricing.disabled_by_default, false, 're-disabled — re-run the curls first');
  assert.equal(e.pricing.disabled_reason, null);
  assert.deepEqual(owners.endpoints.profile_social_metrics, ['evidence-score', 'account-research']);
});

test('the seeded unclaimed set is exactly the four deliberate gaps', () => {
  assert.deepEqual(Object.keys(owners.unclaimed).sort(), [
    'encode_uri',
    'format_datetime',
    'post_keyword_search',
    'predict_gender',
  ]);
  assert.match(owners.unclaimed.predict_gender, /bias risk/);
  assert.match(owners.unclaimed.post_keyword_search, /no skill searches posts by keyword/);
  assert.match(owners.unclaimed.encode_uri, /runtime helper/);
  assert.match(owners.unclaimed.format_datetime, /runtime helper/);
  // post_keyword_search is unclaimed by choice, not because it is disabled: since the
  // 2026-09-17 re-pin it bills per result on the page, so it is enabled and page-gated.
  assert.equal(catalog.endpoints.post_keyword_search.pricing.disabled_by_default, false);
  assert.equal(catalog.endpoints.post_keyword_search.pricing.page_gated, true);
});

test('every capability group in the catalog has a default owner', () => {
  const groups = new Set(Object.values(catalog.endpoints).map((e) => e.capability_group));
  for (const g of groups) {
    assert.ok(Array.isArray(owners.defaults_by_capability_group[g]), `no default for ${g}`);
    assert.ok(owners.defaults_by_capability_group[g].length > 0);
  }
  assert.equal(Object.keys(owners.defaults_by_capability_group).length, groups.size);
});

test('a claim on an endpoint the spec no longer ships is caught', () => {
  const stale = { ...owners, endpoints: { ...owners.endpoints, find_emails: ['enrich-waterfall'] } };
  const r = checkOwners(stale, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === 'STALE_CLAIM' && p.endpoint === 'find_emails'));
});

test('an endpoint cannot be both claimed and unclaimed', () => {
  const doubled = { ...owners, unclaimed: { ...owners.unclaimed, email_finder: 'changed my mind' } };
  const r = checkOwners(doubled, catalog);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.code === 'DOUBLE_LISTED' && p.endpoint === 'email_finder'));
});

// --- the generated coverage table -----------------------------------------------

test('the coverage table is generated, current, and never hand-typed', () => {
  const rendered = `${renderCoverage(owners, catalog)}\n`;
  assert.equal(
    fs.readFileSync(COVERAGE_FILE, 'utf8'),
    rendered,
    'run `node _lib/catalog/owners-check.mjs --write-coverage`'
  );
  assert.match(rendered, /GENERATED by .*owners-check\.mjs/);
  // The old prose table claimed normalize_*(6); the spec ships three.
  const normalizeRows = rendered.split('\n').filter((l) => /^\| `normalize_/.test(l));
  assert.equal(normalizeRows.length, 3);
  // Every credit figure comes from the catalog, so hazards travel with the table.
  assert.match(rendered, /`phone_finder` \| 25 \/ call/);
  assert.match(rendered, /`post_keyword_search` \| 0\.1 \/ result \| _unclaimed_ \|.*page-gated/);
  assert.doesNotMatch(rendered, /disabled by default/, 'nothing ships disabled today');
  assert.match(rendered, /`lead_search` \| 10 \+ 0\.5 \/ result/);
});

test('--check-coverage fails when the table drifts from its inputs', () => {
  const dir = tmpdir();
  const catFile = path.join(dir, 'catalog.json');
  const covFile = path.join(dir, 'coverage.md');
  fs.copyFileSync(CATALOG_FILE, catFile);
  fs.writeFileSync(covFile, '# hand-typed and already wrong\n');
  try {
    execFileSync(process.execPath, [CHECKER, '--catalog', catFile, '--coverage', covFile, '--check-coverage'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.fail('stale coverage table should fail the gate');
  } catch (err) {
    assert.equal(err.status, 1);
    assert.match(`${err.stdout}${err.stderr}`, /STALE_COVERAGE/);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
