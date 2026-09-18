// tests/contracts/no-outside-references.test.mjs
//
// THIS PUBLIC PACK DOES NOT NAME OTHER VENDORS' PRODUCTS OR THE TOOLS IT WAS BUILT WITH.
//
// It stands on its own evidence; it is not pitched as a replacement for anything. A
// banned name that slips into a skill, a doc, a data file or a test label is scanned
// for here, over every path package.json `files` ships plus tests/ and the repo's own
// config. File names are checked as well as contents.
//
// The banned words are stored as SHA-256 hashes of lower-case word tokens, so this
// guard does not itself print the names it keeps out. To add one:
//   printf %s '<word>' | shasum -a 256
//
// The allowlist is for RECORDINGS only (law 2: a recorded response is never edited).
// An allowlisted file that no longer contains the name fails too, so the list cannot
// quietly go stale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { ROOT, shippedFiles } from '../helpers/shipped-files.mjs';

const BANNED = new Set([
  '06363555054de198a87c4c743572dd5113a5fa5d298b9478a30c29ebb9d38b97',
  'cdcd2976d6fb770b6f392263570cdef99f9fe7513a4a960225cf02d97aea344e',
  'e707117da2d9a6365eef9aa7d5b49f71b34e797e72952dd6b3fa1679e85f55e4',
  '99dc4480ae738855a7a69be4d884b92e2fd0c1dcb23722091c27dcf84a5a5e03',
  '556d1f14c80f008eb61334df7417e0adb53464a22552ce44913c435fd39f3fe5',
  '9fee8d4bbba24a0fcba6615d33fe1458f7acd9c9bee82fbbf280f4900156ba2e',
]);
const seen = new Map();
function bannedToken (token) {
  if (!seen.has(token)) seen.set(token, BANNED.has(createHash('sha256').update(token).digest('hex')));
  return seen.get(token);
}
const PATTERN = {
  test: (text) => (String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []).some(bannedToken),
};

const ALLOWLIST = {
  'tests/fixtures/live/web_meta_tags.json':
    "recorded response of richapi.ai's own meta keywords; re-capture after the site changes",
  'tests/fixtures/live/website_intelligence.json':
    "recorded response of richapi.ai's own meta keywords; re-capture after the site changes",
};

const FILES = shippedFiles();

test('the scan covers the shipped tree and the tests', () => {
  for (const must of ['README.md', 'skills/research-agent/SKILL.md', '_lib/dual-contract.schema.json',
    'tests/contracts/no-outside-references.test.mjs', '.gitignore']) {
    assert.ok(FILES.includes(must), `${must} is not scanned`);
  }
});

test('no shipped file, test or config carries a banned name', () => {
  const hits = [];
  for (const rel of FILES) {
    if (PATTERN.test(rel)) { hits.push(`${rel} (file name)`); continue; }
    if (ALLOWLIST[rel]) continue;
    const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((l, i) => { if (PATTERN.test(l)) hits.push(`${rel}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], `banned name found:\n  ${hits.join('\n  ')}`);
});

test('every allowlisted file still needs its exemption', () => {
  for (const [rel, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(reason, `${rel} is allowlisted without a reason`);
    assert.ok(FILES.includes(rel), `${rel} is allowlisted but no longer exists — drop it from the list`);
    assert.ok(PATTERN.test(readFileSync(join(ROOT, rel), 'utf8')),
      `${rel} no longer contains the name — drop it from the allowlist`);
  }
});
