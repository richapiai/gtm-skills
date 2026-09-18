// PII verify criterion #2: `/comply erase <email|domain>` purges EVERY artifact type
// across the whole gtm/ tree, writes a tombstone, and is idempotent.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRoot, cleanupTmp, write, jsonl, snapshot, filesContaining, DAY, ago, REPO_ROOT } from './helpers.mjs';
import { erase, readTombstones, sha256, makeTargetMatcher, ensureGtmTree } from '../../_lib/pii.mjs';

test.after(cleanupTmp);

const NOW = new Date('2026-08-28T12:00:00.000Z');
const TARGET = 'bob@acme.com';
const KEEP = 'carol@zenith.io';

/** A gtm/ tree holding the target in every artifact type the plan names. */
function seedTree() {
  const root = tmpRoot('compliance-erase-');
  ensureGtmTree(root);

  // lists — csv and jsonl
  write(root, 'gtm/lists/q3-icp.csv',
    'email,first_name,company\n'
    + `${TARGET},Bob,Acme\n`
    + `${KEEP},Carol,Zenith\n`
    + 'bobby@acme.com,Bobby,Acme\n');   // lookalike local part — must survive
  write(root, 'gtm/lists/q3-icp.jsonl', jsonl([
    { email: TARGET, company: 'Acme' },
    { email: KEEP, company: 'Zenith' },
  ]));

  // enrichment-cache — stamped PII rows
  write(root, 'gtm/enrichment-cache/email_verifier.jsonl', jsonl([
    { source_endpoint: 'email_verifier', fetched_at: ago(NOW, DAY), key: TARGET, data: { valid: true } },
    { source_endpoint: 'email_verifier', fetched_at: ago(NOW, DAY), key: KEEP, data: { valid: true } },
  ]));

  // research — markdown prose
  write(root, 'gtm/research/acme.md',
    `# Acme\n\nChampion is Bob (${TARGET}). Reach out after the funding round.\n`);

  // copy — nested json
  write(root, 'gtm/copy/seq-1.json', {
    sequence: 'q3',
    steps: [
      { to: TARGET, subject: 'quick question', body: `Hi Bob — ${TARGET}` },
      { to: KEEP, subject: 'quick question', body: 'Hi Carol' },
    ],
  });

  // org-maps — array of people
  write(root, 'gtm/org-maps/acme.json', [
    { name: 'Bob', email: TARGET, role: 'champion' },
    { name: 'Dave', email: 'dave@acme.com', role: 'economic buyer' },
  ]);

  // deals — a document that IS about the person
  write(root, 'gtm/deals/deal-77.json', { deal_id: 77, contact: TARGET, stage: 'discovery' });
  write(root, 'gtm/deals/deal-88.json', { deal_id: 88, contact: KEEP, stage: 'discovery' });

  // ads exports
  write(root, 'gtm/ads/linkedin-audience.csv', `email\n${TARGET}\n${KEEP}\n`);

  // the run journal
  write(root, 'gtm/runs/run-2026-08-28.jsonl', jsonl([
    { schema_version: 1, run_id: 'r1', row_id: TARGET, hop: 0, endpoint: 'email_verifier', status: 'ok', ts: NOW.toISOString() },
    { schema_version: 1, run_id: 'r1', row_id: KEEP, hop: 0, endpoint: 'email_verifier', status: 'ok', ts: NOW.toISOString() },
  ]));

  // the ledger (no contact fields by contract — swept anyway)
  write(root, 'gtm/api-calls.jsonl', jsonl([
    { schema_version: 1, ts: NOW.toISOString(), endpoint: 'email_verifier', credits_estimated: 1, cost_status: 'actual' },
  ]));

  // suppression store
  write(root, 'gtm/suppression.jsonl', jsonl([
    { schema_version: 1, email: TARGET, reason: 'unsubscribe' },
    { schema_version: 1, email: KEEP, reason: 'unsubscribe' },
  ]));
  return root;
}

