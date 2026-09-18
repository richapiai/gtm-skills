// tests/skills/reply-triage/unsubscribe-fail-closed.test.mjs
//
// The unsubscribe path in /reply-triage is a compliance gate, not a category. A
// misclassification there is a complaint and, in several regimes, a fine — so the two
// things that must be true are asserted here rather than reviewed:
//
//   1. an AMBIGUOUS reply is suppressed rather than passed on; and
//   2. the suppression is done by `_lib/suppression.mjs`, the pack's real fail-closed
//      store, and not by anything this skill invented.
//
// Half of this file exercises the real library end to end — an ambiguous reply goes in,
// and the contact provably cannot reach an output list afterwards. The other half holds
// the SKILL.md to that library: it names the exported functions, and if _lib renames
// one, this goes red instead of the skill quietly describing an API that is gone.
//
// The scope asymmetry is tested too, because it runs the OTHER way. Ambiguity about
// WHETHER to suppress resolves to suppress (one lead). Ambiguity about HOW WIDE resolves
// to the narrower scope, because a domain entry removes the whole account.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore, suppressionStatus,
  isSuppressed, filterOutputList, writeOutputList, suppressionPath, sha256,
  SuppressionUnavailableError,
} from '../../../_lib/suppression.mjs';
import { skillBody, sections, section, tmpRoot } from './helpers.mjs';

const body = skillBody();
const flat = (t) => t.replace(/\s+/g, ' ');

/** A workspace with a real, empty-and-honest suppression store. */
function workspace () {
  const root = tmpRoot('reply-triage-store-');
  mkdirSync(join(root, 'gtm'), { recursive: true });
  ensureSuppressionStore(root);
  return root;
}

// Replies that a keyword matcher gets wrong. None of them contains "unsubscribe".
const AMBIGUOUS_REPLIES = [
  'please dont',
  'no thanks — remove',
  'stop.',
  'wrong person, and take me off',
  'нет, удалите меня',
  'not interested. dont contact me again',
];

// --- 1. the real library, end to end ------------------------------------------------

test('an ambiguous reply, suppressed, provably cannot reach an output list', () => {
  const root = workspace();
  const contact = 'dana@acme.example';

  // Before: the contact is contactable.
  const before = filterOutputList([{ email: contact }], { root });
  assert.equal(before.kept.length, 1);
  assert.equal(before.dropped.length, 0);

  // The gate fires on an AMBIGUOUS reply, not a plain one.
  addSuppressionEntry(
    { email: contact, reason: 'unsubscribe', source: 'reply-triage:ambiguous' },
    { root });

  const after = filterOutputList([{ email: contact }], { root });
  assert.equal(after.kept.length, 0, 'an ambiguous reply that was suppressed must not stay contactable');
  assert.equal(after.dropped.length, 1);
  assert.equal(after.dropped[0].status, 'skipped_suppressed');
  assert.equal(after.dropped[0].matched, contact);
});

test('the entry is auditable: reason and source survive the write', () => {
  const root = workspace();
  addSuppressionEntry(
    { email: 'ambiguous@acme.example', reason: 'unsubscribe', source: 'reply-triage:unclear' },
    { root });
  const store = loadSuppressionStore({ root });
  assert.equal(store.count, 1);
  assert.equal(store.entries[0].reason, 'unsubscribe');
  assert.equal(store.entries[0].source, 'reply-triage:unclear');
  assert.ok(store.entries[0].added_at, 'an opt-out with no timestamp cannot be defended later');
});

test('every ambiguous reply in the corpus ends up suppressed under the fail-closed rule', () => {
  const root = workspace();
  const rows = AMBIGUOUS_REPLIES.map((text, i) => ({ email: `p${i}@acme.example`, reply: text }));

  // The rule the SKILL.md states: `yes` and `unclear` both suppress; only a plain `no`
  // proceeds. Modelled here as "nothing in this corpus is a plain no".
  for (const row of rows) {
    addSuppressionEntry({ email: row.email, reason: 'unsubscribe', source: 'reply-triage' }, { root });
  }
  const { kept, dropped } = filterOutputList(rows, { root });
  assert.equal(kept.length, 0, `these replies must not remain contactable: ${AMBIGUOUS_REPLIES.join(' | ')}`);
  assert.equal(dropped.length, rows.length);
});

test('a suppressed contact cannot be written to an output file by any route', () => {
  const root = workspace();
  const out = join(root, 'gtm', 'contactable.jsonl');
  addSuppressionEntry({ email: 'gone@acme.example', reason: 'unsubscribe' }, { root });
  const res = writeOutputList(out, [
    { email: 'gone@acme.example' },
    { email: 'fine@other.example' },
  ], { root });
  assert.equal(res.written, 1);
  assert.equal(res.suppressed, 1);
  const written = readFileSync(out, 'utf8');
  assert.ok(!written.includes('gone@acme.example'));
  assert.ok(written.includes('fine@other.example'));
});

test('with no readable store nothing is triaged at all — fail closed, not fail quiet', () => {
  const root = tmpRoot('reply-triage-nostore-');
  const status = suppressionStatus({ root });
  assert.equal(status.status, 'STOP',
    'a missing store is never read as "nothing suppressed"');

  assert.throws(() => loadSuppressionStore({ root }), SuppressionUnavailableError);
  assert.throws(() => filterOutputList([{ email: 'a@b.example' }], { root }), SuppressionUnavailableError);
  assert.throws(
    () => addSuppressionEntry({ email: 'a@b.example' }, { root }),
    SuppressionUnavailableError,
    'the opt-out cannot even be recorded, which is exactly why the run must stop before it starts');
  assert.ok(!existsSync(suppressionPath(root)));
});

