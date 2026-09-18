// /comply — the gate, in the form that can refuse something.
//
// Before this check, /comply's rule table was executable only through a TEST harness.
// `package.json:files[]` does not ship `tests/`, so the only thing a USER ran was
// prose: the skill "returned" a verdict into the chat, wrote nothing, and no other
// skill could read it. `/campaign-review` ran three checks and none of them was
// compliance; `_lib/sender-export.mjs` documented itself as reading "a verdict written
// by /comply or /campaign-review" and required `status` + `list_hash`, which comply's
// documented per-row `{verdict: stop}` output did not have and did not persist.
//
// So a row comply refused for `source_undisclosed` stayed in the list, passed review,
// and exported. These tests exercise the script that now ships inside
// skills/comply/SKILL.md, extracted verbatim, and they are written to fail if that
// script is removed or quietly turned back into advice.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash, verdictCovers } from '../../../_lib/sender-export.mjs';
import {
  ensureSuppressionStore, addSuppressionEntry, filterOutputList, loadSuppressionStore,
} from '../../../_lib/suppression.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { gatesFileWith } from '../launch/skill-runner.mjs';
import {
  runComply, clearRow, csvOf, suppressionLines, PACK_ROOT,
} from './comply-runner.mjs';
import { loadComplyRules, checkRow, ALLOW } from './harness.mjs';

const GATES = loadGates();
const MAX_AGE_H = gateValue(GATES, 'skills.campaign_review.verdict_max_age_hours');
const NOW = '2026-08-28T12:00:00.000Z';

function fixture (t, { rows = [clearRow(1), clearRow(2)], suppress = [] } = {}) {
  const g = makeGtmTree({ prefix: 'f6-comply-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  for (const s of suppress) addSuppressionEntry({ email: s, reason: 'test' }, { root: g.root });
  const csv = csvOf(rows);
  const list = g.write('gtm/lists/q3.csv', csv);
  return {
    g, list, csv,
    rows: parseCsv(csv),
    hash: listContentHash(parseCsv(csv)),
    out: g.path('gtm/reviews/q3.comply.json'),
  };
}

const comply = (f, env = {}) => runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW, ...env });
const verdictOf = (f) => JSON.parse(fs.readFileSync(f.out, 'utf8'));

// ===========================================================================
// The path that must work, and the interface the library already advertised.
// ===========================================================================

test('a list every row clears PASSes, and the verdict binds hash and clock', (t) => {
  const f = fixture(t);
  const r = comply(f);
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^PASS /m);

  const v = verdictOf(f);
  assert.equal(v.status, 'PASS');
  assert.equal(v.kind, 'comply');
  assert.equal(v.list_hash, f.hash, 'the verdict must bind the list it read');
  assert.equal(v.issued_at, NOW);
  assert.equal(v.max_age_hours, MAX_AGE_H);
  assert.equal(v.expires_at, new Date(Date.parse(NOW) + MAX_AGE_H * 3600_000).toISOString());
  assert.equal(v.rows_total, 2);
  assert.equal(v.rows_cleared, 2);
  assert.deepEqual(v.blocking, []);
  assert.deepEqual(v.stopped, []);
  assert.deepEqual(v.jurisdictions, ['gdpr']);
});

test('the verdict satisfies the shape _lib/sender-export.mjs documented all along', (t) => {
  // readVerdict()/verdictCovers() require `status === "PASS"` and a matching
  // `list_hash`. Comply's documented output was per-row, keyed `verdict`, valued
  // allow/confirm/stop, with no hash and nowhere to live. That interface existed only
  // in a comment until now; this asserts it is real.
  const f = fixture(t);
  assert.equal(comply(f).status, 0);
  const cover = verdictCovers(verdictOf(f), f.rows);
  assert.equal(cover.ok, true, cover.reason);

  // And it is bound: one edited contact and the same verdict no longer covers the list.
  const edited = parseCsv(f.csv.replace('First1', 'Firstie'));
  assert.equal(verdictCovers(verdictOf(f), edited).ok, false);
});

// ===========================================================================
// Category one: a precondition. Blocks the run, writes nothing about the person.
// ===========================================================================

