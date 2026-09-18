// tests/cli/doctor-and-explain.test.mjs
//
// The two free commands added 2026-09-02, and the properties that make them worth
// having rather than merely present.
//
//   richapi doctor              the preflight, in English, with the fix
//   richapi enrich --explain-my-list   is any of this list worth paying for?
//
// Both make ZERO API calls and need no key. That is asserted here rather than assumed:
// law 3 has no carve-out for a diagnostic, and a "free" command that reaches the network
// is the one bug that would make the whole pack's promise false.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parsePreflight, diagnose, overall, render, renderReport, readActivation,
  OK, WARN, STOP, UNKNOWN,
} from '../../_lib/doctor.mjs';
import { explainList, renderExplain, DEFAULT_MAX_ROWS } from '../../_lib/explain.mjs';
import { makeGtmTree } from '../helpers/index.mjs';
import { loadSuppressionStore, ensureSuppressionStore, addSuppressionEntry } from '../../_lib/suppression.mjs';
import { loadCache } from '../../_lib/enrich.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'bin', 'richapi.mjs');

// ---------------------------------------------------------------------------
// doctor — the classification
// ---------------------------------------------------------------------------

const HEALTHY = {
  JQ_MISSING: 'no', CATALOG_OK: 'yes', CATALOG_TOOLS: '68', CATALOG_AGE: 'never',
  CATALOG_STALE: 'no', FILTERS_OK: 'yes', API_KEY_SET: 'no',
  SKILLS_VERSION: '2.0.0-alpha.0', NET: 'online', BALANCE: 'unknown',
  SUPPRESSION: 'OK', UPGRADE: 'none',
};

test('DOC.1 — the preflight key contract parses, and unknown keys survive', () => {
  const keys = parsePreflight('CATALOG_OK: yes\nBALANCE: unknown\nA_NEW_KEY: hello\nnoise\n');
  assert.equal(keys.CATALOG_OK, 'yes');
  assert.equal(keys.BALANCE, 'unknown');
  assert.equal(keys.A_NEW_KEY, 'hello',
    'the contract is add-only, so an unrecognised key must be carried, not dropped');
});

test('DOC.2 — a healthy fresh install reports NOTHING wrong', () => {
  // The regression this exists for. Before 2026-09-02 a clean install printed
  // `CATALOG_STALE: yes` (never synced) and `BALANCE: 0` (a stale machine-global cache),
  // so the very first screen told a new user their install was broken and that they had
  // no credits. Both were false.
  const f = diagnose(HEALTHY, { stateTreeExists: true });
  const bad = f.filter(x => x.level === STOP || x.level === WARN);
  assert.deepEqual(bad, [], `a healthy install must be reported healthy, got: ${bad.map(b => b.title).join(', ')}`);
  assert.equal(overall(f), OK);
});

test('DOC.3 — a missing jq blames jq, not the catalog', () => {
  // The CRITICAL GAP this closes. Every SKILL.md reads `CATALOG_OK: no` as "regenerate
  // the catalog", which cannot help, because nothing is wrong with the catalog. The
  // check did not fail — it never ran.
  const f = diagnose({ ...HEALTHY, JQ_MISSING: 'yes', CATALOG_OK: 'unknown', CATALOG_TOOLS: 'unknown', FILTERS_OK: 'unknown' },
    { stateTreeExists: true });
  const jq = f.find(x => x.id === 'jq');
  assert.equal(jq.level, STOP);
  assert.match(jq.fix, /jq/, 'the fix must name jq, which is the thing to install');

  const cat = f.find(x => x.id === 'catalog');
  assert.equal(cat.level, UNKNOWN, 'an unmeasured check is not a failed one (law 5)');
  assert.match(cat.detail, /NOT a catalog problem/,
    'it must say outright that the catalog is probably fine, or the reader regenerates it for nothing');

  const text = render(f);
  assert.ok(!/richapi catalog gen/.test(text),
    'a jq-missing install must NOT be told to regenerate the catalog — that is the no-op fix');
});

test('DOC.4 — an unreadable suppression store is a STOP, and names the --root/--dir trap', () => {
  const f = diagnose({ ...HEALTHY, SUPPRESSION: 'STOP' }, { stateTreeExists: true });
  const s = f.find(x => x.id === 'suppression');
  assert.equal(s.level, STOP);
  assert.match(s.detail, /fail-closed/, 'it must say this is the rule working, not a bug');
  assert.match(s.detail, /--root/, 'the single most common cause is --root vs --dir');
  assert.equal(overall(f), STOP);
});

