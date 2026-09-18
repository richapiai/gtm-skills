// Regression tests for the pre-landing review findings.
//
// One test per fixed defect, each written so it FAILS if the old behaviour returns.
// The finding ids match the review report.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, trackedTmp, createFakeHttp, okJson, liveEnrichProfile, liveEnrichCompany, liveEmailFinder, liveEmailVerifier, livePhoneFinder } from '../helpers/index.mjs';
import {
  ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore, filterOutputList,
} from '../../_lib/suppression.mjs';
import { runJournalPath, sanitizeLine, acquireListLock, JournalContractError } from '../../_lib/journal.mjs';
import { mapResponse, RESPONSE_MAPS, RichApiClient } from '../../_lib/client.mjs';
import { loadCatalog, runEnrich, toDescriptor } from '../../_lib/enrich.mjs';
import { Ledger } from '../../_lib/ledger.mjs';
import { buildReceipt, assertNeverOverstates, ReceiptOverstatement } from '../../_lib/receipt.mjs';
import { loadTtlTable, ttlForEndpoint, erase } from '../../_lib/pii.mjs';
import { parseCsv } from '../../_lib/csv.mjs';
import { CATALOG_PATH, GATES_PATH } from '../../_lib/paths.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG = loadCatalog();

// ===========================================================================
// Suppression matched an exact lowercase column allowlist
// ===========================================================================