test('a missing data_source stops the row, names the fix, and FAILs the list', (t) => {
  const f = fixture(t, { rows: [clearRow(1), clearRow(2, { data_source: '' })] });
  const r = comply(f);
  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /^FAIL /m);

  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.equal(v.rows_stopped, 1);
  assert.equal(v.rows_cleared, 1);

  const s = v.stopped[0];
  assert.equal(s.row, 2);
  assert.equal(s.contact, 'p2@e2.example');
  assert.equal(s.category, 'precondition');
  assert.ok(s.reasons.includes('gdpr:source_undisclosed'), JSON.stringify(s.reasons));
  assert.ok(s.fixes.some((x) => /data_source/.test(x)), 'a stop must carry the fix, not just the code');
  assert.ok(v.blocking.includes('gdpr:source_undisclosed'));
});

test('a precondition stop leaves the suppression store byte-identical', (t) => {
  // The trap this suite exists to avoid. Suppression is append-only and has no
  // un-suppress path; writing a paperwork gap into it burns a contact permanently for
  // a missing column, silently and irreversibly.
  const f = fixture(t, {
    rows: [
      clearRow(1, { data_source: '' }),                                   // precondition
      clearRow(2, { lia_record_id: '' }),                                 // precondition
      clearRow(3, { unsubscribe_mechanism: '' }),                         // precondition
      clearRow(4, { email: 'someone@gmail.com', website: 'gmail.com' }),  // personal inbox
      clearRow(5, { subject_country: '' }),                               // unresolved
    ],
  });
  const before = fs.readFileSync(path.join(f.g.root, 'gtm', 'suppression.jsonl'), 'utf8');

  const r = comply(f);
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.rows_stopped, 5);
  assert.deepEqual(v.opt_outs_recorded, [], 'no opt-out was expressed by any of these rows');
  for (const s of v.stopped) {
    assert.notEqual(s.category, 'opt_out', `row ${s.row} was miscategorised: ${JSON.stringify(s.reasons)}`);
  }

  const after = fs.readFileSync(path.join(f.g.root, 'gtm', 'suppression.jsonl'), 'utf8');
  assert.equal(after, before, 'a fixable paperwork gap must never reach the suppression store');
});

test('a precondition stop is RE-CHECKABLE: fix the record, run again, it clears', (t) => {
  const f = fixture(t, { rows: [clearRow(1), clearRow(2, { data_source: '' })] });
  assert.equal(comply(f).status, 3);

  // The operator fills in the column. Nothing else changes.
  fs.writeFileSync(f.list, csvOf([clearRow(1), clearRow(2, { data_source: 'webinar-2026' })]));
  const again = comply(f);
  assert.equal(again.status, 0, again.out);

  const v = verdictOf(f);
  assert.equal(v.status, 'PASS');
  assert.equal(v.rows_cleared, 2);
  assert.equal(v.list_hash, listContentHash(parseCsv(fs.readFileSync(f.list, 'utf8'))));
  assert.deepEqual(suppressionLines(f.g.root), [], 'nothing about that contact was made permanent');
});

test('a personal inbox without a consent record is a precondition, not an opt-out', (t) => {
  const f = fixture(t, { rows: [clearRow(1, { email: 'someone@gmail.com', website: 'gmail.com' })] });
  assert.equal(comply(f).status, 3);
  const s = verdictOf(f).stopped[0];
  assert.equal(s.category, 'precondition');
  assert.ok(s.reasons.includes('gdpr:personal_inbox_without_consent'), JSON.stringify(s.reasons));

  // And the way through is a real consent record, not a flag.
  fs.writeFileSync(f.list, csvOf([clearRow(1, {
    email: 'someone@gmail.com', website: 'gmail.com', lawful_basis: 'consent',
    consent_record_id: 'C-1', consent_timestamp: '2026-01-01T00:00:00Z',
  })]));
  assert.equal(comply(f).status, 0);
});