test('DOC.5 — no key is not an error, and the fix offered is the FREE path', () => {
  const f = diagnose(HEALTHY, { stateTreeExists: true });
  const key = f.find(x => x.id === 'key');
  assert.equal(key.level, OK, 'a missing key must never read as broken — dry runs are the point');
  assert.match(key.fix, /--dry-run/);
});

test('DOC.6 — a stale catalog warns but does not block', () => {
  const f = diagnose({ ...HEALTHY, CATALOG_STALE: 'yes', CATALOG_AGE: '9999999' }, { stateTreeExists: true });
  assert.equal(f.find(x => x.id === 'staleness').level, WARN);
  assert.equal(overall(f), WARN, 'a price that may have moved is a warning, not a stop');
});

test('DOC.7 — the report carries no PII, no paths, no key and no install fingerprint', (t) => {
  // 8A: the pack sends no telemetry and SECURITY.md commits to that, so the only way a
  // maintainer learns where people get stuck is a report the user chooses to paste. It
  // is worth nothing if it cannot be pasted safely.
  const tree = makeGtmTree({ prefix: 'doctor-report-' });
  t.after(() => tree.cleanup());
  // Read through the REAL loader against a REAL activation file. The first version of
  // this test hand-built `{first_run_at, runs}` and passed while `readActivation` was
  // (a) reading the wrong directory and (b) about to dump `install_id` — a stable
  // per-install UUID — into a block meant for a public issue. A privacy assertion
  // pointed at synthetic data asserts nothing.
  fs.writeFileSync(path.join(tree.gtm, 'activation.json'), JSON.stringify({
    schema_version: 1,
    install_id: 'de5a0c2f-2bbd-47c0-ae6a-2457936c7636',
    installed_at: '2026-09-01T00:00:00Z',
    first_run_at: '2026-09-02',
    last_run_at: '2026-09-02T10:00:00Z',
    runs: 3,
  }));
  const activation = readActivation(tree.gtm);
  assert.ok(activation, 'the real loader must find a real activation file');

  const keys = { ...HEALTHY, BALANCE: '412.5' };
  const out = renderReport(keys, diagnose(keys, { stateTreeExists: true }), {
    version: '2.0.0-alpha.0',
    activation,
  });
  assert.ok(!out.includes('de5a0c2f'),
    'install_id is a stable per-install fingerprint and must never reach a paste block');
  assert.ok(!/install_id/.test(out), 'not even the field name, so nobody adds it back by pattern');
  assert.ok(!out.includes('412.5'),
    'the balance is an account fact and nobody needs it to debug an install');
  assert.match(out, /BALANCE_KNOWN: yes/, 'whether one is known is the useful part');
  assert.ok(!/\/Users\/|\/home\/|C:\\\\/.test(out), 'no home-directory paths');
  // `API_KEY_SET: no` is a boolean about whether one is present, which is exactly the
  // fact a maintainer needs. What must never appear is a key VALUE.
  assert.match(out, /API_KEY_SET: no/);
  assert.ok(!/richapi_API_KEY\s*[:=]\s*\S/.test(out), 'no key value, under any spelling');
  assert.ok(!/\b[A-Za-z0-9_-]{32,}\b/.test(out), 'nothing secret-shaped in the paste block');
  assert.match(out, /runs: 3/, 'the local activation counters are the point of the report');
});

// ---------------------------------------------------------------------------
// doctor — end to end, and the zero-call promise
// ---------------------------------------------------------------------------

test('DOC.8 — `richapi doctor` runs, spends nothing, and says so', (t) => {
  const tree = makeGtmTree({ prefix: 'doctor-' });
  t.after(() => tree.cleanup());
  let out; let code = 0;
  try {
    out = execFileSync(process.execPath, [CLI, 'doctor', '--dir', tree.gtm], {
      cwd: tree.root, encoding: 'utf8',
      env: { ...process.env, richapi_API_KEY: '', richapi_SKILLS_HOME: tree.root },
    });
  } catch (e) { out = e.stdout ?? ''; code = e.status; }
  assert.match(out, /richapi doctor/);
  assert.match(out, /No API calls were made and no credits were spent/);
  assert.ok(code === 0 || code === 3, `doctor exits 0 (usable) or 3 (blocked), got ${code}`);
});

