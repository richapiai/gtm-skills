// /launch — the gate with teeth (the sole writer of a sender export).
//
// Sending is external and permanent, so the sender export is the last artifact the
// pack controls. These tests assert the four refusals fire, that each names itself
// and its fix, and that a refusal leaves NO file behind — a half-written export is
// a copy-pasteable export.
//
// Every case runs the script that ships inside skills/launch/SKILL.md, extracted
// verbatim. A gate that only exists in a test helper is decorative.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash, verifySenderExport, readExportHeader } from '../../../_lib/sender-export.mjs';
import { ensureSuppressionStore, addSuppressionEntry } from '../../../_lib/suppression.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { runLaunch, refusalCodes, gatesFileWith, PACK_ROOT } from './skill-runner.mjs';

const GATES = loadGates();
const MAX_AGE_H = gateValue(GATES, 'skills.campaign_review.verdict_max_age_hours');

const LIST_CSV = [
  'email,first_name,last_name,company_name,website,linkedin_url,email_status',
  'ada@a.example,Ada,Lovelace,Analytical Engines,a.example,https://li/ada,valid',
  'alan@b.example,Alan,Turing,Bletchley,b.example,https://li/alan,valid',
  'grace@c.example,Grace,Hopper,Compilers,c.example,https://li/grace,valid',
].join('\n') + '\n';

const NOW = '2026-08-28T12:00:00.000Z';

/** A project tree with a list, a suppression store, and paths for everything. */
function fixture (t, { csv = LIST_CSV, suppress = [] } = {}) {
  const g = makeGtmTree({ prefix: 's4-launch-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  for (const s of suppress) addSuppressionEntry({ email: s, reason: 'test' }, { root: g.root });

  const list = g.write('gtm/lists/q3.csv', csv);
  const rows = parseCsv(fs.readFileSync(list, 'utf8'));
  return {
    g,
    list,
    rows,
    hash: listContentHash(rows),
    verdictPath: g.path('gtm/reviews/q3.verdict.json'),
    out: g.path('gtm/exports/q3.smartlead.csv'),
  };
}

function writeVerdict (f, over = {}) {
  const v = {
    schema_version: 1,
    verdict_id: 'cr-test',
    status: 'PASS',
    list_file: 'gtm/lists/q3.csv',
    list_hash: f.hash,
    rows_total: f.rows.length,
    issued_at: NOW,
    checks: [],
    blocking: [],
    ...over,
  };
  fs.mkdirSync(path.dirname(f.verdictPath), { recursive: true });
  fs.writeFileSync(f.verdictPath, JSON.stringify(v, null, 2));
  return v;
}

const launch = (f, env = {}) => runLaunch({
  LIST: f.list, VERDICT: f.verdictPath, OUT: f.out, PLATFORM: 'smartlead',
  ROOT: f.g.root, NOW, ...env,
});

// ===========================================================================
// The path that must work, or the gate is just an off switch.
// ===========================================================================

test('a PASS verdict bound to this exact list writes the export', (t) => {
  const f = fixture(t);
  writeVerdict(f);

  const r = launch(f);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^WROTE /m);
  assert.ok(fs.existsSync(f.out), 'the export must exist');

  // The binding header is what makes the gate observable after the fact.
  const header = readExportHeader(f.out);
  assert.equal(header.platform, 'smartlead');
  assert.equal(header.list_hash, f.hash);
  assert.equal(header.rows, '3');
  assert.equal(verifySenderExport(f.out, f.rows).ok, true);

  // Smartlead's columns, header line first so the CSV still parses for the sender.
  const lines = fs.readFileSync(f.out, 'utf8').split('\n');
  assert.match(lines[0], /^#gtm-launch /);
  assert.equal(lines[1], 'email,first_name,last_name,company_name,website,linkedin_url,custom_1');
});

// ===========================================================================
// Refusal 1 — NO_VERDICT.
// ===========================================================================

test('REFUSAL 1: no verdict at all', (t) => {
  const f = fixture(t);                       // deliberately never written

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['NO_VERDICT']);
  assert.match(r.stderr, /no review verdict/);
  assert.match(r.stderr, /fix: Run \/campaign-review/);
  assert.equal(fs.existsSync(f.out), false, 'a refusal must leave no file behind');
});

test('REFUSAL 1: a verdict that is not readable JSON is no verdict', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.verdictPath), { recursive: true });
  fs.writeFileSync(f.verdictPath, '{ this is not json');

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['NO_VERDICT']);
  assert.match(r.stderr, /not readable JSON/);
  assert.equal(fs.existsSync(f.out), false);
});

