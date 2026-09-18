// tests/skills/crm-export/export-gate.test.mjs
//
// Law 5: a suppressed contact never reaches an output list. This skill writes PII out of
// the pack into a system that cannot be audited or erased from afterwards, so it is the
// last place that law is enforceable, and the tests here are the ones that bite.
//
// The subtle one is ORDERING. The suppression filter finds an address by scanning a
// row's top-level string values, so it works on `Email`, `Work Email` and `EMAIL`. It
// does NOT work on a value that projection has renamed away, dropped, or nested. Project
// first and a suppressed contact walks straight into a CRM. Every case below runs the
// script that ships inside skills/crm-export/SKILL.md, verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';

import {
  runExport, refusalCodes, projectRoot, writeCsv, writeJsonl, skillProse, extractScript,
} from './helpers.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';

const SUPPRESSED = 'nope@blocked.example';
const CLEAN = 'ada@a.example';

function contact (over = {}) {
  return {
    first_name: 'Ada', last_name: 'Lovelace', full_name: 'Ada Lovelace', title: 'CTO',
    email: CLEAN, phone: '', linkedin_url: 'https://li/ada',
    company_name: 'Analytical Engines', company_domain: 'a.example', industry: 'Software',
    city: 'London', country: 'GB',
    source_endpoint: 'enrich_profile', fetched_at: '2026-08-01T00:00:00Z', source: 'richapi',
    ...over,
  };
}

function fixture ({ rows, suppression = [{ email: SUPPRESSED, reason: 'unsubscribe' }] } = {}) {
  const root = projectRoot({ suppression });
  const list = writeCsv(root, 'gtm/lists/l.csv', rows);
  return { root, list, out: join(root, 'gtm', 'exports', 'o.csv') };
}

test('a suppressed contact never reaches the file', () => {
  const f = fixture({ rows: [contact(), contact({ email: SUPPRESSED, first_name: 'Nope' })] });
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'contacts', ROOT: f.root });
  assert.equal(r.status, 0, r.out);

  const text = fs.readFileSync(f.out, 'utf8');
  assert.ok(!text.includes(SUPPRESSED), 'the suppressed address is in the exported file');
  assert.ok(text.includes(CLEAN), 'the clean row did not survive');
  assert.equal(parseCsv(text).length, 1);
  assert.match(r.out, /1 written, 1 suppressed/);
});

test('the count of what was dropped is reported and recorded, not silently absorbed', () => {
  const f = fixture({ rows: [contact(), contact({ email: SUPPRESSED })] });
  runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root });
  const m = JSON.parse(fs.readFileSync(f.out + '.manifest.json', 'utf8'));
  assert.equal(m.rows_in, 2);
  assert.equal(m.rows_written, 1);
  assert.equal(m.rows_suppressed, 1);
});

test('suppression runs on the CANONICAL row, BEFORE projection drops the email column', () => {
  // The ordering test, and the reason it exists. `hubspot/companies` has no email field
  // at all, so a projected row carries nothing the filter could recognise. If the filter
  // ran after projection, this suppressed contact would land in the CRM.
  const f = fixture({
    rows: [contact({ email: SUPPRESSED, company_name: 'Blocked Ltd', company_domain: 'ok.example' })],
  });
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'companies', ROOT: f.root });
  assert.equal(r.status, 0, r.out);
  const text = fs.readFileSync(f.out, 'utf8');
  assert.ok(!/email/i.test(text.split('\n')[0]),
    'the fixture is wrong: hubspot/companies must have no email column for this test to mean anything');
  assert.ok(!text.includes('Blocked Ltd'),
    'a suppressed contact survived because the filter ran after the email column was projected away');
  assert.equal(parseCsv(text).length, 0);
});

test('a suppressed contact survives no target — every mapping is filtered the same way', () => {
  for (const target of ['hubspot', 'salesforce', 'pipedrive', 'close', 'attio', 'generic_crm']) {
    const f = fixture({ rows: [contact(), contact({ email: SUPPRESSED, first_name: 'Nope' })] });
    const out = join(f.root, 'gtm', 'exports', `${target}.csv`);
    const r = runExport({ LIST: f.list, OUT: out, TARGET: target, OBJECT: 'contacts', ROOT: f.root });
    assert.equal(r.status, 0, `${target}:\n${r.out}`);
    assert.ok(!fs.readFileSync(out, 'utf8').includes(SUPPRESSED), `${target} leaked the suppressed row`);
  }
});

test('a suppressed DOMAIN drops the row too, even with a clean-looking address', () => {
  const f = fixture({
    rows: [contact(), contact({ email: 'someone@blocked.example', company_domain: 'blocked.example' })],
    suppression: [{ domain: 'blocked.example', reason: 'do_not_contact' }],
  });
  runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root });
  const text = fs.readFileSync(f.out, 'utf8');
  assert.ok(!text.includes('blocked.example'));
  assert.equal(parseCsv(text).length, 1);
});

