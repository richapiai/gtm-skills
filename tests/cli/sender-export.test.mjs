// /launch is the sole writer of sender exports.
//
// Verify: no other skill writes a sender-format file; a hash mismatch is detected.
//
// Why it matters: sending is external, so the export file is the LAST artifact the
// pack controls. If anything can write it, /comply and /campaign-review are advice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../helpers/index.mjs';
import {
  writeSenderExport, verifySenderExport, readExportHeader, listContentHash,
  verdictCovers, readVerdict, SenderExportRefused, SENDER_FORMATS, isSenderPlatform,
} from '../../_lib/sender-export.mjs';
import { ensureSuppressionStore, addSuppressionEntry } from '../../_lib/suppression.mjs';

const ROWS = [
  { email: 'ada@a.example', first_name: 'Ada', last_name: 'L', company_name: 'A' },
  { email: 'alan@b.example', first_name: 'Alan', last_name: 'T', company_name: 'B' },
];

function tree (t, { suppress = [] } = {}) {
  const g = makeGtmTree({ prefix: 't13-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  for (const s of suppress) addSuppressionEntry({ email: s, reason: 'test' }, { root: g.root });
  return g;
}
const pass = (rows) => ({ status: 'PASS', list_hash: listContentHash(rows), verdict_id: 'v1' });

// ---------------------------------------------------------------------------

test('nothing but /launch can write a sender export', (t) => {
  const g = tree(t);
  const file = path.join(g.root, 'out.csv');

  for (const actor of [null, undefined, 'personalize', 'sequence-builder', 'campaign-review', 'comply', 'Launch', '']) {
    assert.throws(
      () => writeSenderExport({ file, rows: ROWS, platform: 'smartlead', verdict: pass(ROWS), root: g.root, actor }),
      (e) => e instanceof SenderExportRefused && /only \/launch/.test(e.message),
      `actor ${JSON.stringify(actor)} must be refused`,
    );
  }
  assert.equal(fs.existsSync(file), false, 'a refused write must leave no file behind');

  const ok = writeSenderExport({ file, rows: ROWS, platform: 'smartlead', verdict: pass(ROWS), root: g.root, actor: 'launch' });
  assert.equal(ok.written, 2);
  assert.ok(fs.existsSync(file));
});

test('a STALE verdict refuses the export (the list changed after review)', (t) => {
  const g = tree(t);
  const file = path.join(g.root, 'out.csv');
  const verdict = pass(ROWS);

  // Someone adds one contact after the review passed.
  const edited = [...ROWS, { email: 'grace@c.example', first_name: 'Grace', last_name: 'H', company_name: 'C' }];

  assert.throws(
    () => writeSenderExport({ file, rows: edited, platform: 'instantly', verdict, root: g.root, actor: 'launch' }),
    (e) => e instanceof SenderExportRefused && /STALE/.test(e.message),
  );
  assert.equal(fs.existsSync(file), false);
});

test('every ambiguity fails CLOSED, never open', () => {
  const h = listContentHash(ROWS);
  const cases = [
    [null, 'not an object'],
    [{}, 'not PASS'],
    [{ status: 'FAIL', list_hash: h }, 'not PASS'],
    [{ status: 'ISSUES', list_hash: h }, 'not PASS'],
    [{ status: 'pass', list_hash: h }, 'not PASS'],            // case matters
    [{ status: 'PASS' }, 'no list_hash'],
    [{ status: 'PASS', list_hash: '' }, 'no list_hash'],
    [{ status: 'PASS', list_hash: 'deadbeef' }, 'STALE'],
  ];
  for (const [verdict, expect] of cases) {
    const r = verdictCovers(verdict, ROWS);
    assert.equal(r.ok, false, `${JSON.stringify(verdict)} must not pass`);
    assert.match(r.reason, new RegExp(expect, 'i'));
  }
  assert.equal(verdictCovers({ status: 'PASS', list_hash: h }, ROWS).ok, true);
});

test('a hand-edited export is detectable after the fact', (t) => {
  const g = tree(t);
  const file = path.join(g.root, 'out.csv');
  writeSenderExport({ file, rows: ROWS, platform: 'smartlead', verdict: pass(ROWS), root: g.root, actor: 'launch' });

  assert.equal(verifySenderExport(file, ROWS).ok, true);

  // Add a contact to the list after the export was written.
  const tampered = [...ROWS, { email: 'mallory@x.example', first_name: 'M', last_name: 'X', company_name: 'X' }];
  const bad = verifySenderExport(file, tampered);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /hand-edited|changed after launch/);

  // A file with no header was not written by /launch, and that is the finding.
  const rogue = path.join(g.root, 'rogue.csv');
  fs.writeFileSync(rogue, 'email\nada@a.example\n');
  const r = verifySenderExport(rogue, ROWS);
  assert.equal(r.ok, false);
  assert.match(r.reason, /not written by \/launch/);
});

test('the header binds platform, hash and row count', (t) => {
  const g = tree(t);
  const file = path.join(g.root, 'out.csv');
  const res = writeSenderExport({ file, rows: ROWS, platform: 'instantly', verdict: pass(ROWS), root: g.root, actor: 'launch' });

  const h = readExportHeader(file);
  assert.equal(h.platform, 'instantly');
  assert.equal(h.list_hash, listContentHash(ROWS));
  assert.equal(h.rows, '2');
  assert.equal(res.list_hash, h.list_hash);

  // The header must not break the CSV for the sender: it is a comment line first.
  const body = fs.readFileSync(file, 'utf8').split('\n');
  assert.match(body[0], /^#gtm-launch /);
  assert.equal(body[1], SENDER_FORMATS.instantly.columns.join(','));
});

test('suppression is re-checked AT SEND TIME, not just at review', (t) => {
  // Someone unsubscribes between the review passing and the launch firing.
  const g = tree(t, { suppress: ['alan@b.example'] });
  const file = path.join(g.root, 'out.csv');
  const res = writeSenderExport({ file, rows: ROWS, platform: 'smartlead', verdict: pass(ROWS), root: g.root, actor: 'launch' });

  assert.equal(res.written, 1);
  assert.equal(res.suppressed, 1);
  const body = fs.readFileSync(file, 'utf8');
  assert.ok(!body.includes('alan@b.example'), 'a suppressed contact must never reach a sender file');
  assert.ok(body.includes('ada@a.example'));
});

test('the content hash tracks contacts, not column order', () => {
  const a = [{ email: 'x@y.example', first_name: 'X' }];
  const b = [{ first_name: 'X', email: 'x@y.example' }];              // reordered keys
  const c = [{ email: 'x@y.example', first_name: 'X', note: '' }];    // empty value added
  assert.equal(listContentHash(a), listContentHash(b), 'key order is not a change');
  assert.equal(listContentHash(a), listContentHash(c), 'an empty value is not a change');

  const d = [{ email: 'x@y.example', first_name: 'Y' }];              // value changed
  const e = [...a, { email: 'z@y.example' }];                          // contact added
  assert.notEqual(listContentHash(a), listContentHash(d));
  assert.notEqual(listContentHash(a), listContentHash(e));

  // Row order is not a change either: the same people are the same list.
  const two = [{ email: 'a@x.example' }, { email: 'b@x.example' }];
  assert.equal(listContentHash(two), listContentHash([...two].reverse()));
});

test('a missing or unreadable verdict refuses, and names the fix', (t) => {
  const g = tree(t);
  const file = path.join(g.root, 'out.csv');
  assert.throws(
    () => writeSenderExport({ file, rows: ROWS, platform: 'csv', verdictPath: path.join(g.root, 'nope.json'), root: g.root, actor: 'launch' }),
    (e) => /no review verdict/.test(e.message),
  );

  const bad = path.join(g.root, 'bad.json');
  fs.writeFileSync(bad, '{not json');
  assert.throws(
    () => writeSenderExport({ file, rows: ROWS, platform: 'csv', verdictPath: bad, root: g.root, actor: 'launch' }),
    (e) => /not readable JSON/.test(e.message),
  );

  const good = path.join(g.root, 'v.json');
  fs.writeFileSync(good, JSON.stringify(pass(ROWS)));
  assert.equal(readVerdict(good).status, 'PASS');
  assert.equal(writeSenderExport({ file, rows: ROWS, platform: 'csv', verdictPath: good, root: g.root, actor: 'launch' }).written, 2);
});

test('Smartlead and Instantly are the featured senders', () => {
  const featured = Object.entries(SENDER_FORMATS).filter(([, f]) => f.featured).map(([n]) => n).sort();
  assert.deepEqual(featured, ['instantly', 'smartlead']);
  for (const p of ['apollo', 'outreach', 'lemlist']) {
    assert.equal(isSenderPlatform(p), true, `${p} is supported, just unfeatured`);
  }
  assert.equal(isSenderPlatform('mailchimp'), false);
});
