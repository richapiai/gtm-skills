// tests/skills/ads-audience/audience-file.test.mjs
//
// The audience file is PII leaving the pack (law 7), so what it contains is a
// correctness question, not a formatting one. Two things are asserted here and both of
// them are laws rather than preferences:
//
//   1. A suppressed contact never reaches an audience file (law 5). Not filtered
//      afterwards, not flagged — absent, because the only writer refuses to emit it.
//   2. The file carries the digest and nothing else. Every excluded field named in the
//      skill's own rules table is checked against the bytes on disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { ensureSuppressionStore, addSuppressionEntry, sha256 } from '../../../_lib/suppression.mjs';
import { loadAudienceRules, planAudience, buildAudience, BUILD } from './harness.mjs';
import { tmpRoot } from './helpers.mjs';

const RULES = loadAudienceRules();
const GATES = loadGates();
const FLOOR = gateValue(GATES, 'audience_minimums.linkedin');

function richRows (n) {
  return Array.from({ length: n }, (_, i) => ({
    first_name: `First${i}`,
    last_name: `Last${i}`,
    full_name: `First${i} Last${i}`,
    job_title: 'VP Engineering',
    seniority: 'vp',
    company: 'Acme Corporation',
    company_domain: 'acme.example',
    phone: '+44 20 7946 0000',
    linkedin_url: `https://linkedin.example/in/first${i}`,
    notes: 'met at the conference',
    email: `first${i}@acme.example`,
  }));
}

function build (rows, { root, file, platform = 'linkedin' } = {}) {
  const plan = planAudience({ rows, platform, gates: GATES, root, rules: RULES });
  assert.equal(plan.decision, BUILD, plan.reason);
  return buildAudience({ plan, file, root, gates: GATES, rules: RULES, call: () => null });
}

test('a suppressed contact never reaches the audience file, in any casing', () => {
  const root = tmpRoot('ads-file-sup-');
  ensureSuppressionStore(root);
  addSuppressionEntry({ email: 'first3@acme.example', reason: 'unsubscribed' }, { root });

  const rows = richRows(FLOOR + 5);
  rows.push({ email: 'FIRST3@ACME.EXAMPLE', company_domain: 'acme.example', first_name: 'Shouty' });

  const file = join(root, 'gtm', 'audiences', 'q3.linkedin.csv');
  const res = build(rows, { root, file });

  const body = readFileSync(file, 'utf8');
  const banned = sha256('first3@acme.example');
  assert.ok(!body.includes(banned), 'the suppressed contact reached the audience as a digest');
  assert.ok(!body.toLowerCase().includes('first3@acme.example'), 'plaintext leak');
  assert.equal(res.written, rows.length - 2, 'both casings of the suppressed address were dropped');
});

test('a domain-level suppression removes every contact at that domain', () => {
  const root = tmpRoot('ads-file-dom-');
  ensureSuppressionStore(root);
  addSuppressionEntry({ domain: 'blocked.example', reason: 'erasure request' }, { root });

  const rows = [
    ...richRows(FLOOR),
    { email: 'a@blocked.example', company_domain: 'blocked.example' },
    { email: 'b@blocked.example', company_domain: 'blocked.example' },
  ];
  const file = join(root, 'gtm', 'audiences', 'dom.linkedin.csv');
  const res = build(rows, { root, file });

  const body = readFileSync(file, 'utf8');
  for (const e of ['a@blocked.example', 'b@blocked.example']) {
    assert.ok(!body.includes(sha256(e)), `${e} reached the audience`);
  }
  assert.equal(res.written, FLOOR);
});

test('the file carries the digest column and nothing else', () => {
  const root = tmpRoot('ads-file-cols-');
  ensureSuppressionStore(root);
  const rows = richRows(FLOOR);
  const file = join(root, 'gtm', 'audiences', 'cols.linkedin.csv');
  build(rows, { root, file });

  const body = readFileSync(file, 'utf8');
  const header = body.split('\n')[0];
  assert.deepEqual(header.split(','), RULES.file.columns);
  assert.deepEqual(RULES.file.columns, ['sha256_email']);

  // Every field the rules table excludes, checked against the actual columns.
  // `sha256_email` legitimately contains the substring `email`, so this compares
  // whole column names — a substring test here would pass or fail for the wrong reason.
  const cols = header.split(',');
  for (const field of RULES.excluded_fields) {
    assert.ok(!cols.includes(field), `excluded field \`${field}\` is a column in the audience file`);
  }
  assert.ok(!body.includes('@'), 'no plaintext address may appear in an audience file');
  for (const leak of ['Acme Corporation', 'VP Engineering', '+44 20 7946 0000', 'linkedin.example', 'conference']) {
    assert.ok(!body.includes(leak), `\`${leak}\` leaked into the audience file`);
  }

  // And the digest really is the digest of the normalised address.
  assert.ok(body.includes(sha256('first0@acme.example')));
});

