// THE REGRESSION TEST FOR THE COMPLY CHAIN: comply stops a row, /launch refuses to export it.
//
// The old behaviour, stated so this file fails loudly if it ever returns:
//
//   /comply reported a per-row `{"verdict": "stop"}` into the chat. It persisted
//   nothing, called addSuppressionEntry zero times, and had no artifact anyone could
//   read. /campaign-review ran suppression, coverage and verification — three checks,
//   none of them compliance — and PASSed. /launch read that PASS and wrote the export.
//   A row refused for `source_undisclosed` or `personal_inbox_without_consent` was
//   still in the file, still passed review, and still shipped to the sender.
//
// Every test below runs the three scripts that ship inside the three SKILL.md files,
// extracted verbatim and run exactly as the skills tell the user to run them. Nothing
// here imports a helper implementation of a gate: if the gate moves out of the skill,
// these go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash, readExportHeader } from '../../../_lib/sender-export.mjs';
import { ensureSuppressionStore, filterOutputList } from '../../../_lib/suppression.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { runReview, runLaunch, refusalCodes, PACK_ROOT } from './skill-runner.mjs';
import { runComply, clearRow, csvOf, suppressionLines } from '../comply/comply-runner.mjs';

const GATES = loadGates();
const MAX_AGE_H = gateValue(GATES, 'skills.campaign_review.verdict_max_age_hours');
const NOW = '2026-08-28T12:00:00.000Z';

function fixture (t, rows) {
  const g = makeGtmTree({ prefix: 'f6-chain-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  const list = g.write('gtm/lists/q3.csv', csvOf(rows));
  return {
    g, list,
    rows: () => parseCsv(fs.readFileSync(list, 'utf8')),
    hash: () => listContentHash(parseCsv(fs.readFileSync(list, 'utf8'))),
    setList: (r) => fs.writeFileSync(list, csvOf(r)),
    comply: g.path('gtm/reviews/q3.comply.json'),
    verdict: g.path('gtm/reviews/q3.verdict.json'),
    out: g.path('gtm/exports/q3.smartlead.csv'),
  };
}

const clear = (f, env = {}) => runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.comply, NOW, ...env });
const review = (f, env = {}) => runReview({ LIST: f.list, ROOT: f.g.root, OUT: f.verdict, COMPLY: f.comply, NOW, ...env });
const launch = (f, env = {}) => runLaunch({
  LIST: f.list, VERDICT: f.verdict, OUT: f.out, PLATFORM: 'smartlead', ROOT: f.g.root, NOW, ...env,
});

// ===========================================================================
// The chain, end to end. This single test is the point of the suite.
// ===========================================================================

test('comply stops a row, so /launch refuses to export it', (t) => {
  // Row 2 is refused for a fixable paperwork gap: nobody recorded where it came from.
  const f = fixture(t, [clearRow(1), clearRow(2, { data_source: '' }), clearRow(3)]);

  // 1. /comply stops the row and says so in a file, not in the chat.
  const cy = clear(f);
  assert.equal(cy.status, 3, cy.out);
  const cyv = JSON.parse(fs.readFileSync(f.comply, 'utf8'));
  assert.equal(cyv.status, 'FAIL');
  assert.equal(cyv.rows_stopped, 1);
  assert.equal(cyv.stopped[0].contact, 'p2@e2.example');
  assert.ok(cyv.stopped[0].reasons.includes('gdpr:source_undisclosed'));
  assert.equal(cyv.list_hash, f.hash(), 'the clearance is bound to the list it read');

  // 2. /campaign-review will not pass a list carrying a stopped row.
  const cr = review(f);
  assert.equal(cr.status, 3, cr.out);
  const crv = JSON.parse(fs.readFileSync(f.verdict, 'utf8'));
  assert.equal(crv.status, 'FAIL');
  assert.ok(crv.blocking.includes('comply'), JSON.stringify(crv.blocking));

  // 3. /launch writes nothing. THIS is the assertion the suite exists for.
  const l = launch(f);
  assert.equal(l.status, 3, l.out);
  assert.ok(refusalCodes(l.out).includes('FAIL_VERDICT'), l.out);
  assert.match(l.stderr, /comply/, 'the refusal must name the gate that stopped it');
  assert.equal(fs.existsSync(f.out), false,
    'a row /comply stopped reached a sender export — the old behaviour is back');

  // 4. And nothing permanent happened to a contact whose only sin was a missing column.
  assert.deepEqual(suppressionLines(f.g.root), [],
    'a paperwork gap must never be written into the append-only suppression store');
});

