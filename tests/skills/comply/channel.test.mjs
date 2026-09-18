// /comply — a verdict is per CHANNEL.
//
// THE DEFECT, from a live run on 2026-09-17. `/comply` had one dimension: the list.
// Every run was therefore implicitly an EMAIL run, and the CAN-SPAM preconditions —
// a working unsubscribe, a valid physical postal address (15 U.S.C. 7704(a)(5)) —
// fired on lists with no email column on them at all. The `local-business-outbound`
// recipe ends in a call list by design; it could never clear, and the operator had
// nothing to put in `sender_postal_address` because nobody was going to send an email.
//
// So the caller states the channel, preconditions apply only to the channels in play,
// and the verdict names the channels it clears. Every assertion below fails against
// the single-dimension gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import { parseCsv } from '../../../_lib/csv.mjs';
import { listContentHash, verdictCovers } from '../../../_lib/sender-export.mjs';
import { ensureSuppressionStore, loadSuppressionStore } from '../../../_lib/suppression.mjs';
import { runComply, clearRow, csvOf, suppressionLines } from './comply-runner.mjs';
import { loadComplyRules, checkRow, ALLOW, STOP } from './harness.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

/** A row on a PHONE list: a person and a number, and no email anywhere on it. */
const phoneRow = (n, over = {}) => clearRow(n, {
  email: '', unsubscribe_mechanism: '', phone: `+4930000000${n}`, ...over,
});

function fixture (t, rows) {
  const g = makeGtmTree({ prefix: 'ch-comply-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  const csv = csvOf(rows);
  const list = g.write('gtm/lists/calls.csv', csv);
  return { g, list, csv, rows: parseCsv(csv), out: g.path('gtm/reviews/calls.comply.json') };
}
const comply = (f, env = {}) => runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW, ...env });
const verdictOf = (f) => JSON.parse(fs.readFileSync(f.out, 'utf8'));

// ===========================================================================
// The list the old gate could never clear.
// ===========================================================================

test('a phone-only list clears for phone and stays blocked for email', (t) => {
  // Two GDPR rows with a phone number, a lawful basis and its evidence — and no email
  // address, no unsubscribe link and no sender postal address, because none of those
  // three is a thing a phone call has.
  const f = fixture(t, [phoneRow(1), phoneRow(2)]);

  const onPhone = comply(f, { CHANNEL: 'phone' });
  assert.equal(onPhone.status, 0, onPhone.out);
  const cleared = verdictOf(f);
  assert.equal(cleared.status, 'PASS');
  assert.equal(cleared.channel, 'phone');
  assert.deepEqual(cleared.channels, ['phone']);
  assert.deepEqual(cleared.cleared_for, ['phone']);
  assert.equal(cleared.rows_cleared, 2);
  assert.match(onPhone.stdout, /channel\s+phone/);

  // The SAME list, the SAME rows, on email: the unsubscribe precondition is back in
  // play and the list stops. That is the point — one list, two answers.
  const onEmail = comply(f, { CHANNEL: 'email' });
  assert.equal(onEmail.status, 3, onEmail.out);
  const blocked = verdictOf(f);
  assert.equal(blocked.status, 'FAIL');
  assert.deepEqual(blocked.channels, ['email']);
  assert.deepEqual(blocked.cleared_for, []);
  assert.ok(blocked.blocking.includes('gdpr:no_unsubscribe_mechanism'), JSON.stringify(blocked.blocking));
});

test('an unset CHANNEL is an email run, so nothing silently got weaker', (t) => {
  const f = fixture(t, [phoneRow(1)]);
  const r = comply(f);                 // no CHANNEL at all
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.channel, 'email');
  assert.deepEqual(v.channels, ['email']);
});

// ===========================================================================
// A channel nothing governs is a refusal, not a quiet clearance.
// ===========================================================================

