// A targeted capture must not erase the record of what it did not run.
//
// `tests/fixtures/live/capture-report.json` is the standing evidence of which endpoints
// have been recorded live, what each cost, and which ones failed. The capture tool built
// a fresh report every run and wrote it whole, so `--only <one-endpoint>` replaced every
// row with that one. Measured 2026-09-18: a single-endpoint re-record took the committed
// report from 13 rows to 1. Nothing warned; it showed up as a deletion in git.
//
// That matters because `--only` is the documented way to re-record a fixture before
// release (see PUSH-TOMORROW / the pre-public checklist), so the destructive path is the
// one a release actually walks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL#pathname: this repo lives under a path with spaces in it, and
// pathname hands back the percent-encoded form, which fs cannot open.
const SRC = fileURLToPath(new URL('../../bin/richapi-capture-fixtures.mjs', import.meta.url));
const REPORT = fileURLToPath(new URL('./live/capture-report.json', import.meta.url));

test('the capture tool merges its report instead of replacing it', () => {
  const src = fs.readFileSync(SRC, 'utf8');

  // The carry-forward exists, reads the file that is about to be overwritten, and keeps
  // only the rows this run did not produce itself.
  assert.match(src, /const previous = \(\(\) => \{/, 'previous rows are read back');
  assert.match(src, /capture-report\.json/, 'from the report it is about to write');
  assert.match(src, /previous\.filter\(\(r\) => !ranNow\.has\(r\.endpoint\)\)/,
    'this run supersedes its OWN endpoints and carries the rest');

  // The spend total is computed BEFORE the carried rows are merged in: reprinting a
  // previous capture's credits must not report them as spent again.
  const spentAt = src.indexOf('report.credits_spent_estimated = round(spent)');
  const mergeAt = src.indexOf('const carried = previous.filter');
  assert.ok(spentAt > -1 && mergeAt > -1 && spentAt < mergeAt,
    'spend is totalled before the carry-forward, or old credits are counted as new');
});

test('an unreadable or absent previous report is not a crash', () => {
  // Fail OPEN here, deliberately and narrowly: with no previous report this run IS the
  // whole record, and refusing to capture because a report file is missing would be
  // worse than starting one.
  const src = fs.readFileSync(SRC, 'utf8');
  assert.match(src, /\} catch \{ return \[\]; \}/, 'absent or corrupt reads as "no previous rows"');
});

test('the committed report is a merge-shaped document', () => {
  const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
  assert.ok(Array.isArray(report.results), 'results is a list');
  assert.ok(report.results.length > 1, 'more than one endpoint on record');

  // One row per endpoint: the merge must not accumulate duplicates run over run.
  const names = report.results.map((r) => r.endpoint);
  assert.equal(new Set(names).size, names.length, `duplicate endpoints in the report: ${names}`);
});