// ===========================================================================
// Refusal 2 — FAIL_VERDICT.
// ===========================================================================

test('REFUSAL 2: a FAIL verdict is refused, and names what blocked it', (t) => {
  const f = fixture(t);
  writeVerdict(f, { status: 'FAIL', blocking: ['quality_stops.coverage_min_pct', 'suppression'] });

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['FAIL_VERDICT']);
  assert.match(r.stderr, /status is "FAIL", not PASS/);
  assert.match(r.stderr, /quality_stops\.coverage_min_pct/, 'the blocking gates must reach the user');
  assert.equal(fs.existsSync(f.out), false);
});

test('REFUSAL 2: every non-PASS status fails closed, including a lowercase one', (t) => {
  for (const status of ['FAIL', 'fail', 'pass', 'ISSUES', 'PASS_WITH_NOTES', null]) {
    const f = fixture(t);
    writeVerdict(f, { status });
    const r = launch(f);
    assert.equal(r.status, 3, `status ${JSON.stringify(status)} must refuse`);
    assert.ok(refusalCodes(r.out).includes('FAIL_VERDICT'), `status ${JSON.stringify(status)}: ${r.out}`);
    assert.equal(fs.existsSync(f.out), false);
  }
});

// ===========================================================================
// Refusal 3 — HASH_MISMATCH. Change ONE row after the verdict.
// ===========================================================================

test('REFUSAL 3: one row edited after the verdict voids it', (t) => {
  const f = fixture(t);
  writeVerdict(f);                             // PASS, bound to the list as it was

  // The single-character edit the whole mechanism exists to catch.
  fs.writeFileSync(f.list, LIST_CSV.replace('grace@c.example', 'gracie@c.example'));

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['HASH_MISMATCH']);
  assert.match(r.stderr, /The list changed after the review/);
  assert.match(r.stderr, new RegExp(f.hash.slice(0, 12)), 'the reviewed hash must be shown');
  assert.equal(fs.existsSync(f.out), false);
});

test('REFUSAL 3: adding and removing a contact are both caught', (t) => {
  for (const edit of [
    LIST_CSV + 'mallory@x.example,M,X,X Ltd,x.example,https://li/m,valid\n',   // added
    LIST_CSV.split('\n').filter((l) => !l.startsWith('alan@')).join('\n'),      // removed
  ]) {
    const f = fixture(t);
    writeVerdict(f);
    fs.writeFileSync(f.list, edit);
    const r = launch(f);
    assert.equal(r.status, 3);
    assert.deepEqual(refusalCodes(r.out), ['HASH_MISMATCH']);
    assert.equal(fs.existsSync(f.out), false);
  }
});

test('REFUSAL 3: a verdict with no list_hash is bound to nothing', (t) => {
  const f = fixture(t);
  writeVerdict(f, { list_hash: undefined });

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['HASH_MISMATCH']);
  assert.match(r.stderr, /not bound to any list/);
  assert.equal(fs.existsSync(f.out), false);
});

test('reordering columns is NOT a change, so it does not refuse', (t) => {
  const f = fixture(t);
  writeVerdict(f);

  // Same people, same values, different column order. The hash is over values.
  const rows = parseCsv(LIST_CSV);
  const cols = ['email_status', 'linkedin_url', 'website', 'company_name', 'last_name', 'first_name', 'email'];
  fs.writeFileSync(f.list, [cols.join(','), ...rows.map((r) => cols.map((c) => r[c]).join(','))].join('\n') + '\n');

  const r = launch(f);
  assert.equal(r.status, 0, r.out);
  assert.ok(fs.existsSync(f.out));
});

// ===========================================================================
// Refusal 4 — STALE_VERDICT. The one the content hash cannot see.
// ===========================================================================

test('REFUSAL 4: a verdict older than verdict_max_age_hours is refused', (t) => {
  const f = fixture(t);
  const issued = new Date(Date.parse(NOW) - (MAX_AGE_H + 1) * 3600_000).toISOString();
  writeVerdict(f, { issued_at: issued });

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['STALE_VERDICT'], r.out);
  assert.match(r.stderr, /verdict_max_age_hours/);
  assert.match(r.stderr, /suppression and verification state move/);
  assert.equal(fs.existsSync(f.out), false);

  // The hash still matches. Age alone is the refusal, which is the whole point.
  assert.equal(JSON.parse(fs.readFileSync(f.verdictPath, 'utf8')).list_hash, f.hash);
});