test('a US phone row stops: CAN-SPAM is an e-mail statute and no TCPA rule set ships', (t) => {
  const f = fixture(t, [phoneRow(1, {
    subject_country: 'US', subject_region: '', lawful_basis: '', lia_record_id: '',
  })]);
  const r = comply(f, { CHANNEL: 'phone' });
  assert.equal(r.status, 3, r.out);

  const s = verdictOf(f).stopped[0];
  assert.deepEqual(s.reasons, ['no_rule_set_for_channel:phone']);
  assert.deepEqual(s.jurisdictions, ['can_spam'], 'the row DID resolve — it is the channel that has no rules');
  assert.equal(s.category, 'unresolved', 'this is not the operator\'s paperwork; no column fixes it');
  assert.ok(s.fixes.some((x) => /TCPA|telemarketing/i.test(x)),
    'the fix must say what is missing, not tell them to add a column they already have');
});

test('a channel the table does not enumerate is a FAIL verdict, never a default', (t) => {
  const f = fixture(t, [phoneRow(1)]);
  const r = comply(f, { CHANNEL: 'carrier-pigeon' });
  assert.equal(r.status, 3, r.out);
  const v = verdictOf(f);
  assert.equal(v.status, 'FAIL');
  assert.equal(v.failed_closed.code, 'unknown_channel');
  assert.equal(v.rows_cleared, 0);
});

// ===========================================================================
// mixed = every channel, which is the STRICTEST reading and never a weaker one.
// ===========================================================================

test('a mixed list must clear every channel, so an email precondition still applies', (t) => {
  const f = fixture(t, [phoneRow(1), phoneRow(2)]);
  const r = comply(f, { CHANNEL: 'mixed' });
  assert.equal(r.status, 3, r.out);

  const v = verdictOf(f);
  assert.equal(v.channel, 'mixed');
  assert.deepEqual(v.channels, ['email', 'linkedin', 'phone'],
    'mixed expands to every channel in the table, not to the ones a row happens to carry');
  assert.ok(v.blocking.includes('gdpr:no_unsubscribe_mechanism'));

  // Fill the one thing an email and a LinkedIn message both need, and the mixed list
  // clears all three channels at once.
  fs.writeFileSync(f.list, csvOf([
    phoneRow(1, { email: 'p1@e1.example', unsubscribe_mechanism: 'true' }),
    phoneRow(2, { email: 'p2@e2.example', unsubscribe_mechanism: 'true' }),
  ]));
  const again = comply(f, { CHANNEL: 'mixed' });
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(verdictOf(f).cleared_for, ['email', 'linkedin', 'phone']);
});

// ===========================================================================
// Downstream. A clearance that does not name the channel in hand clears nothing.
// ===========================================================================

test('a phone clearance cannot cover an email export', (t) => {
  const f = fixture(t, [phoneRow(1)]);
  assert.equal(comply(f, { CHANNEL: 'phone' }).status, 0);
  const v = verdictOf(f);
  assert.equal(v.list_hash, listContentHash(f.rows));

  assert.equal(verdictCovers(v, f.rows, { channel: 'phone' }).ok, true);
  const asEmail = verdictCovers(v, f.rows);      // the default, which is what /launch asks
  assert.equal(asEmail.ok, false);
  assert.match(asEmail.reason, /clears phone, not email/);
  assert.match(asEmail.reason, /CHANNEL=email/, 'name the re-run, not just the problem');
});

test('a verdict that names no channels reads as email — the narrowest reading of one', () => {
  // Every verdict written before this dimension existed meant an email run. Reading
  // one as "all channels" would retroactively clear calls nobody screened.
  const rows = [{ email: 'a@b.example' }];
  const legacy = { status: 'PASS', list_hash: listContentHash(rows) };
  assert.equal(verdictCovers(legacy, rows, { channel: 'email' }).ok, true);
  assert.equal(verdictCovers(legacy, rows, { channel: 'phone' }).ok, false);
});

// ===========================================================================
// One rule table, one implementation of it — including the channel dimension.
// ===========================================================================

