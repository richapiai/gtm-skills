// tests/compliance/nested-row-suppression.test.mjs
//
// Law 5: **Fail closed.** A suppressed contact never reaches an output list.
//
// `rowIdentifiers` scanned only TOP-LEVEL string values:
//
//     rowIdentifiers({ email: 'x@evil.com' })             -> ["x@evil.com"]
//     rowIdentifiers({ profile: { email: 'x@evil.com' } }) -> []            <- fail OPEN
//
// and _lib/run.mjs writes nested rows. In `pages` mode `outRows` is raw API JSON from
// `readResultRows`, which unwraps elements[] / results[] / data[] — the shapes
// `people_search`, `lead_search` and `linkedin_company_employees_search` return, all of
// which nest the contact. For a .csv output `scalarsOnly` strips the nested object so
// the address never lands; **for .jsonl it does not.** So
//
//     richapi search people_search --param title=CTO --out gtm/lists/ctos.jsonl
//
// wrote a person who unsubscribed last week, and the run reported `0 suppressed`: law 5
// broken silently, with the artifact that proves enforcement saying it was enforced.
//
// The fix recurses at bounded depth. Recursion fails CLOSED (the buried address is
// found and the row is dropped); refusing the row would only fail loudly, and skipping
// it fails open in silence. skills/crm-export/SKILL.md guards the same hazard in prose
// — prose in one skill does not protect the runtime the other eleven call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpRoot, cleanupTmp, jsonl } from './helpers.mjs';
import { ensureGtmTree } from '../../_lib/pii.mjs';
import {
  rowIdentifiers, filterOutputList, writeOutputList, ensureSuppressionStore, sha256,
} from '../../_lib/suppression.mjs';

test.after(cleanupTmp);

const UNSUB = 'x@evil.com';

function seeded(entries = [{ email: UNSUB, reason: 'unsubscribe' }], prefix = 'compliance-nested-') {
  const root = tmpRoot(prefix);
  ensureGtmTree(root);
  ensureSuppressionStore(root);
  writeFileSync(join(root, 'gtm', 'suppression.jsonl'), entries.length ? jsonl(entries) : '', 'utf8');
  return root;
}

// --- the exact reproduction ------------------------------------------------

test('the audit reproduction: a nested email is an identifier', () => {
  assert.deepEqual(rowIdentifiers({ email: UNSUB }), [UNSUB]);
  assert.deepEqual(rowIdentifiers({ profile: { email: UNSUB } }), [UNSUB],
    'rowIdentifiers returned [] for a nested row — that is the fail-OPEN');
});

// --- the shapes the three search endpoints actually return -----------------

const NESTED_SHAPES = {
  'people_search element': { profile: { email: UNSUB }, headline: 'CTO' },
  'lead_search element': { person: { contact: { work_email: UNSUB } } },
  'linkedin_company_employees_search element': {
    fullName: 'Ada', emails: [{ address: UNSUB, type: 'work' }],
  },
  'array of strings': { emails: [UNSUB] },
  'array of arrays': { contacts: [[{ deep: { email: UNSUB } }]] },
  'unhelpfully named nest': { _raw: { attributes: { 'Zz Custom 7': UNSUB } } },
};

for (const [name, row] of Object.entries(NESTED_SHAPES)) {
  test(`a suppressed contact hidden in a ${name} is found`, () => {
    assert.ok(rowIdentifiers(row).includes(UNSUB),
      `rowIdentifiers missed ${JSON.stringify(row)} — fail OPEN`);
    const root = seeded();
    const { kept, dropped } = filterOutputList([row], { root });
    assert.equal(dropped.length, 1, 'the nested suppressed row was kept');
    assert.equal(dropped[0].matched, UNSUB);
    assert.equal(dropped[0].status, 'skipped_suppressed');
    assert.equal(kept.length, 0);
  });
}

// --- the .jsonl path that actually leaked ----------------------------------

test('a nested suppressed contact never reaches the bytes of a .jsonl output', () => {
  const root = seeded();
  const out = join(root, 'gtm', 'lists', 'ctos.jsonl');
  const res = writeOutputList(out, [
    { profile: { email: UNSUB }, headline: 'CTO' },
    { profile: { email: 'ada@ok.example' }, headline: 'CTO' },
  ], { root });

  assert.equal(res.suppressed, 1, 'the run reported 0 suppressed while writing a suppressed row');
  assert.equal(res.written, 1);
  const bytes = readFileSync(out, 'utf8');
  assert.ok(!bytes.toLowerCase().includes(UNSUB), `the .jsonl leaked the suppressed address:\n${bytes}`);
  assert.ok(bytes.includes('ada@ok.example'));
});

