// tests/contracts/consent-ledger-guard.test.mjs
//
// The operator's consent ledger is not contact data, and an erase must not be
// able to rewrite it.
//
// Found while designing the consent ledger. erase() sweeps the whole gtm/ tree and
// rewrites any line matching the identifier, so without an exclusion, erasing
// one CONTACT could silently alter the OPERATOR's record of what they agreed to
// share. Consent is append-only with tombstones precisely so it cannot be
// rewritten after the fact; a sweep that edits it destroys the property the
// design depends on.
//
// The guard is here ahead of the client that writes the file (that client is
// blocked on its own preconditions). That is deliberate: the failure is silent, and the
// exclusion is the kind of one-liner that is easy to forget once the writer
// lands and hard to notice is missing afterwards.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ERASE_EXCLUDED, CONSENT_FILE, erase, sweepEnrichmentCache } from '../../_lib/pii.mjs';

const tracked = [];
process.on('exit', () => {
  for (const d of tracked) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function project () {
  const root = mkdtempSync(join(tmpdir(), 'consent-guard-'));
  tracked.push(root);
  mkdirSync(join(root, 'gtm', 'enrichment-cache'), { recursive: true });
  return root;
}

// The consent ledger records the OPERATOR's decision. It happens to contain an
// address — the operator's own — which is exactly why a naive sweep would match
// it.
const LEDGER = [
  JSON.stringify({ event: 'granted', scope: 'networked_learnings', payload_schema: 1, at: '2026-08-01T00:00:00.000Z', by: 'dave@acme.com' }),
  JSON.stringify({ event: 'revoked', scope: 'networked_learnings', payload_schema: 1, at: '2026-08-14T00:00:00.000Z', by: 'dave@acme.com' }),
].join('\n') + '\n';

test('the consent ledger is on the erase exclusion list', () => {
  assert.ok(ERASE_EXCLUDED.has(CONSENT_FILE),
    'consent.jsonl must be excluded, or erasing a contact can rewrite the operator record');
});

test('erasing the address in the ledger leaves the ledger byte-identical', () => {
  const root = project();
  const ledger = join(root, 'gtm', CONSENT_FILE);
  writeFileSync(ledger, LEDGER, 'utf8');

  // A contact file that legitimately SHOULD be erased, so the test proves the
  // exclusion is selective rather than proving erase() did nothing at all.
  const contacts = join(root, 'gtm', 'enrichment-cache', 'people.jsonl');
  writeFileSync(contacts,
    JSON.stringify({ email: 'dave@acme.com', source_endpoint: 'email_finder', fetched_at: '2026-08-01T00:00:00.000Z' }) + '\n',
    'utf8');

  erase('dave@acme.com', { root });

  assert.equal(readFileSync(ledger, 'utf8'), LEDGER,
    'the consent ledger must be untouched by an erase of the same address');
  assert.ok(!readFileSync(contacts, 'utf8').includes('dave@acme.com'),
    'the contact record must still be erased — the exclusion is selective, not a global skip');
});

test('the TTL sweep cannot reach the consent ledger either', () => {
  // Not by exclusion but by scoping: sweepEnrichmentCache walks
  // gtm/enrichment-cache/ only, and the ledger lives at the gtm/ root. Pinned
  // here so that widening the sweep's root later fails this test instead of
  // silently eating the ledger.
  const root = project();
  const ledger = join(root, 'gtm', CONSENT_FILE);
  writeFileSync(ledger, LEDGER, 'utf8');

  const report = sweepEnrichmentCache({ root, now: new Date('2099-01-01T00:00:00.000Z') });

  assert.equal(readFileSync(ledger, 'utf8'), LEDGER,
    'a sweep at a date far past every TTL must still not touch the consent ledger');
  assert.equal(report.files_scanned, 0,
    'the sweep should have found nothing to scan outside enrichment-cache/');
});