test('the block is re-checkable: fix the record, run again, it exports', (t) => {
  const f = fixture(t, [clearRow(1), clearRow(2, { data_source: '' }), clearRow(3)]);
  assert.equal(clear(f).status, 3);
  assert.equal(review(f).status, 3);
  assert.equal(launch(f).status, 3);
  assert.equal(fs.existsSync(f.out), false);

  // The operator fills in the column that was missing. That is the whole fix.
  f.setList([clearRow(1), clearRow(2, { data_source: 'webinar-2026' }), clearRow(3)]);

  assert.equal(clear(f).status, 0, 'the row clears once the record is complete');
  assert.equal(review(f).status, 0);
  const l = launch(f);
  assert.equal(l.status, 0, l.out);
  assert.ok(fs.existsSync(f.out));

  const body = fs.readFileSync(f.out, 'utf8');
  assert.ok(body.includes('p2@e2.example'), 'the previously stopped contact is now in the file');
  assert.equal(readExportHeader(f.out).list_hash, f.hash());
  assert.deepEqual(suppressionLines(f.g.root), [], 'and no permanent damage was done on the way');
});

test('dropping the stopped row is the other route, and it re-binds everything', (t) => {
  const f = fixture(t, [clearRow(1), clearRow(2, { data_source: '' }), clearRow(3)]);
  assert.equal(clear(f).status, 3);
  assert.equal(review(f).status, 3);

  // Taking the row off changes the list, which voids both verdicts. Re-running both
  // is the only way through, and it is exactly what the hash binding is for.
  f.setList([clearRow(1), clearRow(3)]);
  assert.equal(launch(f).status, 3, 'the stale verdicts do not survive the edit');
  assert.equal(fs.existsSync(f.out), false);

  assert.equal(clear(f).status, 0);
  assert.equal(review(f).status, 0);
  assert.equal(launch(f).status, 0);
  const body = fs.readFileSync(f.out, 'utf8');
  assert.ok(!body.includes('p2@e2.example'), 'the dropped contact must not be in the export');
  assert.ok(body.includes('p1@e1.example') && body.includes('p3@e3.example'));
});

test('an objection blocks the sender export AND every other output list', (t) => {
  // The other category. This one IS permanent, and it is enforced by the suppression
  // engine, which is the single filter /launch, /crm-export and /ads-audience all run
  // through. So it holds on paths that never heard of /comply.
  const f = fixture(t, [clearRow(1), clearRow(2, { objection: 'true' })]);
  assert.equal(clear(f).status, 3);

  const store = suppressionLines(f.g.root);
  assert.equal(store.length, 1);
  assert.equal(store[0].email, 'p2@e2.example');
  assert.equal(store[0].reason, 'comply_objection');

  // filterOutputList is what /crm-export calls before it writes its import file.
  const { kept, dropped } = filterOutputList(f.rows(), { root: f.g.root });
  assert.equal(dropped.length, 1);
  assert.ok(!kept.some((r) => r.email === 'p2@e2.example'));

  // And the sender path: the row must be off the list before anything ships.
  assert.equal(review(f).status, 3);
  assert.equal(launch(f).status, 3);
  assert.equal(fs.existsSync(f.out), false);

  f.setList([clearRow(1)]);
  assert.equal(clear(f).status, 0);
  assert.equal(review(f).status, 0);
  assert.equal(launch(f).status, 0);
  assert.ok(!fs.readFileSync(f.out, 'utf8').includes('p2@e2.example'));
});

// ===========================================================================
// /launch re-checks the clearance the review carried, against the list in
// front of it. The review is the gate; this is the seam that stops a
// clearance travelling to a list or a week it does not belong to.
// ===========================================================================