test('a corrupt store stops the run rather than passing the lines it could read', () => {
  const root = workspace();
  const file = suppressionPath(root);
  // One good line, one line we cannot parse.
  addSuppressionEntry({ email: 'good@acme.example' }, { root });
  appendFileSync(file, '{not json\n', 'utf8');
  assert.throws(() => loadSuppressionStore({ root }), /corrupt/,
    'partially reading a suppression store is a fail-open path');
});

test('scope asymmetry: an address entry does not remove the account', () => {
  const root = workspace();
  addSuppressionEntry({ email: 'dana@acme.example', reason: 'unsubscribe' }, { root });
  const store = loadSuppressionStore({ root });
  assert.equal(isSuppressed(store, 'dana@acme.example'), true);
  assert.equal(isSuppressed(store, 'sam@acme.example'), false,
    'suppressing one reply must not silently remove every other contact at the account');
  assert.equal(isSuppressed(store, 'acme.example'), false);
});

test('scope asymmetry: a domain entry removes the whole account, which is why it needs authority', () => {
  const root = workspace();
  addSuppressionEntry({ domain: 'acme.example', reason: 'do_not_contact' }, { root });
  const store = loadSuppressionStore({ root });
  assert.equal(isSuppressed(store, 'sam@acme.example'), true);
  assert.equal(isSuppressed(store, 'anyone@mail.acme.example'), true,
    'parent-domain matching is why a domain entry is a much bigger act than an address one');
});

test('an erased address stays suppressed through its hash', () => {
  const root = workspace();
  addSuppressionEntry({ email_sha256: sha256('dana@acme.example') }, { root });
  const store = loadSuppressionStore({ root });
  assert.equal(isSuppressed(store, 'DANA@Acme.Example'), true,
    'the store normalises before hashing, and a hand-rolled comparison would not');
});

// --- 2. the SKILL.md is held to that library ----------------------------------------

test('the SKILL.md states the fail-closed rule as a rule, not a preference', () => {
  const f = flat(body);
  assert.match(f, /Wrongly suppressing someone costs one lead\. Wrongly not suppressing them costs a complaint\./,
    'the asymmetry that the whole design follows from must be stated');
  const stage = section(/Stage A/i, body);
  const s = flat(stage.text);
  assert.match(s, /`unclear`[\s\S]*?[Ss]uppress/,
    'the ambiguous answer must resolve to suppression');
  assert.match(s, /`unclear` and `yes` do the same thing/i);
  assert.match(s, /skills\.reply_triage\.ambiguous_is_unsubscribe/,
    'the rule is held by a gate key so it cannot be softened into a heuristic later');
  assert.match(s, /Do not build a keyword list/i,
    'a keyword list is the fail-open implementation this rule exists to prevent');
});

test('Stage A runs before Stage B, in the document and in the described order', () => {
  const all = sections(body);
  const a = all.findIndex(s => /Stage A/i.test(s.heading));
  const b = all.findIndex(s => /Stage B/i.test(s.heading));
  assert.ok(a > 0 && b > a, 'the opt-out gate is not a bucket at the end of a classifier');
  assert.match(flat(section(/Stage A/i, body).text), /before it is sorted into anything/i);
  assert.match(flat(section(/Stage B/i, body).text), /Only replies that came back `no` from Stage A/i);
});

test('the suppression write happens before any draft, notification or output list', () => {
  const f = flat(body);
  assert.match(f, /before\*\* any draft is composed|before any draft is composed/i);
  assert.match(f, /crashes after drafting and before suppressing/i,
    'the ordering has to be justified by the failure it prevents, or it will be reordered');
});

test('the skill delegates to the real module and names functions that actually exist', () => {
  const f = flat(body);
  assert.match(f, /_lib\/suppression\.mjs/);
  const lib = { ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore, suppressionStatus, isSuppressed, filterOutputList, writeOutputList };
  for (const name of ['addSuppressionEntry', 'loadSuppressionStore', 'suppressionStatus', 'isSuppressed', 'filterOutputList', 'writeOutputList']) {
    assert.equal(typeof lib[name], 'function', `_lib/suppression.mjs no longer exports ${name}`);
    assert.ok(f.includes(name), `the SKILL.md must name ${name}, so nobody re-implements it`);
  }
});

test('the skill forbids every fail-open path around the store', () => {
  const f = flat(body);
  assert.match(f, /Do not write to `gtm\/suppression\.jsonl` directly/i);
  assert.match(f, /do not keep a second list of opt-outs/i);
  assert.match(f, /do not re-derive "is this address suppressed"/i);
  const boundary = flat(section(/will not do/i, body).text);
  assert.match(boundary, /will not write the suppression store by hand/i);
  assert.match(boundary, /will not run without a readable store/i);
  assert.match(boundary, /will not un-suppress anybody/i);
});

test('an unreadable store is fatal to the whole run, not to one reply', () => {
  const pre = flat(section(/before anything else/i, body).text);
  assert.match(pre, /SUPPRESSION: STOP/);
  assert.match(pre, /stops the whole run/i);
  assert.match(pre, /Do not triage the batch and record the unsubscribes afterwards/i,
    '"afterwards" is exactly where an opt-out gets lost');
});

test('domain-level suppression needs explicit authority, and ambiguity narrows the scope', () => {
  const f = flat(section(/Stage A/i, body).text);
  assert.match(f, /ambiguity resolves to \*\*the narrower scope/i);
  assert.match(f, /skills\.reply_triage\.domain_suppression_requires_explicit_authority/);
  assert.match(f, /nobody here is interested|remove our company/i,
    'the authority claim has to be shown, not described abstractly');
  assert.match(f, /wrong-person reply is not itself an opt-out/i);
});