test('an unreadable suppression store is a STOP, and nothing is written', () => {
  // No `gtm/suppression.jsonl` at all. Missing is not "nothing suppressed" (law 5).
  const root = projectRoot();
  const list = writeCsv(root, 'gtm/lists/l.csv', [contact()]);
  const out = join(root, 'gtm', 'exports', 'o.csv');
  const r = runExport({ LIST: list, OUT: out, TARGET: 'hubspot', ROOT: root });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['SUPPRESSION_UNAVAILABLE']);
  assert.match(r.out, /\.\/setup/, 'the refusal must name its fix');
  assert.ok(!fs.existsSync(out), 'a refusal left a file behind');
  assert.ok(!fs.existsSync(out + '.manifest.json'), 'a refusal left a manifest behind');
});

test('a corrupt suppression store is a STOP too, not a partial read', () => {
  const root = projectRoot({ suppression: [] });
  fs.writeFileSync(join(root, 'gtm', 'suppression.jsonl'), '{"email":"a@b.example"}\nnot json\n', 'utf8');
  const list = writeCsv(root, 'gtm/lists/l.csv', [contact()]);
  const out = join(root, 'gtm', 'exports', 'o.csv');
  const r = runExport({ LIST: list, OUT: out, TARGET: 'hubspot', ROOT: root });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['SUPPRESSION_UNAVAILABLE']);
  assert.ok(!fs.existsSync(out));
});

test('a nested row is refused, because the filter cannot see inside one', () => {
  // rowIdentifiers() scans top-level STRING values. An object or array value is
  // invisible to it, so a suppressed contact hidden in one is a fail-OPEN at the single
  // place law 5 is enforced. A row the filter cannot fully read is not a cleared row.
  const root = projectRoot({ suppression: [{ email: SUPPRESSED }] });
  const list = writeJsonl(root, 'gtm/lists/l.jsonl', [
    { first_name: 'Ada', emails: [{ email: SUPPRESSED }] },
  ]);
  const out = join(root, 'gtm', 'exports', 'o.csv');
  const r = runExport({ LIST: list, OUT: out, TARGET: 'generic_crm', ROOT: root });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['NESTED_ROWS']);
  assert.match(r.out, /list-hygiene/, 'the refusal must name where flattening happens');
  assert.ok(!fs.existsSync(out));
});

test('an empty list is refused rather than written as a silent no-op', () => {
  const root = projectRoot({ suppression: [] });
  const list = writeJsonl(root, 'gtm/lists/l.jsonl', []);
  const out = join(root, 'gtm', 'exports', 'o.csv');
  const r = runExport({ LIST: list, OUT: out, TARGET: 'generic_crm', ROOT: root });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['NO_ROWS']);
});

test('an unknown target and an unknown object each refuse by name', () => {
  const f = fixture({ rows: [contact()] });
  const a = runExport({ LIST: f.list, OUT: f.out, TARGET: 'zoho', ROOT: f.root });
  assert.equal(a.status, 3);
  assert.deepEqual(refusalCodes(a.out), ['UNKNOWN_TARGET']);
  assert.match(a.out, /crm-sync-expert/, 'an unknown CRM has a route, not just a rejection');

  const b = runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'deals', ROOT: f.root });
  assert.equal(b.status, 3);
  assert.deepEqual(refusalCodes(b.out), ['UNKNOWN_OBJECT']);
  assert.ok(!fs.existsSync(f.out));
});

test('a missing required variable is a usage error, distinct from a refusal', () => {
  const r = runExport({ OUT: '/tmp/nope.csv', TARGET: 'hubspot' });
  assert.equal(r.status, 2, 'exit 2 is "could not run"; exit 3 is "ran and refused"');
});

test('the manifest declares the file as PII, and says what that means afterwards', () => {
  const f = fixture({ rows: [contact()] });
  runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'contacts', ROOT: f.root,
    NOW: '2026-08-29T09:00:00Z' });
  const m = JSON.parse(fs.readFileSync(f.out + '.manifest.json', 'utf8'));
  assert.equal(m.contains_pii, true);
  assert.match(m.pii_notice, /comply erase/, 'the notice must name the reach it loses');
  assert.match(m.pii_notice, /twice/, 'an erasure now has to happen in two places; say so');
  assert.equal(m.written_at, '2026-08-29T09:00:00.000Z', 'the clock must be a seam, never implicit');
  assert.ok(Array.isArray(m.columns) && m.columns.length > 0,
    'the manifest must enumerate exactly which columns left');
});

