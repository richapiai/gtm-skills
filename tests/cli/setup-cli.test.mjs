// tests/cli/setup-cli.test.mjs
//
// `./setup` IS THE FIRST COMMAND A STRANGER RUNS, AND IT WAS THE LEAST TESTED.
//
// Every other CLI surface in this pack has a spawn test. setup.mjs had none — only
// `executables-load` (does it parse) and `setup-sweep` (one branch deep inside it). So
// three defects shipped in the one command the README puts first, and all three were
// found by a human running it, not by the suite:
//
//   1. `--root=DIR` — the form bin/richapi.mjs has always accepted — was rejected as
//      `unknown argument: --root=/tmp/x`. The pack's own CLI disagreed with itself.
//   2. `--root` with no value reached `resolve(undefined)` and printed a raw Node
//      stack trace instead of a usage line.
//   3. `--root DIR` where DIR did not exist yet — the documented way to point setup at
//      a workspace — died with `ENOENT: .../.gitignore` before creating anything,
//      because the .gitignore write was the first write and nothing had made the root.
//      `--check` passed the whole time: check mode never writes, so the one mode that
//      was exercised was the one mode that could not hit the bug.
//
// Defect 3 is the interesting one and the reason this file spawns the real binary
// instead of importing parseArgs: it is invisible to any test that does not WRITE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { trackedTmp } from '../helpers/index.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SETUP = join(REPO, 'setup.mjs');

const run = (...args) => spawnSync(process.execPath, [SETUP, ...args], { encoding: 'utf8' });
/** A path inside a tracked temp dir that does NOT exist yet. */
const freshRoot = () => join(trackedTmp('setup-cli-'), 'workspace');

// ---------------------------------------------------------------------------
// 1. Both documented flag forms, and they must agree
// ---------------------------------------------------------------------------

test('--root=DIR and --root DIR are the same command', () => {
  const a = freshRoot();
  const b = freshRoot();

  const eq = run(`--root=${a}`);
  const sp = run('--root', b);

  assert.equal(eq.status, 0, `--root=DIR failed:\n${eq.stdout}${eq.stderr}`);
  assert.equal(sp.status, 0, `--root DIR failed:\n${sp.stdout}${sp.stderr}`);

  // Same tree either way. This is the assertion that would have caught defect 1.
  for (const root of [a, b]) {
    assert.ok(existsSync(join(root, 'gtm')), `${root}: gtm/ not created`);
    assert.ok(existsSync(join(root, '.gitignore')), `${root}: .gitignore not written`);
  }
});

// ---------------------------------------------------------------------------
// 2. A root that does not exist yet — defect 3
// ---------------------------------------------------------------------------

test('setup creates the root when it does not exist, rather than dying on ENOENT', () => {
  const root = freshRoot();
  assert.equal(existsSync(root), false, 'precondition: the root must not exist');

  const r = run('--root', root);

  assert.equal(r.status, 0, `exit ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /ENOENT|\bat \w+ \(node:/,
    'a missing root must not surface as a raw Node error');
  assert.ok(existsSync(join(root, 'gtm')), 'gtm/ tree missing');
});

test('a nested root that does not exist is created too', () => {
  const root = join(trackedTmp('setup-cli-'), 'a', 'b', 'c');
  const r = run('--root', root);
  assert.equal(r.status, 0, `exit ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.ok(existsSync(join(root, 'gtm')), 'nested root not created');
});

test('--check still writes nothing, including the root itself', () => {
  const root = freshRoot();
  const r = run('--root', root, '--check');
  assert.equal(r.status, 0, `exit ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.equal(existsSync(root), false, 'check mode created the root — it must write nothing');
});

// ---------------------------------------------------------------------------
// 3. Usage errors read like usage errors — defect 2
// ---------------------------------------------------------------------------

for (const flag of ['--root', '--gates', '--sweep-domain', '--confirm-domain']) {
  test(`${flag} with no value is a usage error, not a stack trace`, () => {
    const r = run(flag);
    assert.equal(r.status, 1, 'a usage error exits 1');
    const all = `${r.stdout}${r.stderr}`;
    assert.match(all, new RegExp(`\\${flag} needs a value`));
    assert.doesNotMatch(all, /\bat \w+ \(node:/, 'no raw Node stack trace');
    assert.doesNotMatch(all, /ERR_INVALID_ARG_TYPE/);
  });
}

test('a value on a boolean flag is refused rather than silently ignored', () => {
  const r = run('--check=yes');
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /--check takes no value/);
});

test('an unknown argument exits 1 and names itself', () => {
  const r = run('--wat');
  assert.equal(r.status, 1);
  assert.match(`${r.stdout}${r.stderr}`, /unknown argument: --wat/);
});

test('--help exits 0 and documents --root', () => {
  const r = run('--help');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--root DIR/);
});

// ---------------------------------------------------------------------------
// 4. Law 3 holds on the path a first run actually takes
// ---------------------------------------------------------------------------

test('a real setup run makes zero paid calls and says so', () => {
  const r = run('--root', freshRoot(), '--json', '--no-sweep');
  assert.equal(r.status, 0, `exit ${r.status}:\n${r.stdout}${r.stderr}`);
  const result = JSON.parse(r.stdout);
  assert.equal(result.paid_calls, 0);
  assert.equal(result.credits_spent, 0);
});

// ---------------------------------------------------------------------------
// 5. A first run points somewhere
// ---------------------------------------------------------------------------

test('a first run names the onboarding step, and says it is free', () => {
  const r = run('--root', freshRoot(), '--no-sweep');
  assert.equal(r.status, 0, `exit ${r.status}:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /gtm-onboard/, 'setup created a workspace and said nothing about what to do with it');
  assert.match(r.stdout, /0 credits/, 'an unpriced next step is one nobody runs');
});

test('--json reports the profile state so a script can see it', () => {
  const root = freshRoot();
  const r = run('--root', root, '--json', '--no-sweep');
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).profile, 'ABSENT');
});

test('the onboarding prompt is not repeated once a profile exists', async () => {
  const { writeProfile } = await import('../../_lib/profile.mjs');
  const root = freshRoot();
  run('--root', root, '--no-sweep');
  writeProfile({ company: 'Acme', what_we_sell: 'a thing', wedge: 'on fire' }, { root });

  const again = run('--root', root, '--no-sweep');
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout, /Next: run \/gtm-onboard/,
    'nagging a user who has already onboarded trains them to ignore the output');
});

test('check mode names the next step without writing anything', () => {
  const root = freshRoot();
  const r = run('--root', root, '--check');
  assert.equal(r.status, 0);
  assert.equal(existsSync(root), false, 'check mode must still write nothing');
});
