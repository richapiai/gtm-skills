// tests/regression/unknown-flags.test.mjs
//
// A TYPO MUST NOT BE THE DIFFERENCE BETWEEN PRICING A RUN AND PAYING FOR IT.
//
// The CLI used to accept any `--flag` and ignore the ones it did not recognise. That is
// a money bug. `richapi enrich list.csv --dryrun --yes --budget 50` is one missing
// hyphen away from `--dry-run`, and with a valid key it was a REAL run: the user thinks
// they are pricing, the runtime thinks they approved. `--budget` caps the damage, so it
// was bounded, never prevented.
//
// Two things are pinned here:
//
//   1. An unknown flag exits 2 and calls nothing.
//   2. KNOWN_FLAGS covers every flag the source actually reads. Without that second
//      half the guard rots into a denylist of yesterday's flags, and the first new flag
//      someone adds becomes un-passable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { KNOWN_FLAGS, unknownFlag, suggestFlag } from '../../bin/richapi.mjs';
import { trackedTmp } from '../helpers/index.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'bin', 'richapi.mjs');
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

function listFile () {
  const f = join(trackedTmp('unknown-flags-'), 'list.csv');
  writeFileSync(f, 'email\na@example.com\n');
  return f;
}

// ---------------------------------------------------------------------------
// 1. The declared list matches what the code reads
// ---------------------------------------------------------------------------

test('KNOWN_FLAGS covers every flag the CLI source reads', () => {
  // Comments are stripped first. Without that, this file's own name
  // ("unknown-flags.test.mjs") appears in a doc comment in the CLI and matches as a
  // flag called `test` — a guard that reads its own documentation as evidence.
  const src = readFileSync(BIN, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
  const read = new Set();
  for (const m of src.matchAll(/\bflags\.([a-z][a-z0-9_]*)\b/g)) {
    if (['has', 'get', 'set', 'add'].includes(m[1])) continue; // Set methods, not flags
    read.add(m[1]);
  }
  assert.ok(read.size > 10, `expected to find flag reads, found ${read.size}`);

  const undeclared = [...read].filter((f) => !KNOWN_FLAGS.has(f)).sort();
  assert.deepEqual(undeclared, [],
    `the CLI reads these flags but KNOWN_FLAGS does not declare them, so passing one is `
    + `refused: ${undeclared.join(', ')}`);
});

test('every NEEDS_VALUE flag is also a known flag', () => {
  const src = readFileSync(BIN, 'utf8');
  const block = /const NEEDS_VALUE = \[([\s\S]*?)\];/.exec(src)[1];
  const names = [...block.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(names.length > 5);
  for (const n of names) {
    assert.ok(KNOWN_FLAGS.has(n), `${n} takes a value but is not in KNOWN_FLAGS`);
  }
});

// ---------------------------------------------------------------------------
// 2. The refusal
// ---------------------------------------------------------------------------

test('the exact money case: a --dryrun typo refuses instead of running', () => {
  const r = run('enrich', listFile(), '--dryrun', '--yes', '--budget', '50');
  assert.equal(r.status, 2, 'an unknown flag must exit 2');
  const all = `${r.stdout}${r.stderr}`;
  assert.match(all, /unknown flag "--dryrun"/);
  assert.match(all, /--dry-run/, 'a one-character typo deserves a suggestion');
  assert.match(all, /Nothing was planned and nothing was called/);
});

test('an unknown flag with no near match is still refused, without a bogus suggestion', () => {
  const r = run('enrich', listFile(), '--banana');
  assert.equal(r.status, 2);
  const all = `${r.stdout}${r.stderr}`;
  assert.match(all, /unknown flag "--banana"/);
  assert.doesNotMatch(all, /Did you mean/, 'a wrong suggestion is worse than none');
});

test('the refusal happens before any planning, on every spending command', () => {
  for (const cmd of ['enrich', 'call', 'search']) {
    const r = run(cmd, 'whatever', '--notaflag');
    assert.equal(r.status, 2, `${cmd} did not refuse an unknown flag`);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, /DRY RUN|credits/i,
      `${cmd} started planning before validating its flags`);
  }
});

test('every declared flag is accepted, so the guard cannot lock out real usage', () => {
  // `--help` short-circuits before the guard by design; `--version` is a command.
  for (const flag of [...KNOWN_FLAGS].filter((f) => !['help', 'version'].includes(f))) {
    const r = run('enrich', listFile(), `--${flag.replace(/_/g, '-')}`, '1', '--dry-run');
    assert.notEqual(r.status, 2,
      `--${flag.replace(/_/g, '-')} is declared known but the CLI refused it:\n${r.stdout}${r.stderr}`);
  }
});

test('--help still works and is never treated as an unknown flag', () => {
  const r = run('enrich', '--help');
  assert.equal(r.status, 0);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /unknown flag/);
});

test('a bare `richapi` and `richapi help` are unaffected', () => {
  assert.equal(run().status, 0);
  assert.equal(run('help').status, 0);
});

// ---------------------------------------------------------------------------
// 3. The helpers, directly
// ---------------------------------------------------------------------------

test('unknownFlag returns the first offender, or null', () => {
  assert.equal(unknownFlag({ dry_run: true, out: 'x' }), null);
  assert.equal(unknownFlag({ dryrun: true }), 'dryrun');
  assert.equal(unknownFlag({}), null);
});

test('suggestFlag only matches a real near-miss', () => {
  assert.equal(suggestFlag('dryrun'), '--dry-run');
  assert.equal(suggestFlag('nocache'), '--no-cache');
  assert.equal(suggestFlag('banana'), null, 'never invent a suggestion');
});
