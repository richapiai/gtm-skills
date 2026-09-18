// tests/skills/comply/gate.test.mjs — the four properties /comply cannot ship without.
//
//   1. an unknown jurisdiction fails closed
//   2. erasure requires an explicit confirmation      (see ./erase.test.mjs)
//   3. an over-threshold sweep asks first             (see ./erase.test.mjs)
//   4. a suppressed contact cannot reach an output
//
// Plus the hygiene that keeps the skill honest between edits: it cites gate keys
// instead of typing numbers, and it delegates deletion instead of re-implementing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeGtmTree } from '../../helpers/index.mjs';
import {
  ensureSuppressionStore, addSuppressionEntry, loadSuppressionStore, writeOutputList,
  SuppressionUnavailableError,
} from '../../../_lib/suppression.mjs';
import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';
import {
  loadComplyRules, checkRow, screenList, SKILL_PATH, ALLOW, STOP, NULL_ENUM, NOT_FOUND,
} from './harness.mjs';

const RULES = loadComplyRules();
const GATES = loadGates();
const NOW = new Date('2026-08-28T12:00:00Z');
const SKILL = fs.readFileSync(SKILL_PATH, 'utf8');

function tree (t, entries = []) {
  const g = makeGtmTree({ prefix: 'comply-gate-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  for (const e of entries) addSuppressionEntry(e, { root: g.root });
  return g;
}

// --- 1. unknown jurisdiction fails closed -----------------------------------

test('an unknown jurisdiction fails closed, and says which null it is', (t) => {
  const g = tree(t);
  const store = loadSuppressionStore({ root: g.root });
  const v = checkRow({ email: 'who@somewhere.example', unsubscribe_mechanism: true, data_source: 'x' },
    { rules: RULES, store, now: NOW });
  assert.equal(v.verdict, STOP);
  assert.equal(v.jurisdiction, NOT_FOUND);
  assert.ok(NULL_ENUM.includes(v.jurisdiction));
  assert.equal(v.basis, NOT_FOUND);
});

test('a run whose jurisdiction is unknown stops the row, it does not drop it silently', (t) => {
  const g = tree(t);
  const { cleared, refused } = screenList([
    { email: 'a@somewhere.example' },
    {
      email: 'b@acme-eu.example', subject_country: 'DE', lawful_basis: 'legitimate_interest',
      lia_record_id: 'L1', data_source: 'team page', unsubscribe_mechanism: true,
    },
  ], { root: g.root, rules: RULES, now: NOW });
  assert.equal(cleared.length, 1);
  assert.equal(refused.length, 1);
  // The refusal is reportable: it carries the reason, so the user can be told which
  // rows were refused and why rather than seeing a short list and no explanation.
  assert.deepEqual(refused[0].verdict.reasons, ['unknown_jurisdiction']);
});

// --- 4. a suppressed contact cannot reach an output -------------------------

test('a suppressed contact cannot reach an output list', (t) => {
  const g = tree(t, [{ email: 'no@x.example', reason: 'unsubscribed' },
                     { domain: 'blocked.example', reason: 'do_not_contact' }]);
  const file = path.join(g.root, 'gtm', 'lists', 'out.csv');
  const res = writeOutputList(file, [
    { email: 'ok@x.example' },
    { email: 'no@x.example' },
    { email: 'NO@X.EXAMPLE' },
    { email: 'anyone@mail.blocked.example' },   // subdomain of a blocked domain
    { 'Work Email': 'no@x.example' },           // a CRM's spelling of the column
  ], { root: g.root });

  assert.equal(res.written, 1);
  assert.equal(res.suppressed, 4);
  const out = fs.readFileSync(file, 'utf8').toLowerCase();
  assert.ok(!out.includes('no@x.example'));
  assert.ok(!out.includes('blocked.example'));
});

test('the gate refuses to answer at all when the suppression store cannot be read', (t) => {
  const g = makeGtmTree({ prefix: 'comply-nostore-' });
  t.after(() => g.cleanup());
  // Missing store.
  assert.throws(() => screenList([{ email: 'a@x.example' }], { root: g.root, rules: RULES }),
    (e) => e instanceof SuppressionUnavailableError);
  // Present but corrupt is the same answer: a check we could not finish is not a
  // passing check, and half a store is worse than none.
  ensureSuppressionStore(g.root);
  fs.appendFileSync(path.join(g.root, 'gtm', 'suppression.jsonl'), '{"email":"a@x.example"\n');
  assert.throws(() => screenList([{ email: 'a@x.example' }], { root: g.root, rules: RULES }),
    (e) => e instanceof SuppressionUnavailableError);
});

test('a cleared row and a suppressed row differ only in the store', (t) => {
  const clear = {
    email: 'pat@maple.example', subject_country: 'CA', consent_kind: 'express',
    consent_record_id: 'C-1', consent_timestamp: '2026-02-01T00:00:00Z',
    unsubscribe_mechanism: true, data_source: 'signup',
  };
  const open = tree(t);
  assert.equal(screenList([clear], { root: open.root, rules: RULES, now: NOW }).cleared.length, 1);

  const closed = tree(t, [{ email: 'pat@maple.example', reason: 'unsubscribe' }]);
  const res = screenList([clear], { root: closed.root, rules: RULES, now: NOW });
  assert.equal(res.cleared.length, 0);
  assert.equal(res.refused[0].verdict.verdict, STOP);
});

// --- retention -------------------------------------------------------------

test('retention is cited by gate key, never typed', () => {
  // Every TTL the skill mentions resolves against the real gates.yaml…
  const cited = [...SKILL.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length > 0);
  for (const key of cited) assert.ok(hasGate(GATES, key), `skills/comply cites ${key}, which does not resolve`);

  // …and the four retention classes plus the never-cached endpoint are all named,
  // so a class added to gates.yaml and forgotten here is visible.
  for (const key of ['cache_ttl.classes.firmographics', 'cache_ttl.classes.funding_tech',
                     'cache_ttl.classes.email_verification', 'cache_ttl.classes.posts_activity',
                     'cache_ttl.classes.unknown', 'cache_ttl.endpoints.ai_enrich']) {
    assert.ok(cited.includes(key), `skills/comply never cites gates.yaml:${key}`);
  }
});

test('the skill carries no hand-typed policy number', () => {
  // Law 1, run with the real scanner. Statutory periods are exempt on their own
  // line; a TTL, a credit cost or a percentage is not, wherever it appears.
  assert.deepEqual(scanForBareNumbers(SKILL, { file: 'skills/comply/SKILL.md' }), []);
});

// --- delegation ------------------------------------------------------------

test('the skill delegates deletion and suppression instead of re-implementing them', () => {
  assert.match(SKILL, /_lib\/pii\.mjs/, 'the skill must name the deletion engine it calls');
  assert.match(SKILL, /_lib\/suppression\.mjs/, 'the skill must name the suppression engine it calls');
  assert.match(SKILL, /writeOutputList/, 'the skill must point at the one enforcement point');

  // A hand-rolled deletion in a compliance skill is the failure mode this whole
  // file exists to prevent: it would bypass the record-aware CSV rewrite, the
  // suppression downgrade and the tombstone in one go.
  for (const forbidden of [/\brm\s+-rf\b/, /\bunlinkSync\b/, /\brmSync\b/,
                           /\bsplit\(['"]\\n['"]\)/, /\bfind\s+gtm\b/]) {
    assert.ok(!forbidden.test(SKILL), `skills/comply hand-rolls deletion: ${forbidden}`);
  }
});

test('the skill still satisfies the shape rules it has to satisfy', () => {
  const headings = [...SKILL.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing ## Related');
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  assert.match(SKILL, /richapi-skills-preflight/, 'missing the preflight preamble');
  for (const rel of [...SKILL.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1])) {
    assert.ok(fs.existsSync(path.resolve(path.dirname(SKILL_PATH), rel)), `broken link: ${rel}`);
  }
  // It spends nothing, and that is a property worth pinning: a compliance gate that
  // makes a paid call has a reason to be skipped.
  assert.ok(!/`[a-z_][a-z0-9_]{3,}\(/.test(SKILL), 'the gate must invoke no endpoint');
});

test('the gate table is the only one, and the harness reads it from the shipped skill', () => {
  assert.equal((SKILL.match(/^```yaml[ \t]+comply-rules[ \t]*$/gm) || []).length, 1);
  assert.equal(SKILL_PATH, path.join(path.resolve(path.dirname(SKILL_PATH), '..', '..'), 'skills', 'comply', 'SKILL.md'));
  assert.deepEqual(Object.keys(RULES.jurisdictions).sort(), ['can_spam', 'casl', 'ccpa', 'gdpr']);
});