test('the PII contents are enumerated in the SKILL.md, in both directions', () => {
  const s = skillProse();
  assert.match(s, /PII leaving the pack/i, 'the file must say plainly that it is PII leaving the pack');
  for (const claim of [/email address/i, /phone number/i, /source_endpoint/i, /fetched_at/i]) {
    assert.match(s, claim, `the "what is in the file" list is missing ${claim}`);
  }
  for (const notIn of [/Suppressed contacts/i, /inferred/i, /lawful[- ]basis/i, /verdict/i]) {
    assert.match(s, notIn, `the "what is NOT in the file" list is missing ${notIn}`);
  }
  assert.match(s, /law 7/i, 'gtm/ is PII and the file leaves it — cite the law, do not paraphrase it');
});

test('upsert-key coverage is measured and compared against the real gate key', () => {
  const floor = gateValue(loadGates(), 'quality_stops.coverage_min_pct');
  const f = fixture({ rows: [contact(), contact({ email: '', first_name: 'NoEmail' })] });
  // 50% is under the floor, so this file is only written on an explicit override that
  // names the floor it crosses — see coverage-floor.test.mjs for the refusal itself.
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root,
    ALLOW_LOW_COVERAGE: String(floor) });
  assert.equal(r.status, 0, r.out);
  const m = JSON.parse(fs.readFileSync(f.out + '.manifest.json', 'utf8'));
  assert.equal(m.upsert_key, 'email');
  assert.equal(m.upsert_key_coverage_pct, 50);
  assert.equal(m.coverage_floor_pct, floor, 'the floor must be read from gates.yaml, not typed');
  assert.equal(m.coverage_floor_key, 'gates.yaml:quality_stops.coverage_min_pct');
  assert.equal(m.coverage_override, true, 'the manifest must record that a human crossed the floor');
  assert.match(r.out, /floor/, 'the run must surface the comparison, not hide it in the manifest');
});

test('the companies object switches the upsert key to the domain', () => {
  const f = fixture({ rows: [contact()] });
  runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'companies', ROOT: f.root });
  const m = JSON.parse(fs.readFileSync(f.out + '.manifest.json', 'utf8'));
  assert.equal(m.upsert_key, 'company_domain');
});

test('a MAP file overrides the built-in defaults, because vendor field names rot', () => {
  const f = fixture({ rows: [contact()] });
  const mapFile = join(f.root, 'map.json');
  fs.writeFileSync(mapFile, JSON.stringify({ email: 'Work Email', first_name: 'Given Name' }), 'utf8');
  const r = runExport({ LIST: f.list, OUT: f.out, TARGET: 'hubspot', OBJECT: 'contacts',
    ROOT: f.root, MAP: mapFile });
  assert.equal(r.status, 0, r.out);
  const header = fs.readFileSync(f.out, 'utf8').split('\n')[0];
  assert.equal(header, 'Work Email,Given Name');
  assert.match(skillProse(), /starting point/i,
    'the defaults must be labelled as a starting point rather than a schema');
});

test('a MAP override cannot smuggle a suppressed contact past the filter', () => {
  // The nastiest version of the ordering bug: a caller-supplied map that drops the
  // email column entirely. Filtering on canonical rows first is what makes this safe.
  const f = fixture({ rows: [contact({ email: SUPPRESSED, first_name: 'Nope' }), contact()] });
  const mapFile = join(f.root, 'map.json');
  fs.writeFileSync(mapFile, JSON.stringify({ first_name: 'Given Name', title: 'Job' }), 'utf8');
  runExport({ LIST: f.list, OUT: f.out, TARGET: 'generic_crm', ROOT: f.root, MAP: mapFile });
  const text = fs.readFileSync(f.out, 'utf8');
  assert.ok(!text.includes('Nope'), 'a caller-supplied map dropped the email column and let a row through');
  assert.equal(parseCsv(text).length, 1);
});

test('the script writes through the pack\'s only filtering writer, not its own', () => {
  const script = extractScript();
  assert.match(script, /writeOutputList\(/,
    'there is no unfiltered writer in this pack, and this script must not become the first one');
  assert.match(script, /filterOutputList\(/, 'the canonical-first filter must be explicit');
  assert.ok(script.indexOf('filterOutputList(rows') < script.indexOf('kept.map(project)'),
    'the filter must run before the projection, in the source as well as in the prose');
});

test('this skill owns no endpoints and spends nothing', () => {
  const body = skillProse();
  assert.match(body, /zero API calls/i);
  assert.match(body, /owns no endpoints/i);
  assert.ok(!/`[a-z_][a-z0-9_]{3,}\(/.test(skillProse().replace(/`writeOutputList\(|`filterOutputList\(/g, '')),
    'a CRM export makes no paid call; nothing in the prose may read as one');
});