test('erase purges the target from EVERY artifact type and leaves everyone else alone', () => {
  const root = seedTree();
  const gtm = join(root, 'gtm');

  const before = filesContaining(gtm, TARGET);
  assert.ok(before.length >= 9, `precondition: target present in ${before.length} artifacts`);

  const r = erase(TARGET, { root, now: NOW });

  assert.deepEqual(filesContaining(gtm, TARGET), [],
    'no file anywhere under gtm/ still contains the address');

  // every artifact type reports as touched
  const touched = new Set(r.files_touched.map(f => f.path));
  for (const p of [
    'lists/q3-icp.csv', 'lists/q3-icp.jsonl', 'enrichment-cache/email_verifier.jsonl',
    'research/acme.md', 'copy/seq-1.json', 'org-maps/acme.json', 'deals/deal-77.json',
    'ads/linkedin-audience.csv', 'runs/run-2026-08-28.jsonl', 'suppression.jsonl',
  ]) assert.ok(touched.has(p), `swept ${p}`);

  // the other contact is untouched
  const keepStill = filesContaining(gtm, KEEP);
  assert.ok(keepStill.includes('lists/q3-icp.csv'));
  assert.ok(keepStill.includes('deals/deal-88.json'));
  assert.ok(keepStill.includes('runs/run-2026-08-28.jsonl'));
  assert.ok(existsSync(join(gtm, 'deals', 'deal-88.json')));

  // a lookalike address must NOT be collateral damage
  assert.match(readFileSync(join(gtm, 'lists', 'q3-icp.csv'), 'utf8'), /bobby@acme\.com/);

  // a document that IS about the person is deleted outright
  assert.equal(existsSync(join(gtm, 'deals', 'deal-77.json')), false);
  assert.equal(r.files_deleted, 1);

  // prose is redacted rather than deleted
  const md = readFileSync(join(gtm, 'research', 'acme.md'), 'utf8');
  assert.match(md, /\[erased\]/);
  assert.match(md, /# Acme/, 'the account research survives; the person is gone');

  // suppression is preserved as a hash: still suppressed, no longer in the clear
  const supp = readFileSync(join(gtm, 'suppression.jsonl'), 'utf8');
  assert.match(supp, new RegExp(sha256(TARGET)));
  assert.doesNotMatch(supp, /bob@acme\.com/);
  assert.match(supp, /carol@zenith\.io/);
});

test('erase writes an auditable tombstone that carries a hash, never the address', () => {
  const root = seedTree();
  const r = erase(TARGET, { root, now: NOW, actor: 'dpo@richapi.ai' });

  const tombs = readTombstones({ root });
  assert.equal(tombs.length, 1);
  const t = tombs[0];
  assert.equal(t.action, 'erase');
  assert.equal(t.target_kind, 'email');
  assert.equal(t.target_sha256, sha256(TARGET));
  assert.equal(t.matched, true);
  assert.equal(t.actor, 'dpo@richapi.ai');
  assert.ok(t.rows_removed > 0);
  assert.ok(t.paths.length > 0);
  assert.equal(t.ts, NOW.toISOString());

  const raw = readFileSync(join(root, 'gtm', 'tombstones.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /bob@acme\.com/, 'the audit trail is not itself a PII store');
  assert.equal(r.tombstone_path, join(root, 'gtm', 'tombstones.jsonl'));
});

test('erase is idempotent: a second run changes no data and records a zero-match tombstone', () => {
  const root = seedTree();
  const gtm = join(root, 'gtm');
  erase(TARGET, { root, now: NOW });
  const afterFirst = snapshot(gtm, ['tombstones.jsonl']);

  const second = erase(TARGET, { root, now: new Date(NOW.getTime() + 60_000) });
  const afterSecond = snapshot(gtm, ['tombstones.jsonl']);

  assert.deepEqual(afterSecond, afterFirst, 'every data file is byte-identical after a repeat erase');
  assert.equal(second.files_touched.length, 0);
  assert.equal(second.rows_removed, 0);
  assert.equal(second.occurrences_redacted, 0);
  assert.equal(second.files_deleted, 0);

  const tombs = readTombstones({ root });
  assert.equal(tombs.length, 2, 'both requests are auditable');
  assert.equal(tombs[0].matched, true);
  assert.equal(tombs[1].matched, false, 'the repeat found nothing left to erase');

  // a third run stays stable too
  erase(TARGET, { root, now: new Date(NOW.getTime() + 120_000) });
  assert.deepEqual(snapshot(gtm, ['tombstones.jsonl']), afterFirst);
});

test('erase by DOMAIN purges every address at that domain and its subdomains', () => {
  const root = tmpRoot('compliance-erase-dom-');
  ensureGtmTree(root);
  write(root, 'gtm/lists/all.csv',
    'email,site\n'
    + 'bob@acme.com,acme.com\n'
    + 'dave@eu.acme.com,eu.acme.com\n'
    + 'eve@notacme.com,notacme.com\n'
    + 'carol@zenith.io,zenith.io\n');
  write(root, 'gtm/research/acme.md', 'Acme (https://www.acme.com) is hiring.\n');

  const r = erase('acme.com', { root, now: NOW });
  const csv = readFileSync(join(root, 'gtm', 'lists', 'all.csv'), 'utf8');
  assert.doesNotMatch(csv, /bob@acme\.com/);
  assert.doesNotMatch(csv, /dave@eu\.acme\.com/);
  assert.match(csv, /eve@notacme\.com/, 'notacme.com is a different domain');
  assert.match(csv, /carol@zenith\.io/);
  assert.match(readFileSync(join(root, 'gtm', 'research', 'acme.md'), 'utf8'), /\[erased\]/);
  assert.equal(r.target_kind, 'domain');
  assert.equal(r.target_sha256, sha256('acme.com'));
});

test('the matcher does not over-erase on token boundaries', () => {
  const m = makeTargetMatcher(TARGET);
  assert.equal(m.test('bob@acme.com'), true);
  assert.equal(m.test('  BOB@ACME.COM  '), true);
  assert.equal(m.test('"bob@acme.com",Acme'), true);
  assert.equal(m.test('xbob@acme.com'), false);
  assert.equal(m.test('bob@acme.common.org'), false);
  const d = makeTargetMatcher('acme.com');
  assert.equal(d.test('https://www.acme.com/careers'), true);
  assert.equal(d.test('sub.acme.com'), true);
  assert.equal(d.test('notacme.com'), false);
  assert.equal(d.test('acme.community'), false);
});

test('erase --dry-run reports without touching anything', () => {
  const root = seedTree();
  const gtm = join(root, 'gtm');
  const before = snapshot(gtm);
  const r = erase(TARGET, { root, now: NOW, dryRun: true });
  assert.ok(r.files_touched.length > 0, 'it still reports what it WOULD touch');
  assert.deepEqual(snapshot(gtm), before, 'nothing written, not even the tombstone');
  assert.equal(readTombstones({ root }).length, 0);
});

test('erase refuses an empty target and survives a missing gtm/ tree', () => {
  const root = tmpRoot('compliance-erase-edge-');
  assert.throws(() => erase('', { root }), /target email or domain is required/);
  assert.throws(() => erase(null, { root }), /target email or domain is required/);
  const r = erase(TARGET, { root, now: NOW });
  assert.equal(r.files_scanned, 0);
  assert.equal(r.tombstone.matched, false);
  assert.ok(existsSync(join(root, 'gtm', 'tombstones.jsonl')), 'the request is still auditable');
});

test('the CLI drives erase: node _lib/pii.mjs erase <target> --root DIR', () => {
  const root = seedTree();
  // `--confirm-sweep` is new and this invocation now needs it: the CLI enforces
  // `gates.yaml:skills.comply.erase_confirm_fraction` itself, and this fixture is a
  // deliberately maximal tree in which the target sits in nearly every artifact —
  // the sweep measures 9 of 18 erasable rows, 50%, five times the 10% ceiling. Every
  // assertion below is unchanged; only the second confirmation is supplied. The
  // refusal path it now takes without the flag is asserted in
  // tests/compliance/erase-blast-radius.test.mjs.
  const out = execFileSync(process.execPath,
    [join(REPO_ROOT, '_lib', 'pii.mjs'), 'erase', TARGET, '--root', root, '--confirm-sweep'],
    { encoding: 'utf8' });
  assert.match(out, /erase email sha256:/);
  assert.match(out, /lists\/q3-icp\.csv: rows_removed/);
  assert.deepEqual(filesContaining(join(root, 'gtm'), TARGET), []);
  assert.equal(readTombstones({ root }).length, 1);
});