test('DOC.9 — doctor makes ZERO network calls — proven, not asserted', (t) => {
  // A preload that replaces fetch with one that cannot succeed. If doctor reaches the
  // network the child dies here rather than quietly making a call.
  const tree = makeGtmTree({ prefix: 'doctor-net-' });
  t.after(() => tree.cleanup());
  const guard = tree.write('no-network.mjs',
    "globalThis.fetch = () => { throw new Error('NETWORK CALL ATTEMPTED BY DOCTOR'); };\n");
  let out;
  try {
    out = execFileSync(process.execPath, ['--import', pathToFileURL(guard).href, CLI, 'doctor', '--dir', tree.gtm], {
      cwd: tree.root, encoding: 'utf8',
      env: { ...process.env, richapi_API_KEY: '', richapi_SKILLS_HOME: tree.root },
    });
  } catch (e) { out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  assert.ok(!out.includes('NETWORK CALL ATTEMPTED'), 'doctor reached the network');
});

// ---------------------------------------------------------------------------
// --explain-my-list
// ---------------------------------------------------------------------------

function listFixture (t, rows, header) {
  const tree = makeGtmTree({ prefix: 'explain-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const file = path.join(tree.root, 'list.csv');
  fs.writeFileSync(file, [header.join(','), ...rows.map(r => header.map(h => r[h] ?? '').join(','))].join('\n') + '\n');
  const store = loadSuppressionStore({ root: tree.root, path: path.join(tree.gtm, 'suppression.jsonl') });
  return { tree, file, store, cache: loadCache({ dir: tree.gtm }) };
}

test('EXP.1 — a list nothing can enrich says so in the first line, not in a table', () => {
  // THE PROPERTY THIS COMMAND EXISTS FOR. A zero result and a perfect result must not
  // look alike: "0 of 40,000 rows are enrichable" is the single most valuable sentence
  // it can produce, and rendering it as a quiet table row is how it gets skimmed past.
  const r = {
    rows_total: 40000, rows_analysed: 40000, truncated: false,
    enrichable: 0, suppressed: 0, cached: 0, dead: 40000,
    reasons: { 'no linkedin_url to enrich from': 40000 },
    hop_reach: { enrich_profile: 0, email_finder: 0, email_verifier: 0, phone_finder: 0 },
    columns: ['company'], missing_inputs: { linkedin_url: 40000 },
  };
  const text = renderExplain(r, { file: 'crm.csv' });
  const firstLines = text.split('\n').slice(0, 4).join('\n');
  assert.match(firstLines, /NOTHING IN THIS LIST CAN BE ENRICHED/);
  assert.match(text, /list problem, not an API problem/);
  assert.ok(!/Next: price it/.test(text), 'do not offer to price a list with nothing to price');
});

test('EXP.2 — a TRUNCATED read never renders as a total', () => {
  // Law 5. "160 of 500 rows are enrichable" and "160 of the first 500 we looked at" are
  // different sentences, and an operator deciding whether to spend on a 40k list will
  // act on the first.
  const r = {
    rows_total: 40000, rows_analysed: 500, truncated: true,
    enrichable: 160, suppressed: 0, cached: 0, dead: 340,
    reasons: {}, hop_reach: { enrich_profile: 160, email_finder: 160, email_verifier: 160, phone_finder: 0 },
    columns: ['linkedin_url'], missing_inputs: {},
  };
  const text = renderExplain(r, { file: 'crm.csv' });
  const head = text.split('\n').slice(0, 5).join('\n');
  assert.match(head, /PARTIAL READ/, 'the truncation leads; it is not a footnote');
  assert.match(head, /40000 rows in the file/);
  assert.match(head, /THOSE ROWS ONLY/);
});

test('EXP.3 — an empty file is not reported as a healthy list', () => {
  const text = renderExplain({
    rows_total: 0, rows_analysed: 0, truncated: false,
    enrichable: 0, suppressed: 0, cached: 0, dead: 0,
    reasons: {}, hop_reach: {}, columns: [], missing_inputs: {},
  });
  assert.match(text, /no data rows/);
  assert.ok(!/enrichable\s+0/.test(text), 'an empty file gets its own sentence, not a table of zeroes');
});

test('EXP.4 — a real mixed list is classified from the SAME predicate the planner uses', (t) => {
  // Not a second implementation. `toDescriptor` decides "is this row doable?" for the
  // plan, and this command calls it — because a parallel implementation is exactly how
  // the planner and executor came to disagree on 2026-08-28 and 500 of 500 units failed
  // while the plan looked perfect.
  const { file, store, cache } = listFixture(t, [
    { first_name: 'A', last_name: 'B', company_name: 'Acme', linkedin_url: 'https://linkedin.com/in/a' },
    { first_name: 'C', last_name: 'D', company_name: 'Beta' },          // no url
    { first_name: 'E', last_name: 'F' },                                 // no url, no company
  ], ['first_name', 'last_name', 'company_name', 'linkedin_url']);

  const r = explainList(file, { store, cache });
  assert.equal(r.rows_total, 3);
  assert.equal(r.rows_analysed, 3);
  assert.equal(r.truncated, false);
  assert.equal(r.hop_reach.enrich_profile, 1, 'only the row with a LinkedIn URL can be profile-enriched');
  assert.equal(r.missing_inputs.linkedin_url, 2);
  assert.ok(r.reasons['no linkedin_url to enrich from'] >= 2,
    'the actionable half: the reason a hop could not run, tallied');
});

test('EXP.5 — the cap is honoured and reported, and defaults to something usable', (t) => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ first_name: `F${i}`, last_name: 'X' }));
  const { file, store, cache } = listFixture(t, rows, ['first_name', 'last_name']);

  const capped = explainList(file, { store, cache, maxRows: 4 });
  assert.equal(capped.rows_total, 10);
  assert.equal(capped.rows_analysed, 4);
  assert.equal(capped.truncated, true, 'a cap that is not reported is a total that lies');

  const full = explainList(file, { store, cache });
  assert.equal(full.truncated, false);
  assert.equal(full.rows_analysed, 10);
  assert.ok(DEFAULT_MAX_ROWS >= 10000, 'the default must clear a real CRM export');
});

