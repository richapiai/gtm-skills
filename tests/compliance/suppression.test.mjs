// Law 5 / gap #4: unproven fail-closed suppression.
// A suppressed contact NEVER reaches an output list, and an unreadable or missing
// store is STOP — never "nothing suppressed".

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp, write, jsonl } from './helpers.mjs';
import { ensureGtmTree, sha256 } from '../../_lib/pii.mjs';
import {
  loadSuppressionStore, suppressionStatus, isSuppressed, filterOutputList,
  writeOutputList, addSuppressionEntry, ensureSuppressionStore,
  SuppressionUnavailableError,
} from '../../_lib/suppression.mjs';

test.after(cleanupTmp);

const ROWS = [
  { email: 'bob@acme.com', first_name: 'Bob' },
  { email: 'carol@zenith.io', first_name: 'Carol' },
  { email: 'dave@blocked.example', first_name: 'Dave' },
  { email: 'erin@sub.blocked.example', first_name: 'Erin' },
];

function seeded(entries) {
  const root = tmpRoot('compliance-supp-');
  ensureGtmTree(root);
  writeFileSync(join(root, 'gtm', 'suppression.jsonl'), entries.length ? jsonl(entries) : '', 'utf8');
  return root;
}

// --- fail closed -----------------------------------------------------------

test('a MISSING store is STOP, not "nothing suppressed"', () => {
  const root = tmpRoot('compliance-supp-missing-');
  assert.throws(() => loadSuppressionStore({ root }), SuppressionUnavailableError);
  const st = suppressionStatus({ root });
  assert.equal(st.status, 'STOP');
  assert.match(st.reason, /missing/);
  // and nothing can be written through the filter
  assert.throws(() => filterOutputList(ROWS, { root }), SuppressionUnavailableError);
  const out = join(root, 'gtm', 'lists', 'out.jsonl');
  assert.throws(() => writeOutputList(out, ROWS, { root }), SuppressionUnavailableError);
  assert.equal(existsSync(out), false, 'no output list exists after a fail-closed stop');
});

test('a CORRUPT store line is STOP — a partly-read store is not a store', () => {
  const root = seeded([{ email: 'bob@acme.com' }]);
  const p = join(root, 'gtm', 'suppression.jsonl');
  writeFileSync(p, '{"email":"bob@acme.com"}\n{ truncated mid-write\n', 'utf8');
  let caught = null;
  try { loadSuppressionStore({ root }); } catch (e) { caught = e; }
  assert.ok(caught instanceof SuppressionUnavailableError);
  assert.match(caught.message, /corrupt/);
  assert.equal(caught.verdict, 'STOP');
  assert.equal(suppressionStatus({ root }).status, 'STOP');
});

test('an UNRECOGNISED entry shape is STOP, not silently skipped', () => {
  const root = seeded([{ note: 'we should suppress bob at some point' }]);
  assert.throws(() => loadSuppressionStore({ root }), /unrecognised entry/);
});

test('an UNREADABLE store is STOP', { skip: process.getuid && process.getuid() === 0 ? 'running as root' : false }, () => {
  const root = seeded([{ email: 'bob@acme.com' }]);
  const p = join(root, 'gtm', 'suppression.jsonl');
  chmodSync(p, 0o000);
  try {
    const st = suppressionStatus({ root });
    assert.equal(st.status, 'STOP');
    assert.match(st.reason, /unreadable/);
  } finally { chmodSync(p, 0o600); }
});

test('an EMPTY store is valid and honest: zero entries, everything passes', () => {
  const root = seeded([]);
  const st = suppressionStatus({ root });
  assert.equal(st.status, 'OK');
  assert.equal(st.count, 0);
  const { kept, dropped } = filterOutputList(ROWS, { root });
  assert.equal(kept.length, 4);
  assert.equal(dropped.length, 0);
});

// --- the actual law --------------------------------------------------------