test('an unsubscribed contact is blocked under EVERY realistic column name', (t) => {
  const tree = makeGtmTree({ prefix: 'reg-c01-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  addSuppressionEntry({ email: 'jane@acme.com', reason: 'unsubscribed' }, { root: tree.root });
  const store = loadSuppressionStore({ root: tree.root });

  // Every one of these reached the output list before the fix.
  const spellings = ['email', 'Email', 'EMAIL', 'Work Email', 'contact_email',
    'primary_email', 'E-Mail Address', 'workEmail', 'some_random_column'];
  for (const col of spellings) {
    const { kept } = filterOutputList([{ [col]: 'jane@acme.com' }], { store, root: tree.root });
    assert.equal(kept.length, 0, `column ${JSON.stringify(col)} let a suppressed contact through`);
  }

  // A domain suppression works from any column too.
  addSuppressionEntry({ domain: 'competitor.com', reason: 'competitor' }, { root: tree.root });
  const s2 = loadSuppressionStore({ root: tree.root });
  assert.equal(filterOutputList([{ Website: 'https://competitor.com/x' }], { store: s2, root: tree.root }).kept.length, 0);

  // And a contact who is NOT suppressed still passes — the filter is not a blanket drop.
  assert.equal(filterOutputList([{ Email: 'bob@fine.com' }], { store: s2, root: tree.root }).kept.length, 1);
});

// ===========================================================================
// A run id became a file path
// ===========================================================================

test('a run id cannot escape the state tree', () => {
  assert.equal(runJournalPath('/proj/gtm', 'enrich-abc-123'), path.join('/proj/gtm', 'runs', 'enrich-abc-123.jsonl'));
  for (const evil of ['../../../../tmp/pwn', '../../escape', 'a/b/c', 'x.y', 'a:b', '']) {
    assert.throws(() => runJournalPath('/proj/gtm', evil),
      (e) => e instanceof JournalContractError, `run id ${JSON.stringify(evil)} was accepted`);
  }
});

// ===========================================================================
// The response map, and the re-enrich-forever loop
// ===========================================================================

test('every waterfall hop delivers columns from a real response', () => {
  // REWRITTEN 2026-09-02 to the RECORDED bodies. This test is named "every waterfall
  // hop delivers columns from a real response" and, until today, none of these WERE
  // real responses — every one was transcribed from the spec, which is what let the
  // test pass while the production map dropped the email on every paid call.
  const spec = {
    enrich_profile: liveEnrichProfile(),
    enrich_company: liveEnrichCompany(),
    email_finder: liveEmailFinder(),
    email_verifier: liveEmailVerifier(),
    phone_finder: livePhoneFinder(),
  };
  for (const [ep, body] of Object.entries(spec)) {
    const cols = mapResponse(ep, body);
    assert.ok(Object.keys(cols).length > 0, `${ep} delivered NOTHING`);
  }
  // The specific regressions: camelCase must be mapped, arrays must not become columns.
  assert.equal(mapResponse('enrich_profile', spec.enrich_profile).title, 'VP Sales');
  assert.equal(mapResponse('enrich_profile', spec.enrich_profile).company_name, 'Acme');
  assert.ok(!('skills' in mapResponse('enrich_profile', spec.enrich_profile)), 'arrays are not columns');
  // The deliverability signal the verifier is bought for. The spec documented
  // `valid` / `disposable` / `mxFound`; the RECORDED response carries none of them —
  // it answers `result.status` and nothing else. Asserting the spec's three fields here
  // would be asserting a shape the server has never sent, so this pins the one field
  // that actually arrives.
  const v = mapResponse('email_verifier', spec.email_verifier);
  assert.equal(v.email_verification_status, 'ok', 'the verifier delivered its verdict');
  assert.ok(!('email' in v),
    'the recorded verifier response does not echo the address; mapping one would invent it');

  // The `result` envelope is read. This is the defect itself: the payload is one level
  // down, the map read the top level, and a 5-credit call returned no address.
  assert.equal(mapResponse('email_finder', spec.email_finder).email, 'ada@acme.example');
  assert.equal(mapResponse('phone_finder', spec.phone_finder).phone, '+15550100',
    'the 25-credit call must deliver the number it is bought for');
});

test('an enriched row is recognised as enriched, and not re-planned forever', (t) => {
  const tree = makeGtmTree({ prefix: 'reg-c06-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const store = loadSuppressionStore({ root: tree.root });

  const raw = { first_name: 'Ada', last_name: 'L', linkedin_url: 'https://x' };
  const before = toDescriptor(raw, 0, { store });
  assert.ok(!before.descriptor.has.includes('profile'), 'a bare row needs enriching');

  // Apply what enrich_profile actually returns.
  const enriched = { ...raw, ...mapResponse('enrich_profile', liveEnrichProfile()) };
  const after = toDescriptor(enriched, 0, { store });
  assert.ok(after.descriptor.has.includes('profile'), 'an enriched row must not be re-planned');
  assert.equal(after.skipReasons.enrich_profile, 'already enriched');
});

// ===========================================================================
// A resume delivered the output WITHOUT the first run's paid-for data
// ===========================================================================

test('a resume delivers the data the first run already paid for', async (t) => {
  const tree = makeGtmTree({ prefix: 'reg-c07-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const rows = Array.from({ length: 6 }, (_, i) => ({
    first_name: `F${i}`, last_name: `L${i}`, company_domain: `c${i}.example`,
    linkedin_url: `https://linkedin.com/in/p${i}`,
  }));
  const header = Object.keys(rows[0]);
  const input = path.join(tree.root, 'list.csv');
  fs.writeFileSync(input, [header.join(','), ...rows.map(r => header.map(h => r[h]).join(','))].join('\n') + '\n');

  // First run: profile hop succeeds for everyone, then credits run out on email_finder.
  let n = 0;
  const http = createFakeHttp({
    fallback: (call) => (call.endpoint === 'enrich_profile'
      ? okJson(liveEnrichProfile())
      : (n++ === 0 ? okJson(liveEmailFinder({ result: { email: 'found@acme.example' } }))
        : okJson({ error: 'x' }, { status: 402 }))),
  });
  await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, verify: false,
    api: new RichApiClient({ apiKey: 'k', fetchImpl: http.fetch }),
    confirm: async () => true, runId: 'reg-resume', noCache: true,
  });

  // Resume, and write the output.
  const http2 = createFakeHttp({ fallback: okJson({ email: 'later@acme.example', provider: 'provider_a' }) });
  const second = await runEnrich({
    input, root: tree.root, catalog: CATALOG, budget: 500, verify: false,
    api: new RichApiClient({ apiKey: 'k', fetchImpl: http2.fetch }),
    confirm: async () => true, resume: 'reg-resume', noCache: true, output: 'out.csv',
  });

  const out = parseCsv(fs.readFileSync(path.join(tree.root, 'out.csv'), 'utf8'));
  const withTitle = out.filter(r => r.title === 'VP Sales').length;
  assert.equal(withTitle, 6,
    `the first run paid for 6 profile enrichments; only ${withTitle} reached the output`);
  assert.ok(second.resume.stats.units_done > 0, 'the resume must recognise completed work');
});

// ===========================================================================
// A vendor name with a space killed a paid run
// ===========================================================================

test('a real vendor name is coerced, never fatal', () => {
  const base = { schema_version: 1, run_id: 'r', row_id: 'x', hop: 0, endpoint: 'e', status: 'ok', ts: new Date().toISOString() };
  for (const p of ['Acme Data Labs', 'Beta Enrich (waterfall)', 'Gamma.io', 'provider_a']) {
    const line = sanitizeLine({ ...base, provider: p });
    assert.ok(line.provider === null || /^[A-Za-z0-9_.:\-/]{1,64}$/.test(line.provider),
      `provider ${JSON.stringify(p)} produced an unsafe token`);
  }
  assert.equal(sanitizeLine({ ...base, provider: 'Acme Data Labs' }).provider, 'acme_data_labs');
});

// ===========================================================================
// Honest cost accounting
// ===========================================================================

test('a flat catalog price is never dressed up as a verified actual', (t) => {
  const led = new Ledger({ dir: path.join(trackedTmp('reg-c09-'), 'gtm'), runId: 'r' });
  const flat = CATALOG.endpoints.enrich_profile;
  assert.equal(flat.pricing.model, 'flat');

  const noProof = led.record({ endpoint: 'enrich_profile', catalogEntry: flat, estimatedCredits: 1, responseBody: { title: 'x' }, httpStatus: 200 });
  assert.equal(noProof.cost_status, 'estimated_unverifiable', 'a catalog price is an estimate, not a reading');
  assert.equal(noProof.credits_actual, null);

  // credits_charged in the body is the ONE thing that promotes a line to actual.
  const proof = led.record({ endpoint: 'enrich_profile', catalogEntry: flat, estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  assert.equal(proof.cost_status, 'actual');
  assert.equal(proof.credits_actual, 1);
});

test('a timeout is recorded, and is NOT a known zero', (t) => {
  const led = new Ledger({ dir: path.join(trackedTmp('reg-c10-'), 'gtm'), runId: 'r' });
  const line = led.record({
    endpoint: 'phone_finder', catalogEntry: CATALOG.endpoints.phone_finder,
    estimatedCredits: 25, responseBody: null, httpStatus: 0,
  });
  assert.equal(line.cost_status, 'estimated_unverifiable',
    'the response was never seen, so "a non-2xx is not billed" cannot be applied');
  assert.notEqual(line.cost_status, 'known_zero');
});

test('a resumed run adopts the ledger lines its earlier run already wrote', (t) => {
  const dir = path.join(trackedTmp('reg-c11-'), 'gtm');
  const first = new Ledger({ dir, runId: 'run-A' });
  first.record({ endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  first.record({ endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });

  // A different run's line must NOT be adopted.
  new Ledger({ dir, runId: 'run-B' }).record({ endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });

  const resumed = new Ledger({ dir, runId: 'run-A' });
  assert.equal(resumed.lines.length, 2, 'a resume must see its own run\'s earlier spend');
  assert.equal(resumed.totals().credits_actual, 2);
});

test('the receipt guard can actually fire', (t) => {
  const led = new Ledger({ dir: path.join(trackedTmp('reg-c13-'), 'gtm'), runId: 'r' });
  led.record({ endpoint: 'enrich_profile', catalogEntry: CATALOG.endpoints.enrich_profile, estimatedCredits: 1, responseBody: { credits_charged: 1 }, httpStatus: 200 });
  const r = buildReceipt({ ledger: led });
  assertNeverOverstates(r, led);

  // The guard must be independent of buildReceipt, so an inflated claim is caught even
  // though buildReceipt would never produce one.
  assert.throws(() => assertNeverOverstates({ ...r, credits_floor: r.credits_floor + 10 }, led),
    (e) => e instanceof ReceiptOverstatement);
  assert.throws(() => assertNeverOverstates({ ...r, credits_ceiling: r.credits_ceiling + 10 }, led),
    (e) => e instanceof ReceiptOverstatement);
});

// ===========================================================================
// Retention was longer than the operator's own policy
// ===========================================================================

test('retention matches gates.yaml, and an unknown endpoint fails to the shortest', () => {
  const t = loadTtlTable();
  assert.match(t.source, /gates\.yaml$/, 'the shipped policy must be found, not defaults');
  const days = (ms) => ms / 86_400_000;

  // These were 90d / 30d / 90d before the fix, against a policy of 7d / 1d / 7d.
  assert.equal(days(ttlForEndpoint('linkedin_company_search', t)), 7);
  assert.equal(days(ttlForEndpoint('search_google_trends', t)), 1);
  assert.equal(days(ttlForEndpoint('geo_id_search', t)), 7);
  // Never-cache and fail-closed both still hold.
  assert.equal(ttlForEndpoint('ai_enrich', t), 0);
  assert.equal(days(ttlForEndpoint('an_endpoint_nobody_classified', t)), 1);
});

// ===========================================================================
// Erase half-deleted a multi-line record and corrupted the file
// ===========================================================================

test('erase removes a whole record that spans two physical lines', (t) => {
  const tree = makeGtmTree({ prefix: 'reg-c03-' });
  t.after(() => tree.cleanup());
  const f = path.join(tree.root, 'gtm', 'lists', 'l.csv');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, 'name,email,note\n"Jane Doe",jane@acme.com,"called her\nlast tuesday"\n"Bob",bob@ok.com,fine\n');
  assert.equal(parseCsv(fs.readFileSync(f, 'utf8')).length, 2);

  erase('jane@acme.com', { root: tree.root });
  const after = fs.readFileSync(f, 'utf8');

  assert.ok(!after.includes('Jane Doe'), 'the rest of the erased record survived');
  assert.ok(!after.includes('last tuesday'), 'the continuation line survived');
  assert.ok(after.includes('bob@ok.com'), 'an unrelated record was destroyed');
  assert.equal(parseCsv(after).length, 1, 'the file no longer parses as CSV');
});

// ===========================================================================
// Contract fields that nothing could write
// ===========================================================================

test('dry_run and list_key are writable, and list_key carries no path', () => {
  const base = { schema_version: 1, run_id: 'r', row_id: 'x', hop: 0, endpoint: 'e', status: 'pending', ts: new Date().toISOString() };
  const line = sanitizeLine({ ...base, dry_run: true, list_key: '/Users/me/Acme Corp/leads.csv' });
  assert.equal(line.dry_run, true);
  assert.match(line.list_key, /^[a-f0-9]{32}$/, 'list_key must be hashed, not a path');
  assert.ok(!line.list_key.includes('Acme'));
  const d = sanitizeLine(base);
  assert.equal(d.dry_run, false);
  assert.equal(d.list_key, null);
});

// ===========================================================================
// The lock refused a crashed run's own resume
// ===========================================================================

test('a lock left by a DEAD process does not block the resume it exists to enable', (t) => {
  const dir = path.join(trackedTmp('reg-lock-'), 'gtm');
  const lockPath = path.join(dir, 'runs', '.locks');
  fs.mkdirSync(lockPath, { recursive: true });
  // A lock naming a pid that cannot exist, written one minute ago.
  const held = acquireListLock({ dir, listKey: '/list.csv', runId: 'crashed-run' });
  const file = fs.readdirSync(lockPath)[0];
  const full = path.join(lockPath, file);
  fs.writeFileSync(full, JSON.stringify({ run_id: 'crashed-run', pid: 999999999, started_at: new Date(Date.now() - 60_000).toISOString() }));

  const taken = acquireListLock({ dir, listKey: '/list.csv', runId: 'resume-run' });
  assert.ok(taken, 'a crashed run must not block its own resume for six hours');
  taken.release();
  try { held.release(); } catch { /* already gone */ }
});

// ===========================================================================
// Packaging
// ===========================================================================

test('package data resolves from the PACKAGE, not the caller cwd', () => {
  assert.ok(fs.existsSync(CATALOG_PATH), 'catalog must resolve from the package');
  assert.ok(fs.existsSync(GATES_PATH), 'gates.yaml must resolve from the package');
  assert.ok(CATALOG_PATH.startsWith(REPO), 'and it must be the package copy');
  // loadCatalog with no argument must work regardless of cwd.
  assert.ok(loadCatalog().endpoints, 'loadCatalog() must not depend on process.cwd()');
});

test('nothing shipped imports from tests/, and the package is installable', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.notEqual(pkg.private, true, 'private: true makes the package uninstallable');
  assert.ok(!pkg.files.includes('tests/'), 'tests/ is not shipped, so nothing shipped may import it');

  for (const dir of ['bin', '_lib']) {
    for (const f of fs.readdirSync(path.join(REPO, dir))) {
      const full = path.join(REPO, dir, f);
      if (!fs.statSync(full).isFile()) continue;
      const src = fs.readFileSync(full, 'utf8');
      const imports = [...src.matchAll(/^\s*import[^\n]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
      for (const spec of imports) {
        assert.ok(!spec.includes('tests/'),
          `${dir}/${f} imports ${spec} — tests/ is not shipped, so this breaks on install`);
      }
    }
  }
});

// ===========================================================================
// The pack ships at least one usable skill
// ===========================================================================

test('the pack ships skills, and they validate', () => {
  const dirs = fs.readdirSync(path.join(REPO, 'skills')).filter(d =>
    fs.statSync(path.join(REPO, 'skills', d)).isDirectory());
  assert.ok(dirs.length > 0, 'a pack called "GTM Skills" must contain at least one skill');
  assert.ok(dirs.includes('richapi-gtm'), 'the router is the entry point; without it there is none');
  for (const d of dirs) {
    assert.ok(fs.existsSync(path.join(REPO, 'skills', d, 'SKILL.md')), `${d} has no SKILL.md`);
  }
  // The validator is the real gate; assert it passes rather than re-implementing it.
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'validate-skills.mjs')], { encoding: 'utf8' });
});