test('EXP.6 — a suppressed row is counted as suppressed, never as enrichable', (t) => {
  const { tree, file, cache } = listFixture(t, [
    { first_name: 'A', last_name: 'B', email: 'ok@acme.example', linkedin_url: 'https://linkedin.com/in/a' },
    { first_name: 'C', last_name: 'D', email: 'stop@acme.example', linkedin_url: 'https://linkedin.com/in/c' },
  ], ['first_name', 'last_name', 'email', 'linkedin_url']);
  addSuppressionEntry({ email: 'stop@acme.example', reason: 'unsubscribed' }, { root: tree.root });
  const store = loadSuppressionStore({ root: tree.root, path: path.join(tree.gtm, 'suppression.jsonl') });

  const r = explainList(file, { store, cache });
  assert.equal(r.suppressed, 1, 'a suppressed contact is never priced and never counted as buyable');
  assert.equal(r.enrichable + r.dead + r.cached, 1);
});

test('EXP.7 — `--explain-my-list` runs from the CLI, needs no key, and spends nothing', (t) => {
  const tree = makeGtmTree({ prefix: 'explain-cli-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const file = path.join(tree.root, 'list.csv');
  fs.writeFileSync(file, 'first_name,last_name,linkedin_url\nAda,L,https://linkedin.com/in/ada\n');

  const guard = tree.write('no-network.mjs',
    "globalThis.fetch = () => { throw new Error('NETWORK CALL ATTEMPTED BY EXPLAIN'); };\n");
  const out = execFileSync(process.execPath,
    ['--import', pathToFileURL(guard).href, CLI, 'enrich', file, '--explain-my-list', '--dir', tree.gtm],
    { cwd: tree.root, encoding: 'utf8', env: { ...process.env, richapi_API_KEY: '' } });

  assert.match(out, /LIST QUALITY/);
  assert.match(out, /no calls made, no credits spent/);
  assert.ok(!out.includes('NETWORK CALL ATTEMPTED'), 'explain reached the network');
});

test('EXP.8 — an unreadable suppression store refuses, rather than understating suppression', (t) => {
  // This command REPORTS on suppression, so a store it could not read would make it
  // report zero suppressed rows — the fail-open shape law 5 exists to forbid.
  const tree = makeGtmTree({ prefix: 'explain-nostore-' });
  t.after(() => tree.cleanup());
  const file = path.join(tree.root, 'list.csv');
  fs.writeFileSync(file, 'first_name,linkedin_url\nAda,https://linkedin.com/in/ada\n');
  fs.rmSync(path.join(tree.gtm, 'suppression.jsonl'), { force: true });

  let code = 0; let stderr = '';
  try {
    execFileSync(process.execPath, [CLI, 'enrich', file, '--explain-my-list', '--dir', tree.gtm],
      { cwd: tree.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { code = e.status; stderr = e.stderr ?? ''; }
  assert.equal(code, 5, 'the pack-wide exit code for an unreadable suppression store');
  assert.match(stderr, /failing closed/);
});