test('the digest is computed on the normalised address, so case is not a duplicate', () => {
  const root = tmpRoot('ads-file-norm-');
  ensureSuppressionStore(root);
  const rows = richRows(FLOOR);
  rows[0].email = '  First0@Acme.Example  ';
  const file = join(root, 'gtm', 'audiences', 'norm.linkedin.csv');
  build(rows, { root, file });
  assert.ok(readFileSync(file, 'utf8').includes(sha256('first0@acme.example')));
});

test('the manifest records provenance and carries no identifiers', () => {
  const root = tmpRoot('ads-file-man-');
  ensureSuppressionStore(root);
  addSuppressionEntry({ email: 'first1@acme.example', reason: 'unsubscribed' }, { root });
  const rows = [...richRows(FLOOR + 1), { email: 'sales@acme.example', company_domain: 'acme.example' }];
  const file = join(root, 'gtm', 'audiences', 'man.linkedin.csv');
  const res = build(rows, { root, file });

  assert.ok(existsSync(res.manifest));
  const manifest = JSON.parse(readFileSync(res.manifest, 'utf8'));

  for (const field of RULES.manifest_fields) {
    assert.ok(Object.prototype.hasOwnProperty.call(manifest, field), `manifest is missing ${field}`);
  }
  assert.equal(manifest.platform, 'linkedin');
  assert.equal(manifest.floor_gate_key, 'audience_minimums.linkedin');
  assert.equal(manifest.floor_value, FLOOR);
  assert.equal(manifest.hash_algorithm, 'sha256');
  assert.equal(manifest.role_address_count, 1, 'the role address is recorded, not silently vanished');
  assert.equal(manifest.suppressed_count, 1);

  // No identifier of any kind, and that is asserted on the serialised bytes.
  assert.equal(RULES.manifest_carries_identifiers, false);
  const raw = readFileSync(res.manifest, 'utf8');
  assert.ok(!raw.includes('@'), 'the manifest must carry no address');
  assert.ok(!raw.includes('First0'), 'the manifest must carry no name');
  assert.ok(!raw.includes(sha256('first0@acme.example')), 'the manifest must carry no digest of a person either');
});

test('the manifest binds the audience to the source list, so it cannot outlive it', () => {
  const root = tmpRoot('ads-file-hash-');
  ensureSuppressionStore(root);
  const rows = richRows(FLOOR);
  const a = build(rows, { root, file: join(root, 'a.csv') });
  const b = build(rows, { root, file: join(root, 'b.csv') });
  assert.equal(a.manifest_body.source_list_hash, b.manifest_body.source_list_hash);

  const c = build([...rows, { email: 'extra@acme.example', company_domain: 'acme.example' }],
    { root, file: join(root, 'c.csv') });
  assert.notEqual(c.manifest_body.source_list_hash, a.manifest_body.source_list_hash,
    'a changed list must produce a changed hash, or the binding is decorative');
});

test('role addresses are dropped, because a shared inbox can never match a person', () => {
  const root = tmpRoot('ads-file-role-');
  ensureSuppressionStore(root);
  const roles = ['info', 'sales', 'support', 'hello', 'admin', 'billing', 'noreply']
    .map(l => ({ email: `${l}@acme.example`, company_domain: 'acme.example' }));
  const rows = [...richRows(FLOOR), ...roles];
  const file = join(root, 'gtm', 'audiences', 'role.linkedin.csv');
  const res = build(rows, { root, file });

  const body = readFileSync(file, 'utf8');
  for (const r of roles) assert.ok(!body.includes(sha256(r.email)), `${r.email} reached the audience`);
  assert.equal(res.written, FLOOR);
  assert.equal(RULES.classifier.role_addresses_can_match, false);
});
