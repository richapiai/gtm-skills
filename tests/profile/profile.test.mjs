// tests/profile/profile.test.mjs
//
// THE SELLER PROFILE AND THE STANDING RULES, AND THE ONE DISTINCTION THAT MATTERS.
//
// `absent` and `unreadable` must never collapse into each other. Absent is a legible
// state a new install is genuinely in; unreadable is a STOP. The failure this guards is
// exact: a corrupt preferences.jsonl read as "no rules" silently drops a standing
// "never contact X" — the same shape as a missing suppression store reading as "nothing
// suppressed", which is the defect this pack was built around.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, appendFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

import { trackedTmp } from '../helpers/index.mjs';
import {
  loadProfile, writeProfile, addPreference, loadPreferences, profileStatus,
  profilePath, preferencesPath, REQUIRED, PREFERENCE_SCOPES
} from '../../_lib/profile.mjs';

const root = () => trackedTmp('profile-');
const full = {
  company: 'Acme', website: 'acme.example', what_we_sell: 'a thing',
  wedge: 'the thing is on fire', proof: ['one customer'], tone: 'dry'
};

// ---------------------------------------------------------------------------
// absent is not a stop
// ---------------------------------------------------------------------------

test('a fresh install reads absent, not unreadable, and not ok', () => {
  const r = root();
  const p = loadProfile({ root: r });
  assert.equal(p.status, 'absent');
  assert.deepEqual(p.missing, REQUIRED, 'an absent profile is missing everything required');

  const s = profileStatus({ root: r });
  assert.equal(s.state, 'ABSENT');
  assert.match(s.text, /gtm-onboard/, 'the absent state must name the way out of it');
  assert.match(s.text, /0 credits/, 'and must say it is free, or nobody runs it');
});

test('absent preferences are an empty rule set, which is honest', () => {
  const r = loadPreferences({ root: root() });
  assert.equal(r.status, 'absent');
  assert.deepEqual(r.preferences, []);
});

// ---------------------------------------------------------------------------
// unreadable is a STOP — never "no rules"
// ---------------------------------------------------------------------------

test('a corrupt preferences line STOPS rather than reading as no rules', () => {
  const r = root();
  addPreference({ scope: 'targeting', rule: 'never contact Series A' }, { root: r });
  appendFileSync(preferencesPath(r), '{not json\n');

  const loaded = loadPreferences({ root: r });
  assert.equal(loaded.status, 'unreadable');
  assert.deepEqual(loaded.preferences, [], 'a partial read must not hand back the rules it did parse');
  assert.match(loaded.reason, /line 2/, 'the refusal names the line');
  assert.equal(profileStatus({ root: r }).state, 'STOP');
});

test('a well-formed JSON line that is not a preference also STOPS', () => {
  const r = root();
  mkdirSync(join(r, 'gtm'), { recursive: true });
  writeFileSync(preferencesPath(r), `${JSON.stringify({ scope: 'not-a-scope', rule: 'x' })}\n`);
  assert.equal(loadPreferences({ root: r }).status, 'unreadable');

  writeFileSync(preferencesPath(r), `${JSON.stringify({ scope: 'copy' })}\n`);
  assert.equal(loadPreferences({ root: r }).status, 'unreadable', 'a rule-less line is not a preference');
});

test('invalid YAML is unreadable, not absent', () => {
  const r = root();
  mkdirSync(join(r, 'gtm'), { recursive: true });
  writeFileSync(profilePath(r), 'company: [unclosed\n');
  const p = loadProfile({ root: r });
  assert.equal(p.status, 'unreadable');
  assert.equal(profileStatus({ root: r }).state, 'STOP');
});

test('a YAML scalar or list where a mapping belongs is unreadable', () => {
  for (const body of ['just a string\n', '- a\n- b\n']) {
    const r = root();
    mkdirSync(join(r, 'gtm'), { recursive: true });
    writeFileSync(profilePath(r), body);
    assert.equal(loadProfile({ root: r }).status, 'unreadable', `body ${JSON.stringify(body)}`);
  }
});

// ---------------------------------------------------------------------------
// partial is its own state
// ---------------------------------------------------------------------------

test('a profile missing a required field is PARTIAL, and names what is missing', () => {
  const r = root();
  writeProfile({ company: 'Acme', website: 'acme.example' }, { root: r });
  const p = loadProfile({ root: r });
  assert.equal(p.status, 'ok');
  assert.deepEqual(p.missing, ['what_we_sell', 'wedge']);

  const s = profileStatus({ root: r });
  assert.equal(s.state, 'PARTIAL');
  assert.match(s.text, /what_we_sell/);
});

