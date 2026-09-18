// scripts/ci-local.sh.
//
// CI has never executed and there is no remote. This suite guards the two things
// that make a local CI runner worth having:
//
//   1. It runs EVERY step of the `validate` job, in the workflow's order. A local
//      runner that quietly drifts from the workflow is worse than none: it produces
//      a green that means nothing.
//   2. It STOPS at the first failure. A runner that carries on past a red step
//      reports the last step's status as the run's status.
//
// It deliberately does NOT run the whole thing (that is the script's job, and the
// report carries its real output) — running the full suite from inside the suite
// would recurse.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { trackedTmp } from '../helpers/index.mjs';
import { parseYaml } from '../helpers/yaml.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(REPO, 'scripts', 'ci-local.sh');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'validate.yml');

const script = () => fs.readFileSync(SCRIPT, 'utf8');
/** The script with its comment lines removed. */
const codeOnly = () => script().split('\n').filter(l => !l.trim().startsWith('#')).join('\n');
const workflow = () => parseYaml(fs.readFileSync(WORKFLOW, 'utf8'));

/** Normalise whitespace so a wrapped `run:` still matches. */
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

test('the script exists, is executable, and is a bash script', () => {
  assert.ok(fs.existsSync(SCRIPT));
  assert.ok((fs.statSync(SCRIPT).mode & 0o111) !== 0, 'ci-local.sh must be executable');
  assert.match(script().split('\n')[0], /^#!\/usr\/bin\/env bash/);
});

test('every `run:` step of the validate job is reproduced, in order', () => {
  const wf = workflow();
  const steps = (wf.jobs.validate.steps ?? []).filter(s => s.run);
  assert.ok(steps.length >= 7, `expected the validate job to have steps; found ${steps.length}`);

  const src = flat(script());
  let cursor = -1;
  for (const s of steps) {
    const cmd = flat(s.run);
    // `npm ci` is run with an added --offline (no network is available), and the
    // test command's $( ) is escaped inside bash -c. Match on the distinctive core
    // of each command rather than byte-for-byte.
    const needle = cmd
      .replace('npm ci --no-audit --no-fund', 'npm ci --offline --no-audit --no-fund')
      .replace("node --test $(find tests -name '*.test.mjs' | sort)",
        "node --test \\$(find tests -name '*.test.mjs' | sort)");
    const at = src.indexOf(needle);
    assert.notEqual(at, -1, `ci-local.sh does not run the workflow step: ${cmd}`);
    assert.ok(at > cursor, `ci-local.sh runs "${cmd}" out of the workflow's order`);
    cursor = at;
  }
});

test('the absorb-spec job is NOT reproduced (it pushes, and it fetches)', () => {
  // Comments are stripped: the script explains WHY it does not push, and the
  // explanation must not be what fails the test.
  const src = codeOnly();
  for (const forbidden of ['git push', 'git commit', 'git add', 'gh issue create', 'npm publish', '--spec-url']) {
    assert.ok(!src.includes(forbidden), `ci-local.sh must never run: ${forbidden}`);
  }
  // The workflow's own absorb-spec job still contains them — this is a real
  // difference, not an accident of the workflow having changed.
  const wfSrc = fs.readFileSync(WORKFLOW, 'utf8');
  assert.ok(wfSrc.includes('git push'), 'precondition: absorb-spec is the job that pushes');
});

test('no git command anywhere in the script', () => {
  // The user is offline and has forbidden anything leaving the machine. A local CI
  // runner is exactly the place a stray `git status` or `git fetch` sneaks in.
  assert.ok(!/\bgit\s+\w/.test(codeOnly()), 'ci-local.sh must not shell out to git');
});

test('npm install is forced offline, and npm ci is never run bare', () => {
  // Only INVOCATIONS count. A `printf` that mentions npm ci in a status line is
  // prose, not a command.
  const invocations = codeOnly().split('\n')
    .map(l => l.trim())
    .filter(l => /^(step\s|npm ci\b)/.test(l) && l.includes('npm ci'));
  assert.ok(invocations.length > 0, 'the install step must be present');
  for (const line of invocations) {
    assert.match(line, /--offline/, `bare \`npm ci\` would reach the registry: ${line}`);
  }
});

test('--help prints usage without running anything', () => {
  const out = execFileSync('bash', [SCRIPT, '--help'], { cwd: REPO, encoding: 'utf8' });
  assert.match(out, /run \.github\/workflows\/validate\.yml, locally, offline/);
  assert.ok(!out.includes('[PASS]'), '--help must not execute a step');
});

test('an unknown argument exits non-zero rather than running the suite', () => {
  const r = spawnSync('bash', [SCRIPT, '--wat'], { cwd: REPO, encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown argument/);
});

test('FAIL-FAST: the script stops at the first failing step and exits non-zero', () => {
  // Break `node` on PATH, skip the install step, and watch it die on the first step
  // that needs node — step 3, the catalog gate. Steps 4 onward must never run.
  const shim = trackedTmp('s5-ci-shim-');
  fs.writeFileSync(path.join(shim, 'node'), '#!/bin/sh\necho "simulated node failure" >&2\nexit 17\n');
  fs.chmodSync(path.join(shim, 'node'), 0o755);

  const r = spawnSync('bash', [SCRIPT, '--skip-install'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
  });

  assert.notEqual(r.status, 0, 'a failing step must produce a non-zero exit');
  assert.equal(r.status, 17, 'the failing step\'s own exit code must survive');
  const out = r.stdout + r.stderr;
  assert.match(out, /\[FAIL\] step 3/);
  assert.match(out, /ci-local: FAILED at step 3/);
  assert.ok(!out.includes('STEP 4'), 'steps after the failure must not run');
  assert.match(out, /their status is unknown, not green/);
});

test('the script states what it cannot verify: the node matrix', () => {
  // DERIVED from the workflow, never hard-coded. The previous version of this test
  // asserted the literal list ['20','22','24'], which meant the matrix could not be
  // corrected without the test objecting — and the thing most needing correction was
  // that those floating majors proved only their newest patch.
  const wf = workflow();
  const matrix = wf.jobs.validate.strategy.matrix.node.map(String);
  const src = script();

  assert.ok(matrix.length >= 2, `the matrix has only ${matrix.length} row(s)`);
  for (const v of matrix) {
    assert.match(v, /^\d+\.\d+\.\d+$/,
      `matrix row "${v}" is a floating major; pin it so the row proves a known version`);
    assert.ok(src.includes(v),
      `ci-local.sh's disclaimer does not mention matrix row ${v}, so it understates what ` +
      'this one-runtime run leaves unproven');
  }
  assert.match(src, /matrix CI runs node /);
  assert.match(src, /UNVERIFIED/, 'a one-runtime run must say the other rows are unproven');
});

test('package `files:` and the tarball agree (npm pack --dry-run, fully local)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  // --dry-run contacts no registry. It builds the tarball listing locally.
  const r = spawnSync('npm', ['pack', '--dry-run'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `npm pack --dry-run failed: ${r.stderr}`);
  const listing = (r.stdout + r.stderr)
    .split('\n')
    .map(l => l.match(/^npm notice\s+[\d.]+\s*[kMG]?B\s+(.+)$/))
    .filter(Boolean)
    .map(m => m[1].trim());
  assert.ok(listing.length > 20, `could not parse the pack listing (${listing.length} entries)`);

  // `files:` entries starting with `!` are NEGATIONS — they subtract from an earlier
  // entry rather than adding anything of their own (`"bin/"` then
  // `"!bin/richapi-capture-fixtures.mjs"`, which keeps a credit-spending maintainer
  // tool out of the tarball). Both checks below are about what an entry CONTRIBUTES,
  // so a negation is not one of them: it can never match a packed path, and reading it
  // as an allowlist entry would let a stowaway named `!bin/...` through.
  const positive = pkg.files.filter(f => !f.startsWith('!'));

  const allowed = [...positive, 'package.json'];
  const covered = (f) => allowed.some(a => (a.endsWith('/') ? f.startsWith(a) : f === a));
  const stowaways = listing.filter(f => !covered(f));
  assert.deepEqual(stowaways, [], 'the tarball carries files the `files:` array does not declare');

  // And nothing that must never ship.
  for (const f of listing) {
    assert.ok(!f.startsWith('gtm/'), 'gtm/ is PII and must never be packaged (law 7)');
    assert.ok(!f.startsWith('tests/'), 'tests are not part of the published pack');
    assert.ok(!f.startsWith('node_modules/'));
    assert.ok(!f.startsWith('.github/'));
  }

  // Every directory the `files:` array declares actually contributed something —
  // a declared-but-empty entry is a packaging claim nobody is checking.
  for (const entry of positive) {
    assert.ok(listing.some(f => (entry.endsWith('/') ? f.startsWith(entry) : f === entry)),
      `package.json declares "${entry}" but nothing under it was packed`);
  }

  // The other half of a negation: it must actually subtract. A `!` entry that removes
  // nothing is a packaging claim nobody is checking either — and this one is the reason
  // a tool that spends real credits does not reach every installer.
  for (const entry of pkg.files.filter(f => f.startsWith('!'))) {
    const pat = entry.slice(1);
    assert.ok(!listing.some(f => (pat.endsWith('/') ? f.startsWith(pat) : f === pat)),
      `package.json negates "${pat}" but it was packed anyway`);
    assert.ok(fs.existsSync(path.join(REPO, pat)) || pat.endsWith('/'),
      `package.json negates "${pat}", which does not exist — a stale negation hides the ` +
      'day the real file comes back');
  }
});
