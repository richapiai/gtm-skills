// The channel travels the whole chain, or the chain has a hole in it.
//
// `/comply` now clears a list AND a channel. That is only worth anything if the two
// skills downstream read it: otherwise a list cleared for `phone` — screened with the
// e-mail preconditions deliberately switched off — walks through `/campaign-review`
// and out of `/launch` as a Smartlead file, which is exactly the fail-open the channel
// dimension was added to close.
//
// Every script here is the one that ships inside the SKILL.md, extracted verbatim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash } from '../../../_lib/sender-export.mjs';
import { ensureSuppressionStore } from '../../../_lib/suppression.mjs';
import { runReview, runLaunch, refusalCodes } from './skill-runner.mjs';
import { runComply, clearRow, csvOf } from '../comply/comply-runner.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

/** A call-list row: a person under GDPR, no email, no unsubscribe, no postal address. */
const phoneRow = (n) => clearRow(n, { email: '', unsubscribe_mechanism: '', phone: `+4930000000${n}` });

function fixture (t, rows) {
  const g = makeGtmTree({ prefix: 'ch-chain-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  const list = g.write('gtm/lists/calls.csv', csvOf(rows));
  return {
    g, list,
    rows: () => parseCsv(fs.readFileSync(list, 'utf8')),
    hash: () => listContentHash(parseCsv(fs.readFileSync(list, 'utf8'))),
    comply: g.path('gtm/reviews/calls.comply.json'),
    verdict: g.path('gtm/reviews/calls.verdict.json'),
    out: g.path('gtm/exports/calls.smartlead.csv'),
  };
}
const clear = (f, env = {}) => runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.comply, NOW, ...env });
const review = (f, env = {}) => runReview({ LIST: f.list, ROOT: f.g.root, OUT: f.verdict, COMPLY: f.comply, NOW, ...env });
const launch = (f, env = {}) => runLaunch({
  LIST: f.list, VERDICT: f.verdict, OUT: f.out, PLATFORM: 'smartlead', ROOT: f.g.root, NOW, ...env,
});

test('a phone clearance reviews for phone and refuses to become an e-mail export', (t) => {
  const f = fixture(t, [phoneRow(1), phoneRow(2)]);

  // 1. /comply clears the call list, for calling.
  const cy = clear(f, { CHANNEL: 'phone' });
  assert.equal(cy.status, 0, cy.out);
  const cyv = JSON.parse(fs.readFileSync(f.comply, 'utf8'));
  assert.equal(cyv.status, 'PASS');
  assert.deepEqual(cyv.channels, ['phone']);
  assert.equal(cyv.list_hash, f.hash());

  // 2. /campaign-review for PHONE stands on it and passes.
  const okReview = review(f, { CHANNEL: 'phone' });
  assert.equal(okReview.status, 0, okReview.out);
  const rv = JSON.parse(fs.readFileSync(f.verdict, 'utf8'));
  assert.equal(rv.status, 'PASS');
  assert.equal(rv.channel, 'phone');
  assert.deepEqual(rv.comply.channels, ['phone']);

  // 3. /launch writes an EMAIL artifact and refuses that clearance. This is the
  //    assertion the file exists for.
  const l = launch(f);
  assert.equal(l.status, 3, l.out);
  assert.ok(refusalCodes(l.out).includes('COMPLY_STOP'), l.out);
  assert.match(l.stderr, /clears phone/);
  assert.equal(fs.existsSync(f.out), false,
    'a list cleared only for calling produced a sender export — the e-mail preconditions were never run');
});

test('/campaign-review for e-mail refuses a phone clearance outright', (t) => {
  const f = fixture(t, [phoneRow(1)]);
  assert.equal(clear(f, { CHANNEL: 'phone' }).status, 0);

  const r = review(f, { CHANNEL: 'email' });     // email is also the default
  assert.equal(r.status, 3, r.out);
  const rv = JSON.parse(fs.readFileSync(f.verdict, 'utf8'));
  assert.equal(rv.status, 'FAIL');
  const cy = rv.checks.find((c) => c.gate === 'comply');
  assert.equal(cy.decision, 'stop');
  assert.equal(cy.comply_state, 'wrong_channel');
  assert.match(cy.reason, /clears phone/);
  assert.match(cy.reason, /CHANNEL=email/, 'name the re-run that fixes it');
});

test('the e-mail chain still runs end to end, so nothing was traded for the phone path', (t) => {
  // clearRow() is a full GDPR e-mail row: address, unsubscribe, basis and evidence.
  const f = fixture(t, [clearRow(1), clearRow(2)]);
  assert.equal(clear(f, { CHANNEL: 'email' }).status, 0);
  assert.equal(review(f).status, 0);
  const l = launch(f);
  assert.equal(l.status, 0, l.out);
  assert.ok(fs.existsSync(f.out));
});
