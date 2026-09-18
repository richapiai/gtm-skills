// tests/contracts/profile-readers.test.mjs
//
// AN ARTIFACT NOTHING READS IS A FILE, NOT A FEATURE.
//
// `gtm/profile.yaml` exists because /personalize was structurally incomplete without it:
// it refuses claims it cannot source, and nothing on disk sourced the offer. That defect
// comes straight back the moment a skill stops reading the profile — and it comes back
// silently, because a draft written from an invented offer looks exactly like a draft
// written from a real one.
//
// So the wiring is pinned. Each reader below must name the artifact it depends on AND
// handle the unreadable case, because "unreadable read as absent" is the specific way
// this fails dangerously: a profile whose `never_claim` list cannot be parsed is one
// whose prohibitions are about to be violated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (skill) => readFileSync(join(ROOT, 'skills', skill, 'SKILL.md'), 'utf8');

/** skill -> what it must demonstrably consume. */
const READERS = {
  personalize:       ['gtm/profile.yaml', 'never_claim'],
  'sequence-builder': ['gtm/profile.yaml', 'preferences.jsonl'],
  'outreach-expert':  ['gtm/profile.yaml', 'preferences.jsonl'],
  inbound:            ['gtm/profile.yaml', 'routing'],
  'reply-triage':     ['gtm/profile.yaml', 'routing'],
};

for (const [skill, needles] of Object.entries(READERS)) {
  test(`/${skill} reads the seller profile`, () => {
    const body = read(skill);
    for (const n of needles) {
      assert.ok(body.includes(n), `${skill}/SKILL.md must reference ${n}`);
    }
  });

  test(`/${skill} treats an unreadable profile as a STOP, not as absent`, () => {
    const body = read(skill);
    assert.match(body, /unreadable/i, `${skill} must name the unreadable state`);
    assert.match(body, /STOP/, `${skill} must say what happens on unreadable — silently continuing is the defect`);
  });
}

test('/personalize refuses to infer the offer when the profile is absent', () => {
  const body = read('personalize');
  // The whole point: absent must route to ASK, never to INFER.
  assert.match(body, /Do not infer it/i,
    '/personalize must forbid inferring the offer — inventing it is the defect the profile exists to fix');
});

test('/reply-triage never lets the profile gate an opt-out', () => {
  const body = read('reply-triage');
  assert.match(body, /never touches Stage A|not a stop for Stage A/i,
    'a broken profile must never be able to hold up an unsubscribe');
});

test('the onboarding skill that writes both artifacts exists and is the only writer', () => {
  assert.ok(existsSync(join(ROOT, 'skills', 'gtm-onboard', 'SKILL.md')));
  const writers = Object.keys(READERS).filter((s) => /write.{0,40}gtm\/profile\.yaml/i.test(read(s)));
  assert.deepEqual(writers, [], `readers must not write the profile: ${writers.join(', ')}`);
});

test('every scope the module accepts is documented in the onboarding skill', async () => {
  const { PREFERENCE_SCOPES } = await import('../../_lib/profile.mjs');
  const body = read('gtm-onboard');
  for (const scope of PREFERENCE_SCOPES) {
    assert.ok(body.includes(`\`${scope}\``), `/gtm-onboard must document the ${scope} scope`);
  }
});

test('the preference boundary is stated where it is enforced', () => {
  const body = read('gtm-onboard');
  // A preference that can move spend is a paid call nobody named — the one rule
  // /learn holds its priors to, and the reason preferences are safe to apply at all.
  assert.match(body, /never changes what a run costs/i);
  assert.match(body, /may not add a hop/i);
});