test('an empty string does not satisfy a required field', () => {
  const r = root();
  writeProfile({ ...full, wedge: '   ' }, { root: r });
  assert.deepEqual(loadProfile({ root: r }).missing, ['wedge']);
});

test('proof is NOT required — a seller with no citable proof is a real state', () => {
  assert.equal(REQUIRED.includes('proof'), false);
  const r = root();
  writeProfile(full, { root: r });
  assert.equal(profileStatus({ root: r }).state, 'OK');
});

// ---------------------------------------------------------------------------
// write behaviour
// ---------------------------------------------------------------------------

test('writeProfile stamps updated and round-trips', () => {
  const r = root();
  writeProfile(full, { root: r, now: new Date('2026-09-18T10:00:00Z') });
  const p = loadProfile({ root: r });
  assert.equal(p.status, 'ok');
  assert.equal(p.profile.updated, '2026-09-18');
  assert.equal(p.profile.company, 'Acme');
  assert.deepEqual(p.profile.proof, ['one customer']);
});

test('a hand-added key survives a rewrite', () => {
  const r = root();
  writeProfile({ ...full, our_own_note: 'keep me' }, { root: r });
  assert.equal(loadProfile({ root: r }).profile.our_own_note, 'keep me');
});

test('writeProfile creates gtm/ when setup has not run', () => {
  const r = root();
  writeProfile(full, { root: r });
  assert.equal(loadProfile({ root: r }).status, 'ok');
});

// ---------------------------------------------------------------------------
// preferences are append-only
// ---------------------------------------------------------------------------

test('preferences append, newest last, and keep the user words verbatim', () => {
  const r = root();
  addPreference({ scope: 'copy', rule: 'never mention pricing in step 1', why: 'kills replies' }, { root: r });
  addPreference({ scope: 'targeting', rule: 'no Series A' }, { root: r });

  const all = loadPreferences({ root: r });
  assert.equal(all.status, 'ok');
  assert.equal(all.preferences.length, 2);
  assert.equal(all.preferences[0].rule, 'never mention pricing in step 1');
  assert.equal(all.preferences[0].why, 'kills replies');
  assert.equal(all.preferences[1].rule, 'no Series A');

  const copyOnly = loadPreferences({ root: r, scope: 'copy' });
  assert.equal(copyOnly.preferences.length, 1);
});

test('a superseding rule is added, never an edit of the old one', () => {
  const r = root();
  addPreference({ scope: 'sequence', rule: 'four steps' }, { root: r });
  addPreference({ scope: 'sequence', rule: 'three steps — four was too many', why: 'supersedes' }, { root: r });
  const all = loadPreferences({ root: r, scope: 'sequence' });
  assert.equal(all.preferences.length, 2, 'the history is the useful part');
});

test('an unknown scope or an empty rule is refused at the door', () => {
  const r = root();
  assert.throws(() => addPreference({ scope: 'vibes', rule: 'x' }, { root: r }), /scope must be one of/);
  assert.throws(() => addPreference({ scope: 'copy', rule: '   ' }, { root: r }), /own words/);
  assert.equal(loadPreferences({ root: r }).status, 'absent', 'a refused write writes nothing');
});

test('every declared scope is actually accepted', () => {
  const r = root();
  for (const scope of PREFERENCE_SCOPES) addPreference({ scope, rule: `rule for ${scope}` }, { root: r });
  assert.equal(loadPreferences({ root: r }).preferences.length, PREFERENCE_SCOPES.length);
});

// ---------------------------------------------------------------------------
// law 7 — both files live inside the tree the sweep walks
// ---------------------------------------------------------------------------

test('both files live under gtm/, so the erase sweep can reach them', () => {
  const r = root();
  assert.equal(profilePath(r), join(r, 'gtm', 'profile.yaml'));
  assert.equal(preferencesPath(r), join(r, 'gtm', 'preferences.jsonl'));
});

// ---------------------------------------------------------------------------
// no network, ever
// ---------------------------------------------------------------------------

test('the module imports nothing that can reach the network', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../_lib/profile.mjs', import.meta.url), 'utf8');
  for (const bad of ['node:http', 'node:https', 'node:net', 'fetch(', 'undici', './client.mjs']) {
    assert.equal(src.includes(bad), false, `profile.mjs must not reference ${bad}`);
  }
});
