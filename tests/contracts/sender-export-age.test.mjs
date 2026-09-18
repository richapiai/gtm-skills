// tests/contracts/sender-export-age.test.mjs
//
// The fourth refusal, moved inside the seam.
//
// Building /campaign-review and /launch exposed the gap precisely:
// verdictCovers() binds CONTENT and nothing else, so "no verdict", "not PASS"
// and "hash mismatch" were enforced by the library against any in-process
// caller, while "the verdict has gone stale on the clock" was enforced only by
// /launch's own pre-check. A caller that got past the actor seam could write an
// arbitrarily old verdict's export.
//
// These tests are the reason that is no longer true. They also pin the two
// judgement calls in the fix: the clock is the caller's, not the document's,
// and an age that cannot be established counts as expired (law 5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  writeSenderExport, listContentHash, SenderExportRefused,
} from '../../_lib/sender-export.mjs';

const tracked = [];
function sandbox () {
  const d = mkdtempSync(join(tmpdir(), 'export-age-'));
  tracked.push(d);
  mkdirSync(join(d, 'gtm'), { recursive: true });
  // An EMPTY store, not a missing one. Writing the export loads suppression at
  // send time and a missing store is a hard STOP by design (law 5) — the first
  // draft of these tests omitted this and every write refused for the wrong
  // reason, which would have made the age assertions pass vacuously.
  writeFileSync(join(d, 'gtm', 'suppression.jsonl'), '', 'utf8');
  return d;
}
process.on('exit', () => {
  for (const d of tracked) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

const ROWS = [
  { email: 'a@example.com', first_name: 'A' },
  { email: 'b@example.com', first_name: 'B' },
];

/** A PASS verdict bound to ROWS, issued `ageHours` ago. */
function verdictAged (ageHours) {
  return {
    status: 'PASS',
    list_hash: listContentHash(ROWS),
    verdict_id: 'v-test',
    issued_at: new Date(Date.now() - ageHours * 3_600_000).toISOString(),
  };
}

function attempt (root, verdict, maxAgeHours) {
  const file = join(root, 'gtm', 'export.csv');
  try {
    const res = writeSenderExport({
      file, rows: ROWS, platform: 'csv', verdict,
      root, actor: 'launch', maxAgeHours,
    });
    return { ok: true, res, file };
  } catch (e) {
    return { ok: false, error: e, file };
  }
}

test('a fresh verdict still writes when an age limit is set', () => {
  const root = sandbox();
  const out = attempt(root, verdictAged(1), 168);
  assert.ok(out.ok, `expected a write, got: ${out.error?.message}`);
  assert.ok(existsSync(out.file));
});

test('a verdict past the age limit is refused BY THE LIBRARY', () => {
  const root = sandbox();
  const out = attempt(root, verdictAged(200), 168);
  assert.ok(!out.ok, 'a 200h-old verdict must not write with a 168h limit');
  assert.ok(out.error instanceof SenderExportRefused);
  assert.match(out.error.message, /STALE by age/);
  assert.ok(!existsSync(out.file), 'a refused export must leave no file behind');
});

test('the boundary holds on both sides', () => {
  assert.ok(attempt(sandbox(), verdictAged(167.5), 168).ok, 'just inside must write');
  assert.ok(!attempt(sandbox(), verdictAged(168.5), 168).ok, 'just outside must refuse');
});

test('a verdict does not get to set the terms of its own expiry', () => {
  // The document claims it never expires. The caller's clock disagrees, and the
  // caller's clock is the one that counts — otherwise any writer could mint an
  // immortal verdict and the gate would be advisory.
  const root = sandbox();
  const v = { ...verdictAged(5000), expires_at: '2099-01-01T00:00:00.000Z', max_age_hours: 100000 };
  const out = attempt(root, v, 168);
  assert.ok(!out.ok, 'expires_at in the body must not override the caller-supplied limit');
  assert.match(out.error.message, /STALE by age/);
});

test('an age that cannot be established counts as expired, not as ageless', () => {
  // Law 5. The alternative — treating an unparseable timestamp as "no age
  // problem" — makes deleting a field the easiest way to bypass the gate.
  for (const issued_at of [undefined, null, '', 'not-a-date', 12345]) {
    const root = sandbox();
    const v = { ...verdictAged(1), issued_at };
    const out = attempt(root, v, 168);
    assert.ok(!out.ok, `issued_at=${JSON.stringify(issued_at)} must refuse`);
    assert.match(out.error.message, /no parseable issued_at|treated as expired/);
  }
});

test('omitting maxAgeHours preserves the old behaviour exactly', () => {
  // Backwards compatibility is the reason this defaults to null: every existing
  // caller in tests/cli/ and tests/evals/ predates the parameter.
  const root = sandbox();
  const out = attempt(root, verdictAged(100000), null);
  assert.ok(out.ok, 'with no age limit, age must not be checked at all');
});

test('age is checked AFTER content, so the more specific refusal wins', () => {
  // A stale verdict for a list that also changed should report the hash
  // mismatch: "re-run the review because the list changed" is actionable in a
  // way that "it is old" is not, and fixing the list invalidates the age anyway.
  const root = sandbox();
  const v = { ...verdictAged(5000), list_hash: 'deadbeef'.repeat(8) };
  const out = attempt(root, v, 168);
  assert.ok(!out.ok);
  assert.match(out.error.message, /STALE: it reviewed list/);
});
