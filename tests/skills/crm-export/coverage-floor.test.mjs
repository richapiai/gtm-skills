// The coverage floor is a gate, not a note.
//
// A live run exported a contacts file whose email coverage was 0%: not one row carried
// the dedupe key, so every row would create a duplicate rather than update a record.
// The script wrote it anyway and mentioned the number one line under `WROTE`. A CRM
// makes that permanent, and the cleanup is manual.
//
// So: below `gates.yaml:quality_stops.coverage_min_pct` nothing is written, the refusal
// names what is missing, and the only way past is an override that names the floor it
// crosses and lands in the manifest.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import { runExport, refusalCodes, projectRoot, writeCsv } from './helpers.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';

const FLOOR = gateValue(loadGates(), 'quality_stops.coverage_min_pct');

const contact = (over = {}) => ({
  first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace', title: 'CTO',
  email: 'ada@a.example', phone: '', linkedin_url: 'https://li/ada',
  company_name: 'Analytical Engines', company_domain: 'a.example', industry: 'Software',
  city: 'London', country: 'GB',
  source_endpoint: 'enrich_profile', fetched_at: '2026-08-01T00:00:00Z', source: 'richapi',
  ...over,
});

function fixture (rows) {
  const root = projectRoot({ suppression: [] });
  return { root, list: writeCsv(root, 'gtm/lists/l.csv', rows), out: join(root, 'gtm', 'exports', 'o.csv') };
}

const noKey = (n) => Array.from({ length: n }, (_, i) => contact({ email: '', first_name: `NoEmail${i}` }));

test('a file below the coverage floor is REFUSED, and nothing is written', () => {
  const f = fixture(noKey(4));
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'contacts', ROOT: f.root });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['LOW_COVERAGE']);
  assert.equal(fs.existsSync(f.out), false, 'the import file was written below the floor');
  assert.equal(fs.existsSync(f.out + '.manifest.json'), false);
  // It says what is missing and where the floor came from, not just that it refused.
  assert.match(r.out, /4 of 4 row\(s\) carry no `email`/);
  assert.match(r.out, new RegExp(String(FLOOR) + '% floor'));
  assert.match(r.out, /gates\.yaml:quality_stops\.coverage_min_pct/);
});

test('the override must NAME the floor it crosses, and is recorded in the manifest', () => {
  const rows = [contact(), ...noKey(3)];            // 25%, under any sane floor
  const vague = runExport({ LIST: fixture(rows).list, OUT: '/dev/null', TARGET: 'generic_crm',
    ROOT: fixture(rows).root, ALLOW_LOW_COVERAGE: 'yes' });
  assert.equal(vague.status, 3, 'a bare "yes" got past the floor');
  assert.deepEqual(refusalCodes(vague.out), ['LOW_COVERAGE']);

  const f = fixture(rows);
  const ok = runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root,
    ALLOW_LOW_COVERAGE: String(FLOOR) });
  assert.equal(ok.status, 0, ok.out);
  const m = JSON.parse(fs.readFileSync(f.out + '.manifest.json', 'utf8'));
  assert.equal(m.coverage_override, true);
  assert.equal(m.upsert_key_coverage_pct, 25);
  assert.equal(m.coverage_floor_pct, FLOOR);
  assert.match(ok.out, /UNDER THE FLOOR/, 'the run must say out loud that the floor was crossed');
});

test('a file at or above the floor carries no override flag', () => {
  const f = fixture([contact(), contact({ email: 'b@b.example' })]);
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root });
  assert.equal(r.status, 0, r.out);
  const m = JSON.parse(fs.readFileSync(f.out + '.manifest.json', 'utf8'));
  assert.equal(m.upsert_key_coverage_pct, 100);
  assert.equal(m.coverage_override, false);
});

test('a floor that does not resolve refuses too — law 5', () => {
  const f = fixture([contact(), ...noKey(3)]);
  // A gates.yaml with the key removed: the comparison cannot be made, so the file is
  // not written. "No floor" is the one reading that is never available.
  const gates = join(f.root, 'gates-no-floor.yaml');
  fs.writeFileSync(gates, 'version: 1\nquality_stops:\n  verification_max_fail_rate_pct: 5\n', 'utf8');
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root,
    RICHAPI_GATES_FILE: gates, GATES_FILE: gates });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['COVERAGE_FLOOR_UNREADABLE']);
  assert.equal(fs.existsSync(f.out), false);
});

test('nothing left after suppression is an empty file, not a 0% coverage refusal', () => {
  const root = projectRoot({ suppression: [{ email: 'ada@a.example', reason: 'unsubscribe' }] });
  const list = writeCsv(root, 'gtm/lists/l.csv', [contact()]);
  const out = join(root, 'gtm', 'exports', 'o.csv');
  const r = runExport({ LIST: list, OUT: out, TARGET: 'generic_crm', ROOT: root });
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(out));
  assert.match(r.out, /1 suppressed/);
});