test('REFUSAL 4: the boundary. One hour inside the window still launches', (t) => {
  const inside = fixture(t);
  writeVerdict(inside, { issued_at: new Date(Date.parse(NOW) - (MAX_AGE_H - 1) * 3600_000).toISOString() });
  assert.equal(launch(inside).status, 0);
  assert.ok(fs.existsSync(inside.out));

  const outside = fixture(t);
  writeVerdict(outside, { issued_at: new Date(Date.parse(NOW) - (MAX_AGE_H + 1) * 3600_000).toISOString() });
  assert.equal(launch(outside).status, 3);
  assert.equal(fs.existsSync(outside.out), false);
});

test('REFUSAL 4: an age that cannot be measured is treated as expired', (t) => {
  for (const issued_at of [undefined, '', 'yesterday', null]) {
    const f = fixture(t);
    writeVerdict(f, { issued_at });
    const r = launch(f);
    assert.equal(r.status, 3, `issued_at ${JSON.stringify(issued_at)} must refuse`);
    assert.deepEqual(refusalCodes(r.out), ['STALE_VERDICT']);
    assert.match(r.stderr, /age cannot be established|no readable issued_at/);
    assert.equal(fs.existsSync(f.out), false);
  }
});

test('a verdict cannot extend its own life by claiming a later expiry', (t) => {
  const f = fixture(t);
  writeVerdict(f, {
    issued_at: new Date(Date.parse(NOW) - (MAX_AGE_H + 1) * 3600_000).toISOString(),
    expires_at: '2099-01-01T00:00:00.000Z',      // the document's own claim
    max_age_hours: 100000,                        // and its own idea of the window
  });

  const r = launch(f);
  assert.equal(r.status, 3, 'age is measured against gates.yaml, not against the verdict');
  assert.deepEqual(refusalCodes(r.out), ['STALE_VERDICT']);
  assert.equal(fs.existsSync(f.out), false);
});

test('the staleness window is read from gates.yaml, not hard-coded', (t) => {
  const f = fixture(t);
  writeVerdict(f, { issued_at: new Date(Date.parse(NOW) - 2 * 3600_000).toISOString() });

  // Two hours old: fine under the shipped window, refused under a one-hour one.
  assert.equal(launch(f).status, 0);
  fs.rmSync(f.out);

  const tight = gatesFileWith(f.g.root, (d) => { d.skills.campaign_review.verdict_max_age_hours = 1; });
  const r = launch(f, { GATES_FILE: tight });
  assert.equal(r.status, 3, r.out);
  assert.deepEqual(refusalCodes(r.out), ['STALE_VERDICT']);
  assert.equal(fs.existsSync(f.out), false);
});

// ===========================================================================
// The two other stops, and the fail-closed posture of the gate itself.
// ===========================================================================

test('max_export_rows stops an oversized list', (t) => {
  const f = fixture(t);
  writeVerdict(f);
  const tiny = gatesFileWith(f.g.root, (d) => { d.skills.launch.max_export_rows = 2; });

  const r = launch(f, { GATES_FILE: tiny });
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['TOO_MANY_ROWS']);
  assert.match(r.stderr, /gates\.yaml:skills\.launch\.max_export_rows/);
  assert.equal(fs.existsSync(f.out), false);
});

test('require_pass_verdict can be tightened, never disarmed', (t) => {
  const f = fixture(t);
  writeVerdict(f);

  for (const mutate of [
    (d) => { d.skills.launch.require_pass_verdict = false; },
    (d) => { delete d.skills.launch.require_pass_verdict; },
  ]) {
    const g = gatesFileWith(f.g.root, mutate);
    const r = launch(f, { GATES_FILE: g });
    assert.equal(r.status, 3, 'turning the gate off must stop exporting, not start it');
    assert.ok(refusalCodes(r.out).includes('GATE_OFF'), r.out);
    assert.equal(fs.existsSync(f.out), false);
  }
});

test('an unknown sender platform is refused before anything is written', (t) => {
  const f = fixture(t);
  writeVerdict(f);
  const r = launch(f, { PLATFORM: 'mailchimp' });
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['UNKNOWN_PLATFORM']);
  assert.match(r.stderr, /smartlead/);
  assert.equal(fs.existsSync(f.out), false);
});

// ===========================================================================
// Every refusal is explained. "Refused" with no reason is how a user routes
// around a gate.
// ===========================================================================