test('an unresolved jurisdiction is its own category and its own fix', (t) => {
  const f = fixture(t, { rows: [clearRow(1, { subject_country: '' })] });
  assert.equal(comply(f).status, 3);
  const s = verdictOf(f).stopped[0];
  assert.equal(s.category, 'unresolved');
  assert.deepEqual(s.jurisdictions, []);
  assert.deepEqual(s.reasons, ['unknown_jurisdiction']);
  assert.ok(s.fixes.some((x) => /subject_country/.test(x)));
});

// ===========================================================================
// Category two: the contact said no. This one IS permanent, and only this one.
// ===========================================================================

test('an objection is recorded on the suppression store, with its own reason', (t) => {
  const f = fixture(t, { rows: [clearRow(1), clearRow(2, { objection: 'true' })] });
  const r = comply(f);
  assert.equal(r.status, 3, r.out);

  const v = verdictOf(f);
  const s = v.stopped[0];
  assert.equal(s.category, 'opt_out');
  assert.ok(s.reasons.includes('gdpr:objection_recorded'));
  assert.deepEqual(v.opt_outs_recorded, [{ row: 2, contact: 'p2@e2.example', reason: 'comply_objection' }]);

  const store = suppressionLines(f.g.root);
  assert.equal(store.length, 1);
  assert.equal(store[0].email, 'p2@e2.example');
  assert.equal(store[0].reason, 'comply_objection', 'the reason must distinguish this from an unsubscribe reply');
  assert.equal(store[0].source, 'comply');

  // Announced, not buried.
  assert.match(r.stdout, /permanent/);
});

test('recording an objection is idempotent, and the contact stays out of every list', (t) => {
  const f = fixture(t, { rows: [clearRow(1), clearRow(2, { objection: 'true' })] });
  assert.equal(comply(f).status, 3);
  assert.equal(comply(f).status, 3);
  assert.equal(suppressionLines(f.g.root).length, 1, 'a second run must not append a second entry');

  // filterOutputList is the one filter every writer in the pack passes through —
  // /launch's sender export and /crm-export's import file both run it. So the opt-out
  // is enforced on both paths without either skill knowing /comply exists.
  const { kept, dropped } = filterOutputList(f.rows, { root: f.g.root });
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].status, 'skipped_suppressed');
  assert.ok(!kept.some((r) => r.email === 'p2@e2.example'));
});

test('an opt-out of SALE is not an opt-out of contact, so it is not suppressed', (t) => {
  // CCPA Sec. 1798.120 is about sale and sharing. Expanding it into "never contact me"
  // would be this pack inventing a wish the contact did not express, and it would be
  // irreversible. It stops the row; it writes nothing.
  const f = fixture(t, {
    rows: [clearRow(1, {
      subject_country: 'US', subject_region: 'US-CA', lawful_basis: '',
      lia_record_id: '', notice_at_collection: 'true',
    })],
  });
  const listWithOptOut = fs.readFileSync(f.list, 'utf8').replace(/\n$/, '') + '\n';
  fs.writeFileSync(f.list, listWithOptOut.replace('address_type\n', 'address_type,opt_out_sale\n')
    .replace(/\n(p1@e1\.example.*)$/m, '\n$1,true'));

  assert.equal(comply(f).status, 3);
  const v = verdictOf(f);
  assert.ok(v.stopped[0].reasons.includes('ccpa:opt_out_of_sale_recorded'), JSON.stringify(v.stopped[0].reasons));
  assert.equal(v.stopped[0].category, 'precondition');
  assert.deepEqual(suppressionLines(f.g.root), []);
});

test('a contact already suppressed is reported as an opt-out, and nothing is re-written', (t) => {
  const f = fixture(t, { rows: [clearRow(1), clearRow(2)], suppress: ['p2@e2.example'] });
  const before = suppressionLines(f.g.root);
  assert.equal(comply(f).status, 3);

  const s = verdictOf(f).stopped[0];
  assert.equal(s.category, 'opt_out');
  assert.ok(s.reasons.includes('gdpr:suppressed'));
  assert.deepEqual(suppressionLines(f.g.root), before, 'an existing entry is not duplicated');
});

// ===========================================================================
// Fail closed. Every one of these writes a FAIL verdict rather than nothing,
// because a FAIL on disk is what stops the next skill; silence does not.
// ===========================================================================