test('domain and hashed suppression reach nested values too', () => {
  const byDomain = seeded([{ domain: 'evil.com' }]);
  assert.equal(filterOutputList([{ profile: { any_field: 'someone@mail.evil.com' } }],
    { root: byDomain }).dropped.length, 1);

  const byHash = seeded([{ email_sha256: sha256(UNSUB) }]);
  assert.equal(filterOutputList([{ profile: { email: UNSUB } }], { root: byHash }).dropped.length, 1);
});

test('a nested key on the field list matches even when the value is not email-shaped', () => {
  // `domain` is a DEFAULT_FIELD. A bare host is DOMAINISH anyway, so use a value that
  // is only reachable through the KEY: a domain with a path is still DOMAINISH, so pick
  // a custom field list instead and prove the key survives the descent.
  const ids = rowIdentifiers({ meta: { ticker: 'ACME' } }, ['ticker']);
  assert.deepEqual(ids, ['ACME'], 'the nested KEY was not matched against the field list');
});

test('an array element inherits its parent key', () => {
  assert.deepEqual(rowIdentifiers({ 'Work Email': ['not-email-shaped'] }), ['not-email-shaped'],
    'an array element must be read under the column it sits in');
});

// --- what must NOT change --------------------------------------------------

test('the top-level behaviour is unchanged', () => {
  assert.deepEqual(rowIdentifiers('ada@acme.com'), ['ada@acme.com']);
  assert.deepEqual(rowIdentifiers(null), []);
  assert.deepEqual(rowIdentifiers(42), []);
  assert.deepEqual(rowIdentifiers({}), []);
  assert.deepEqual(rowIdentifiers({ first_name: 'Ada', email: 'ada@acme.com' }), ['ada@acme.com']);
  // non-strings are still skipped, at every depth
  assert.deepEqual(rowIdentifiers({ n: 1, ok: true, nil: null, d: { n: 2, nil: null } }), []);
  // a free-text note is still not an identifier — EMAILISH/DOMAINISH stay anchored,
  // or every notes column in the world becomes a false positive
  assert.deepEqual(rowIdentifiers({ notes: { sdr: `emailed ${UNSUB} twice` } }), []);
});

test('duplicates collapse across depths', () => {
  assert.deepEqual(rowIdentifiers({ email: UNSUB, profile: { work_email: UNSUB } }), [UNSUB]);
});

// --- the bounds: a pathological payload cannot hang the writer -------------

test('a cyclic row terminates instead of recursing forever', () => {
  const row = { email: UNSUB };
  row.self = row;
  row.list = [row, { profile: row }];
  const t0 = Date.now();
  assert.deepEqual(rowIdentifiers(row), [UNSUB]);
  assert.ok(Date.now() - t0 < 1000, 'the cycle guard did not hold');
});

test('a 10000-deep payload terminates, and quickly', () => {
  let deep = { email: UNSUB };
  for (let i = 0; i < 10000; i += 1) deep = { nest: deep };
  const t0 = Date.now();
  const ids = rowIdentifiers(deep);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `the depth bound did not hold (${ms}ms)`);
  // Past MAX_DEPTH the scan stops. That is the documented trade: the bound exists so a
  // hostile payload cannot hang the writer, and it sits far above any real response.
  assert.deepEqual(ids, []);
});

test('a very wide payload terminates, and quickly', () => {
  const row = {};
  for (let i = 0; i < 200000; i += 1) row['f' + i] = 'v' + i;
  row.email = UNSUB;
  const t0 = Date.now();
  rowIdentifiers(row);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `the node bound did not hold (${ms}ms)`);
});

test('the real nesting depth of a search response is comfortably inside the bound', () => {
  // elements[] -> element -> profile -> contact -> emails[] -> {address}
  // is depth 5 from the row; the bound is 16.
  const row = { profile: { contact: { emails: [{ address: UNSUB }] } } };
  assert.ok(rowIdentifiers(row).includes(UNSUB));
  const root = seeded();
  assert.equal(filterOutputList([row], { root }).dropped.length, 1);
});

test('an address as deep as the live bulk body, inside a delivered response, is still found', () => {
  // Recorded 2026-09-17: addresses sit 8 levels into an enrich_profiles_bulk body, and
  // `richapi call` puts the body under `response` — 9 levels from the row.
  let deep = { email: UNSUB };
  for (let i = 0; i < 8; i += 1) deep = { nest: deep };
  assert.ok(rowIdentifiers({ response: deep }).includes(UNSUB));
});

test('a page as large as a live 50-post feed, with the address at the end, is still found', () => {
  // ~4,900 nodes were measured on one real page; this is four times that.
  const response = { elements: Array.from({ length: 200 }, (_, i) => ({
    id: String(i), text: 'x', author: { name: 'n', urn: 'u', tags: ['a', 'b', 'c'] },
    stats: { likes: i, comments: i, shares: i, views: i }, media: [{ url: 'm' }, { url: 'm' }],
  })) };
  response.elements.at(-1).author.contact = { email: UNSUB };
  assert.ok(rowIdentifiers({ response }).includes(UNSUB));
});