test('the shipped script and the harness agree on every channel, not just on email', (t) => {
  const rows = [
    phoneRow(1),                                                    // gdpr, phone-clean
    phoneRow(2, { subject_country: 'US', lawful_basis: '', lia_record_id: '' }),
    phoneRow(3, { subject_country: 'CA', lawful_basis: '', consent_kind: 'express', consent_record_id: 'C-3', consent_timestamp: '2026-08-01T00:00:00Z' }),
    phoneRow(4, { data_source: '' }),                               // channel-independent
    clearRow(5),                                                    // a full email row
  ];
  const f = fixture(t, rows);
  const rules = loadComplyRules();
  const store = loadSuppressionStore({ root: f.g.root });

  for (const channel of ['email', 'phone', 'linkedin', 'mixed']) {
    const r = comply(f, { CHANNEL: channel });
    assert.ok([0, 3].includes(r.status), `${channel}: ${r.out}`);
    const scriptStopped = new Set(verdictOf(f).stopped.map((s) => s.row));
    f.rows.forEach((row, i) => {
      const h = checkRow(row, { rules, store, now: new Date(NOW), channel });
      assert.equal(scriptStopped.has(i + 1), h.verdict !== ALLOW,
        `${channel} row ${i + 1}: script and harness disagree. harness said ${h.verdict} (${h.reasons.join(', ')})`);
    });
  }
});

test('the gate table names a channel set for every rule set it ships', () => {
  const rules = loadComplyRules();
  const known = new Set(rules.channels.map((c) => String(c).toLowerCase()));
  assert.ok(known.size > 0);
  for (const [name, jur] of Object.entries(rules.jurisdictions)) {
    assert.ok(Array.isArray(jur.channels) && jur.channels.length > 0,
      `${name} names no \`channels\`, so it governs nothing and every channel stops on it`);
    for (const c of jur.channels) {
      assert.ok(known.has(String(c).toLowerCase()), `${name} names channel "${c}", which is not in \`channels\``);
    }
  }
  // CAN-SPAM is the one that started this: an e-mail statute, and nothing else.
  assert.deepEqual(rules.jurisdictions.can_spam.channels, ['email']);
  // And the conditions it was applying to a call list are scoped to email.
  assert.deepEqual(rules.channel_conditions.no_physical_postal_address, ['email']);
});

// ===========================================================================
// Found on 2026-09-18, running the shipped gate from a customer project.
//
// Making the VERDICT per-channel left the row's IDENTITY email-only. `contact` read
// `row.email` whatever the channel, so on a phone list it was always ''. Two things
// followed, one cosmetic and one not.
// ===========================================================================

test('a stop on a phone list names the number it stopped', (t) => {
  // Cosmetic half: every stop printed "(no address)", so an operator reading a refusal
  // on a phone list could not tell which row was refused.
  const f = fixture(t, [phoneRow(1, { data_source: '' })]);
  const r = comply(f, { CHANNEL: 'phone' });

  assert.equal(r.status, 3, r.out);
  assert.doesNotMatch(r.stdout, /\(no address\)/);
  assert.match(r.stdout, /\*\*\*000\d/);                    // last four digits, masked
  assert.doesNotMatch(r.stdout, /\+4930000000\d/);          // never the whole number
});

test('an objection with no email address is reported, never silently dropped', (t) => {
  // The half that mattered. `contact` was '' on a phone row, so the `&& contact` guard
  // on the suppression write was falsy: the gate reported the objection in its reasons
  // while writing NOTHING to the store. The next run of the same list would have found
  // no suppression entry and asked the operator to handle it again.
  const f = fixture(t, [phoneRow(1, { objection: 'true' })]);
  const r = comply(f, { CHANNEL: 'phone' });

  assert.equal(r.status, 3, r.out);
  assert.match(r.stdout, /NOTHING WAS WRITTEN/);
  assert.match(r.stdout, /not permanent/);
  assert.deepEqual(suppressionLines(f.g.root), []);         // honest: nothing written

  // And the recordable path still records: same objection, an email to key it on.
  const g = fixture(t, [clearRow(2, { objection: 'true' })]);
  const withEmail = comply(g, { CHANNEL: 'email' });
  assert.equal(withEmail.status, 3, withEmail.out);
  assert.match(withEmail.stdout, /now on the suppression store/);
  assert.equal(suppressionLines(g.g.root).length, 1);
});
