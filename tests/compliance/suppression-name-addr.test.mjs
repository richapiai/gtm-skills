// An opt-out arrives as a `From:` header, and a `From:` header is usually the
// RFC 5322 name-addr form. Law 5 says a suppressed contact never reaches an output
// list; that only holds if the form the store LEARNS and the form the list CARRIES
// normalise to the same key.
//
// Before the fix they did not. `/reply-triage` hands `addSuppressionEntry` whatever
// the reply carried, `normEmail` was `trim().toLowerCase()`, and the store learned
// `"jane doe" <jane@acme.com>` while every list on disk carries `jane@acme.com`.
// `isSuppressed` answered false and the person who unsubscribed was contacted again.
//
// The failure mode is nastier than a plain miss: the stored form matches ITSELF, so
// a round-trip test over one string passes. Only the cross-form pairing — header in,
// bare address out — exposes it. That pairing is what this file tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  addSuppressionEntry, loadSuppressionStore, isSuppressed,
} from '../../_lib/suppression.mjs';

function freshStore (seed = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-nameaddr-'));
  fs.mkdirSync(path.join(root, 'gtm'), { recursive: true });
  fs.writeFileSync(path.join(root, 'gtm', 'suppression.jsonl'), seed, 'utf8');
  return root;
}

test('an opt-out written as a From: header suppresses the bare address', () => {
  const root = freshStore();
  addSuppressionEntry('"Jane Doe" <jane@acme.com>', { root });
  const store = loadSuppressionStore({ root });
  assert.equal(
    isSuppressed(store, 'jane@acme.com'), true,
    'Jane replied "unsubscribe" from a mail client that sends a display name. Her '
    + 'address is on the store. The list carries the bare form. If this is false she '
    + 'is emailed again, which is the exact thing law 5 exists to prevent.',
  );
});

test('a store that already holds a wrapped entry heals on load, without migration', () => {
  // The fix lives in normEmail, which the LOAD path shares with the write path — so
  // stores written before the fix start matching correctly the next time they load.
  const root = freshStore(JSON.stringify({ email: '"Jane Doe" <jane@acme.com>' }) + '\n');
  assert.equal(isSuppressed(loadSuppressionStore({ root }), 'jane@acme.com'), true);
});

test('every spelling of one address resolves to one key', () => {
  const root = freshStore();
  addSuppressionEntry('jane@acme.com', { root });
  const store = loadSuppressionStore({ root });
  for (const form of [
    'jane@acme.com',
    'JANE@ACME.COM',
    '  jane@acme.com  ',
    '<jane@acme.com>',
    'Jane Doe <jane@acme.com>',
    '"Jane Doe" <JANE@acme.com>',
    '"Doe, Jane" <jane@acme.com>',
  ]) {
    assert.equal(isSuppressed(store, form), true, `not suppressed: ${form}`);
  }
});

test('unwrapping does not over-match', () => {
  const root = freshStore();
  addSuppressionEntry('jane@acme.com', { root });
  const store = loadSuppressionStore({ root });

  assert.equal(
    isSuppressed(store, 'bob@acme.com'), false,
    'a colleague at the same domain is not suppressed by one person opting out',
  );
  assert.equal(
    isSuppressed(store, '"jane@acme.com" <bob@evil.com>'), false,
    'the addr-spec decides, not the display name — otherwise anyone could suppress '
    + 'themselves past a check by naming a suppressed address in their display name, '
    + 'or (worse) get someone else\'s mail dropped by putting their address in it',
  );
});

test('a wrapped domain entry is still read as a domain', () => {
  // normEmail only unwraps when the bracketed span is an address; a domain entry
  // must not be silently reinterpreted.
  const root = freshStore(JSON.stringify({ domain: 'acme.com' }) + '\n');
  const store = loadSuppressionStore({ root });
  assert.equal(isSuppressed(store, 'anyone@acme.com'), true);
  assert.equal(isSuppressed(store, '"Any One" <anyone@acme.com>'), true);
});