test('every refusal names its code, its reason and its fix', (t) => {
  const cases = [
    ['NO_VERDICT', (f) => {}],
    ['FAIL_VERDICT', (f) => writeVerdict(f, { status: 'FAIL' })],
    ['HASH_MISMATCH', (f) => { writeVerdict(f); fs.writeFileSync(f.list, LIST_CSV.replace('Ada', 'Adah')); }],
    ['STALE_VERDICT', (f) => writeVerdict(f, { issued_at: new Date(Date.parse(NOW) - (MAX_AGE_H + 1) * 3600_000).toISOString() })],
  ];
  for (const [code, setup] of cases) {
    const f = fixture(t);
    setup(f);
    const r = launch(f);
    assert.equal(r.status, 3, code);
    assert.deepEqual(refusalCodes(r.out), [code]);
    assert.match(r.stderr, /^REFUSED — nothing was written to /m, code);
    assert.match(r.stderr, /^ {4}fix: \S/m, `${code} must tell the user what to do about it`);
    assert.equal(fs.existsSync(f.out), false, `${code} left a file behind`);
  }
});

test('several problems at once are all reported, not just the first', (t) => {
  const f = fixture(t);
  writeVerdict(f, { status: 'FAIL', issued_at: new Date(Date.parse(NOW) - (MAX_AGE_H + 1) * 3600_000).toISOString() });
  fs.writeFileSync(f.list, LIST_CSV.replace('Ada', 'Adah'));

  const r = launch(f);
  assert.equal(r.status, 3);
  assert.deepEqual(refusalCodes(r.out), ['FAIL_VERDICT', 'HASH_MISMATCH', 'STALE_VERDICT']);
  assert.equal(fs.existsSync(f.out), false);
});

// ===========================================================================
// Suppression is re-checked at send time, because the verdict is not a licence.
// ===========================================================================

test('a contact who unsubscribed after the review never reaches the file', (t) => {
  const f = fixture(t, { suppress: ['alan@b.example'] });
  writeVerdict(f);                             // reviewed before the unsubscribe

  const r = launch(f);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /2 written, 1 suppressed at send time/);
  const body = fs.readFileSync(f.out, 'utf8');
  assert.ok(!body.includes('alan@b.example'), 'a suppressed contact must never reach a sender file');
  assert.ok(body.includes('ada@a.example'));
});

test('no readable suppression store means no export', (t) => {
  const f = fixture(t);
  writeVerdict(f);
  fs.rmSync(path.join(f.g.root, 'gtm', 'suppression.jsonl'));

  const r = launch(f);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /suppression/i);
  assert.equal(fs.existsSync(f.out), false);
});

// ===========================================================================
// /launch is the SOLE writer, and the validator rule that says so does
// not fire on /launch itself.
// ===========================================================================

test('no skill but /launch names the export writer', () => {
  const skillsDir = path.join(PACK_ROOT, 'skills');
  const dirs = fs.readdirSync(skillsDir).filter((d) => fs.statSync(path.join(skillsDir, d)).isDirectory());
  assert.ok(dirs.includes('launch') && dirs.includes('campaign-review'), 'both new skills must be present');

  const WRITER = /\bwriteSenderExport\b/;
  let launchNamesIt = false;
  for (const d of dirs) {
    const md = path.join(skillsDir, d, 'SKILL.md');
    if (!fs.existsSync(md)) continue;          // another skill mid-write
    const body = fs.readFileSync(md, 'utf8');
    if (d === 'launch') { launchNamesIt = WRITER.test(body); continue; }
    assert.equal(WRITER.test(body), false,
      `skills/${d}/SKILL.md names the export writer, but only /launch may write a sender export`);
  }
  assert.equal(launchNamesIt, true, '/launch must actually call the writer, or the gate is documentation');
});

test('the sole-writer validator rule stays green with /launch present', () => {
  const res = spawnSync(process.execPath, ['scripts/validate-skills.mjs'], { cwd: PACK_ROOT, encoding: 'utf8' });
  const out = (res.stdout ?? '') + (res.stderr ?? '');

  // The rule must not fire on /launch itself, and must not fire on /campaign-review.
  assert.equal(/skills\/launch:/.test(out), false, `validator flagged /launch:\n${out}`);
  assert.equal(/skills\/campaign-review:/.test(out), false, `validator flagged /campaign-review:\n${out}`);
  assert.equal(/writeSenderExport/.test(out), false, `the export-boundary rule fired:\n${out}`);
});