test('a verdict carrying a non-pass clearance is refused by /launch itself', (t) => {
  const f = fixture(t, [clearRow(1), clearRow(2)]);
  assert.equal(clear(f).status, 0);
  assert.equal(review(f).status, 0);

  const v = JSON.parse(fs.readFileSync(f.verdict, 'utf8'));
  v.comply.state = 'absent';
  v.comply.status = null;
  fs.writeFileSync(f.verdict, JSON.stringify(v));

  const l = launch(f);
  assert.equal(l.status, 3, l.out);
  assert.deepEqual(refusalCodes(l.out), ['COMPLY_STOP']);
  assert.match(l.stderr, /fix: Run \/comply/);
  assert.equal(fs.existsSync(f.out), false);
});

test('a clearance for another list does not travel into an export', (t) => {
  const f = fixture(t, [clearRow(1), clearRow(2)]);
  assert.equal(clear(f).status, 0);
  assert.equal(review(f).status, 0);

  const v = JSON.parse(fs.readFileSync(f.verdict, 'utf8'));
  v.comply.list_hash = listContentHash(parseCsv(csvOf([clearRow(9)])));
  fs.writeFileSync(f.verdict, JSON.stringify(v));

  const l = launch(f);
  assert.equal(l.status, 3);
  assert.deepEqual(refusalCodes(l.out), ['COMPLY_STOP']);
  assert.match(l.stderr, /does not travel between lists/);
  assert.equal(fs.existsSync(f.out), false);
});

test('a clearance that expired is refused even when the review is fresh', (t) => {
  const f = fixture(t, [clearRow(1), clearRow(2)]);
  assert.equal(clear(f).status, 0);
  assert.equal(review(f).status, 0);

  const v = JSON.parse(fs.readFileSync(f.verdict, 'utf8'));
  v.comply.issued_at = new Date(Date.parse(NOW) - (MAX_AGE_H + 1) * 3600_000).toISOString();
  fs.writeFileSync(f.verdict, JSON.stringify(v));

  const l = launch(f);
  assert.equal(l.status, 3);
  assert.deepEqual(refusalCodes(l.out), ['COMPLY_STOP']);
  assert.match(l.stderr, /verdict_max_age_hours/);
  assert.equal(fs.existsSync(f.out), false);

  // An unmeasurable age reads as expired, not as ageless. 12345 is the interesting
  // one: Date.parse coerces it and reads the year 12345, so a stale clearance would
  // otherwise look like one issued eight thousand years from now.
  for (const issued_at of ['last tuesday', 12345, null, undefined,
                           new Date(Date.parse(NOW) + 3600_000).toISOString()]) {
    v.comply.issued_at = issued_at;
    fs.writeFileSync(f.verdict, JSON.stringify(v));
    const bad = launch(f);
    assert.equal(bad.status, 3, `issued_at ${JSON.stringify(issued_at)} must refuse`);
    assert.deepEqual(refusalCodes(bad.out), ['COMPLY_STOP']);
    assert.match(bad.stderr, /unknown age/);
    assert.equal(fs.existsSync(f.out), false);
  }
});

// ===========================================================================
// The claim /crm-export argues its whole boundary on: "an ungated second
// export path is one copy-paste away from making /campaign-review and /comply
// advisory." That sentence is now true of /comply as well as of the review.
// ===========================================================================

test('/comply now persists a verdict, and the chain reads it', () => {
  const md = fs.readFileSync(path.join(PACK_ROOT, 'skills', 'comply', 'SKILL.md'), 'utf8');
  assert.match(md, /==== gtm-comply v1 ====/,
    '/comply must ship an executable gate. A gate that is only prose is advice.');
  assert.match(md, /list_hash/, "comply's verdict must bind the list it cleared");
  assert.match(md, /comply_objection/, 'the opt-out reason must be distinct from every other one');

  const review = fs.readFileSync(path.join(PACK_ROOT, 'skills', 'campaign-review', 'SKILL.md'), 'utf8');
  assert.match(review, /comply_state/, '/campaign-review must read the compliance verdict');

  const launchMd = fs.readFileSync(path.join(PACK_ROOT, 'skills', 'launch', 'SKILL.md'), 'utf8');
  assert.match(launchMd, /COMPLY_STOP/, '/launch must name a compliance refusal in its table');
});
