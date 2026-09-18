// tests/skills/sequence-builder/export-boundary-exemption.test.mjs
//
// /launch is the sole writer of the artifact a sending tool ingests. The validator
// enforces it twice — an ERROR on naming `writeSenderExport`, and a WARNING on any
// paragraph that reads as "write a contact list to a sender".
//
// /sequence-builder is the ONE skill exempted from the warning, because it legitimately
// discusses sender-native syntax: merge tags, fallbacks, conditional blocks. The
// exemption is a hole in a safety net, and a hole is only safe while nobody leans on it.
//
// So this file asserts the exemption is UNUSED: the body is run through the validator's
// own heuristic and must produce zero hits, meaning this skill would pass the sole-writer rule even if
// the exemption were deleted tomorrow. The exemption buys headroom, not licence.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SKILL, REPO_ROOT, skillBody } from './helpers.mjs';

const body = skillBody();

// Copied verbatim from scripts/validate-skills.mjs. A copy can drift, so the test below
// asserts the source still contains these literals.
const SENDERS = /\b(smartlead|instantly|lemlist|woodpecker|reply\.io)\b/i;
const VERBS = /\b(write|export|upload|push)\b/i;
const NOUNS = /\b(csv|list|contacts|file)\b/i;

test('the hard rule: the sender-export writer is never named here (an ERROR)', () => {
  assert.ok(!/\bwriteSenderExport\b/.test(body),
    'any skill other than /launch that names writeSenderExport fails the build outright');
});

test('the soft rule: no paragraph trips the heuristic, so the exemption is unused', () => {
  const trips = body.split(/\n\s*\n/)
    .filter(p => SENDERS.test(p) && VERBS.test(p) && NOUNS.test(p));
  assert.deepEqual(trips, [],
    'a paragraph reads as writing a contact list to a sender. /sequence-builder is exempt '
    + 'from the warning so it can discuss merge-tag syntax — not so it can describe the '
    + 'hand-off it is forbidden to perform:\n\n' + trips.join('\n---\n'));
});

test('the exemption this skill relies on still exists in the validator', () => {
  const src = readFileSync(join(REPO_ROOT, 'scripts', 'validate-skills.mjs'), 'utf8');
  assert.match(src, /dir !== 'launch' && dir !== 'sequence-builder'/,
    'the export-boundary warning exemption for /sequence-builder was removed or renamed');
  assert.match(src, /smartlead\|instantly\|lemlist\|woodpecker\|reply\\\.io/i,
    'the sender pattern this test copies has changed — re-sync SENDERS above');
});

test('it does discuss sender-native syntax, which is the whole reason for the exemption', () => {
  assert.match(body, /merge[- ]tag/i, 'merge-tag syntax is the legitimate use of the exemption');
  assert.match(body, /conditional block/i, 'conditional blocks are sender-native syntax');
  assert.match(body, /fallback/i, 'a tag with no fallback is the classic broken send');
  assert.ok(SENDERS.test(body), 'it names the senders whose dialects differ — that is allowed');
});

test('the hand-off is to /launch, always, and by link', () => {
  assert.match(body, /\]\(\.\.\/launch\/SKILL\.md\)/,
    'the skill must route the sending artifact to /launch by relative link');
  assert.match(body, /exactly\s*\n?\s*one author in this pack|one author in this pack/i,
    'the boundary section must say the sender artifact has exactly one author');
  assert.ok(/\bnot send\b|will not send/i.test(body),
    'sending execution is outside the pack permanently and must be stated');
});
