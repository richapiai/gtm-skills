// The drift gate is only a gate if something runs it.
//
// A checker that exists in bin/ and is invoked by nothing is a checker nobody notices
// has rotted. These tests assert the two places that actually execute it, and the two
// properties of that wiring that are easy to lose in a later edit: the CI step must be
// pinned to ONE matrix row (it is the only step that leaves the runner) and neither
// caller may pass a flag that turns the gate off.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'validate.yml'), 'utf8');
const CI_LOCAL = fs.readFileSync(path.join(ROOT, 'scripts', 'ci-local.sh'), 'utf8');
const BIN = 'bin/richapi-catalog-drift.mjs';

test('the drift gate runs in the validate workflow', () => {
  assert.ok(WORKFLOW.includes(BIN), `${BIN} is not invoked anywhere in validate.yml`);
});

test('the CI step is pinned to a single matrix row', () => {
  // Four identical GETs of a third-party endpoint per push buys nothing but four times
  // the flake surface. `strategy.job-index` is used rather than a hard-coded version so
  // that changing the floor row does not silently stop the step from ever running.
  const step = WORKFLOW.slice(WORKFLOW.indexOf('Pinned catalog still matches the live server'));
  const upToRun = step.slice(0, step.indexOf(BIN));
  assert.match(upToRun, /if:\s*strategy\.job-index == 0/);
  assert.ok(
    !/matrix\.node ==/.test(upToRun),
    'gate on strategy.job-index, not on a literal version — a renamed floor row would ' +
      'match nothing and the step would silently never run again'
  );
});

test('the drift gate runs in ci-local.sh, as a real `step` so a failure stops it', () => {
  assert.ok(CI_LOCAL.includes(BIN), `${BIN} is not invoked anywhere in ci-local.sh`);
  assert.match(CI_LOCAL, /^step "Pinned catalog still matches the live server" \\\n\s+node bin\/richapi-catalog-drift\.mjs/m);
});

test('ci-local.sh bounds the fetch, so a hung server cannot stretch a local run', () => {
  const line = CI_LOCAL.split('\n').find((l) => l.includes(BIN));
  assert.match(line, /--timeout \d+/, 'ci-local must pass an explicit deadline');
});

test('neither caller passes a flag that disarms the gate', () => {
  for (const [label, src] of [['validate.yml', WORKFLOW], ['ci-local.sh', CI_LOCAL]]) {
    const line = src.split('\n').find((l) => l.includes(BIN)) ?? '';
    assert.ok(!line.includes('--warn-only'), `${label} runs the drift gate with --warn-only`);
    assert.ok(!line.includes('|| true'), `${label} swallows the drift gate's exit code`);
  }
});

test('ci-local.sh no longer claims it never touches the network', () => {
  // The header used to say "network NONE". It now runs one step that reaches out and
  // skips cleanly when it cannot; a header that lies about that is worse than no header.
  assert.ok(!/network NONE\./.test(CI_LOCAL), 'the header still claims "network NONE"');
  assert.match(CI_LOCAL, /SKIPPED banner and exits 0/);
});

test('`bash scripts/ci-local.sh --help` still prints the whole header', () => {
  // The help range is a line number, so growing the header silently truncates it.
  const m = /sed -n '2,(\d+)p'/.exec(CI_LOCAL);
  assert.ok(m, 'could not find the --help sed range');
  const lines = CI_LOCAL.split('\n');
  const last = Number(m[1]);
  assert.match(lines[last - 1], /^# Usage:/, `the --help range ends at line ${last}, which is not the Usage line`);
});