test('a suppressed contact NEVER reaches an output list (jsonl and csv)', () => {
  const root = seeded([
    { email: 'bob@acme.com', reason: 'unsubscribe' },
    { domain: 'blocked.example', reason: 'do_not_contact' },
  ]);

  const outJsonl = join(root, 'gtm', 'lists', 'q3.jsonl');
  const r1 = writeOutputList(outJsonl, ROWS, { root });
  assert.equal(r1.written, 1);
  assert.equal(r1.suppressed, 3, 'the email, the domain, and the subdomain');
  const body = readFileSync(outJsonl, 'utf8');
  assert.doesNotMatch(body, /bob@acme\.com/);
  assert.doesNotMatch(body, /blocked\.example/);
  assert.match(body, /carol@zenith\.io/);

  const outCsv = join(root, 'gtm', 'lists', 'q3.csv');
  const r2 = writeOutputList(outCsv, ROWS, { root, columns: ['email', 'first_name'] });
  const csv = readFileSync(outCsv, 'utf8');
  assert.equal(csv, 'email,first_name\ncarol@zenith.io,Carol\n');
  assert.equal(r2.suppressed, 3);

  // dropped rows carry the journal's status value
  assert.deepEqual([...new Set(r2.dropped.map(d => d.status))], ['skipped_suppressed']);
});

test('suppression matches on email, domain, subdomain, case and whitespace', () => {
  const root = seeded([
    { email: '  BOB@Acme.COM  ' },
    { domain: 'https://www.blocked.example/path' },
  ]);
  const store = loadSuppressionStore({ root });
  assert.equal(isSuppressed(store, 'bob@acme.com'), true);
  assert.equal(isSuppressed(store, 'BOB@ACME.COM'), true);
  assert.equal(isSuppressed(store, 'bobby@acme.com'), false);
  assert.equal(isSuppressed(store, 'dave@blocked.example'), true);
  assert.equal(isSuppressed(store, 'erin@sub.blocked.example'), true);
  assert.equal(isSuppressed(store, 'sub.blocked.example'), true);
  assert.equal(isSuppressed(store, 'notblocked.example'), false);
  assert.equal(isSuppressed(store, ''), false);
});

test('a HASHED entry still suppresses — erasure does not un-suppress anyone', () => {
  const root = seeded([{ email_sha256: sha256('bob@acme.com') }, { domain_sha256: sha256('blocked.example') }]);
  const store = loadSuppressionStore({ root });
  assert.equal(store.count, 2);
  assert.equal(isSuppressed(store, 'bob@acme.com'), true);
  assert.equal(isSuppressed(store, 'dave@blocked.example'), true);
  assert.equal(isSuppressed(store, 'carol@zenith.io'), false);

  const out = join(root, 'gtm', 'lists', 'q3.jsonl');
  writeOutputList(out, ROWS, { root });
  assert.doesNotMatch(readFileSync(out, 'utf8'), /bob@acme\.com/);
});

test('non-email row fields (company_domain, website) are checked too', () => {
  const root = seeded([{ domain: 'blocked.example' }]);
  const rows = [
    { email: 'x@ok.test', company_domain: 'blocked.example' },
    { email: 'y@ok.test', website: 'https://www.blocked.example' },
    { email: 'z@ok.test', company_domain: 'fine.test' },
  ];
  const { kept, dropped } = filterOutputList(rows, { root });
  assert.equal(kept.length, 1);
  assert.equal(dropped.length, 2);
  assert.equal(kept[0].email, 'z@ok.test');
});

test('isSuppressed refuses to answer without a loaded store', () => {
  assert.throws(() => isSuppressed(null, 'bob@acme.com'), SuppressionUnavailableError);
  assert.throws(() => isSuppressed({}, 'bob@acme.com'), SuppressionUnavailableError);
});

test('addSuppressionEntry normalises, and refuses when the store does not exist', () => {
  const root = seeded([]);
  addSuppressionEntry('  BOB@Acme.com ', { root });
  addSuppressionEntry({ domain: 'https://www.Blocked.Example/x', reason: 'complaint' }, { root });
  const store = loadSuppressionStore({ root });
  assert.equal(store.count, 2);
  assert.ok(store.emails.has('bob@acme.com'));
  assert.ok(store.domains.has('blocked.example'));

  const bare = tmpRoot('compliance-supp-bare-');
  assert.throws(() => addSuppressionEntry('a@b.com', { root: bare }), SuppressionUnavailableError);
});

test('ensureSuppressionStore creates an empty store and never clobbers an existing one', () => {
  const root = tmpRoot('compliance-supp-ensure-');
  const p = ensureSuppressionStore(root);
  assert.equal(readFileSync(p, 'utf8'), '');
  addSuppressionEntry('a@b.com', { root });
  ensureSuppressionStore(root);
  assert.equal(loadSuppressionStore({ root }).count, 1);
});