test('no readable suppression store is a FAIL, not a skipped check', (t) => {
  const f = fixture(t);
  fs.rmSync(path.join(f.g.root, 'gtm', 'suppression.jsonl'));

  const r = comply(f);
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.equal(v.failed_closed.code, 'suppression_unreadable');
  assert.equal(v.rows_cleared, 0);
  assert.match(r.stdout, /setup/);
  // A verdict that could not establish its own lifetime has already expired.
  assert.ok(v.expires_at >= v.issued_at);
});

test('a gates.yaml key that does not resolve is a FAIL (law 5)', (t) => {
  const f = fixture(t);
  const broken = gatesFileWith(f.g.root, (d) => { delete d.skills.campaign_review.verdict_max_age_hours; });

  const r = comply(f, { GATES_FILE: broken });
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.equal(v.max_age_hours, null);
  assert.equal(v.expires_at, v.issued_at, 'a verdict with no measurable lifetime is born expired');
  assert.match(v.failed_closed.reason, /failing closed/);
});

test('the gate table IS the gate: no table, no clearance', (t) => {
  const f = fixture(t);
  const noTable = f.g.write('notes.md', '# a file with no comply-rules block\n');

  const r = comply(f, { RULES: noTable });
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.equal(v.failed_closed.code, 'comply_rules_unavailable');
  assert.ok(v.blocking.includes('comply_rules_unavailable'));
});

test('a rule table that fails open is refused outright', (t) => {
  const f = fixture(t);
  const src = fs.readFileSync(path.join(PACK_ROOT, 'skills', 'comply', 'SKILL.md'), 'utf8');
  const opened = f.g.write('opened.md', src.replace('default_verdict: stop', 'default_verdict: allow'));

  const r = comply(f, { RULES: opened });
  assert.equal(r.status, 3, r.out);
  assert.match(verdictOf(f).failed_closed.reason, /law 5/);
});

// ===========================================================================
// One rule table, one implementation of it.
// ===========================================================================

test('the shipped script and the conformance harness never disagree', (t) => {
  // The rule table lives in skills/comply/SKILL.md and tests/evals/comply/ runs it
  // through harness.mjs. The script the USER runs now also runs it. Two readers of one
  // table is fine; two readers that drift is not, and drift would fail open silently.
  const rows = [
    clearRow(1),                                                            // gdpr, clears
    clearRow(2, { data_source: '' }),                                       // gdpr, no source
    clearRow(3, { lawful_basis: 'vibes' }),                                 // basis not accepted
    clearRow(4, { lia_record_id: '' }),                                     // evidence missing
    clearRow(5, { email: 'x@y.gmail.com', website: 'gmail.com', address_type: 'personal' }),
    clearRow(6, { subject_country: '' }),                                   // unresolved
    clearRow(7, { subject_country: 'CA', lawful_basis: '', consent_kind: 'implied', consent_event: 'inquiry', consent_timestamp: '2020-01-01T00:00:00Z' }),
    clearRow(8, { subject_country: 'CA', lawful_basis: '', consent_kind: 'express', consent_record_id: 'C-8', consent_timestamp: '2026-08-01T00:00:00Z' }),
    clearRow(9, { subject_country: 'US', subject_region: 'US-CA', lawful_basis: '', lia_record_id: '' }),
    clearRow(10, { subject_country: '', subject_region: '', lawful_basis: '' }),
  ];
  const f = fixture(t, { rows });
  comply(f);

  const rules = loadComplyRules();
  const store = loadSuppressionStore({ root: f.g.root });
  const now = new Date(NOW);
  const scriptStopped = new Set(verdictOf(f).stopped.map((s) => s.row));

  f.rows.forEach((row, i) => {
    const harness = checkRow(row, { rules, store, now });
    assert.equal(
      scriptStopped.has(i + 1), harness.verdict !== ALLOW,
      `row ${i + 1} (${row.email}): the shipped script and harness.mjs disagree. `
      + `harness said ${harness.verdict} (${harness.reasons.join(', ')})`);
  });
  assert.ok(scriptStopped.size > 0 && scriptStopped.size < rows.length,
    'the corpus must contain both clears and stops or this proves nothing');
});
