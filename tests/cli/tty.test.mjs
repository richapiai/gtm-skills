// tests/cli/tty.test.mjs
//
// COLOUR MUST NEVER REACH SOMETHING THAT PARSES.
//
// The pack's output is machine-read: `--json` is parsed, exit codes are branched on, and
// `richapi doctor --report` is pasted into issues by people asking for help. Every one of
// those breaks if an escape sequence shows up in it, and the failure is ugly — a user
// pastes a diagnosis full of `^[[36m`, or a script's JSON.parse throws on a banner.
//
// So the suppression rules are tested harder than the colours are.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  colorEnabled, style, stripAnsi, visibleWidth, banner, chip, box, progress
} from '../../_lib/tty.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'bin', 'richapi.mjs');

const TTY = { isTTY: true };
const PIPE = { isTTY: false };

/** Run with a clean environment so the host's own NO_COLOR/TERM cannot skew a case. */
function withEnv (vars, fn) {
  const saved = {};
  for (const k of ['NO_COLOR', 'FORCE_COLOR', 'TERM']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const k of ['NO_COLOR', 'FORCE_COLOR', 'TERM']) {
      delete process.env[k];
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// When NOT to colour
// ---------------------------------------------------------------------------

test('a pipe is never coloured', () => {
  withEnv({}, () => assert.equal(colorEnabled(PIPE), false));
});

test('a TTY is coloured', () => {
  withEnv({}, () => assert.equal(colorEnabled(TTY), true));
});

test('NO_COLOR wins on presence, whatever its value — including empty', () => {
  for (const v of ['', '0', 'false', '1']) {
    withEnv({ NO_COLOR: v }, () => {
      assert.equal(colorEnabled(TTY), false, `NO_COLOR=${JSON.stringify(v)} must disable colour`);
    });
  }
});

test('TERM=dumb is never coloured', () => {
  withEnv({ TERM: 'dumb' }, () => assert.equal(colorEnabled(TTY), false));
});

test('FORCE_COLOR overrides a pipe, for `| less -R`', () => {
  withEnv({ FORCE_COLOR: '1' }, () => assert.equal(colorEnabled(PIPE), true));
});

test('--json and --quiet outrank FORCE_COLOR — parseable output is not negotiable', () => {
  withEnv({ FORCE_COLOR: '1' }, () => {
    assert.equal(colorEnabled(TTY, { json: true }), false);
    assert.equal(colorEnabled(TTY, { quiet: true }), false);
  });
});

// ---------------------------------------------------------------------------
// The primitives
// ---------------------------------------------------------------------------

test('style(false) is identity, so call sites need no ternaries', () => {
  const c = style(false);
  for (const name of ['red', 'green', 'dim', 'bold', 'cyan']) {
    assert.equal(c[name]('x'), 'x', `${name} must not style when disabled`);
  }
  assert.equal(c.enabled, false);
});

test('style(true) emits an escape and always resets it', () => {
  const c = style(true);
  const s = c.red('x');
  assert.notEqual(s, 'x');
  assert.equal(stripAnsi(s), 'x', 'stripping must recover the original exactly');
  assert.ok(s.endsWith('[0m'), 'an unreset colour bleeds into the rest of the terminal');
});

test('the banner is empty when styling is off, not a plain-text logo', () => {
  // A parser should not have to skip a wordmark.
  assert.equal(banner({ enabled: false }), '');
  assert.equal(banner({ enabled: false, version: '1.0.0' }), '');
  assert.ok(banner({ enabled: true }).length > 0);
});

test('chips are the same visible width, so columns line up', () => {
  const c = style(true);
  const widths = new Set(['ok', 'warn', 'fail', 'stop', 'unknown'].map((s) => visibleWidth(chip(s, c))));
  assert.equal(widths.size, 1, `chips must share one width, got ${[...widths]}`);
});

test('an unknown state degrades to the unknown chip rather than throwing', () => {
  assert.equal(visibleWidth(chip('banana')), visibleWidth(chip('unknown')));
});

test('a box is sized by VISIBLE width, so colour inside does not skew it', () => {
  const c = style(true);
  const plain = box(['16 credits', 'x'], { c: style(false) }).split('\n');
  const coloured = box([c.bold('16 credits'), 'x'], { c }).split('\n');
  assert.equal(plain.length, coloured.length);
  for (let i = 0; i < plain.length; i++) {
    assert.equal(visibleWidth(coloured[i]), visibleWidth(plain[i]),
      `row ${i}: colour changed the box geometry`);
  }
});

test('every box row is the same visible width', () => {
  const rows = box(['short', 'a much longer row here', 'mid']).split('\n');
  const widths = new Set(rows.map(visibleWidth));
  assert.equal(widths.size, 1, `ragged box: ${[...widths]}`);
});

test('progress writes nothing when stderr is not a TTY, and returns a no-op', () => {
  const written = [];
  const done = progress('working', { stream: { isTTY: false, write: (s) => written.push(s) } });
  assert.deepEqual(written, []);
  assert.doesNotThrow(() => done());
});

test('progress goes to stderr, never stdout — stdout may be a pipe', () => {
  const written = [];
  const done = progress('working', { stream: { isTTY: true, write: (s) => written.push(s) } });
  assert.ok(written.join('').includes('working'));
  done();
  assert.ok(written.length > 1, 'the line must be cleared, not left on screen');
});

// ---------------------------------------------------------------------------
// End to end through the real CLI
// ---------------------------------------------------------------------------

const runDoctor = (args = [], env = {}) => spawnSync(process.execPath, [BIN, 'doctor', ...args], {
  encoding: 'utf8',
  env: { ...process.env, NO_COLOR: undefined, FORCE_COLOR: undefined, ...env },
});

test('piped doctor output carries no escape sequence', () => {
  const r = runDoctor();
  assert.equal(r.stdout.includes('['), false, 'doctor coloured a pipe');
  assert.match(r.stdout, /richapi doctor/);
});

test('--report is never styled, even forced — it gets pasted into issues', () => {
  const r = runDoctor(['--report'], { FORCE_COLOR: '1' });
  assert.equal(r.stdout.includes('['), false,
    'a diagnosis full of escape codes is worse than no diagnosis');
});

test('--no-color suppresses styling even when forced', () => {
  const r = runDoctor(['--no-color'], { FORCE_COLOR: '1' });
  assert.equal(r.stdout.includes('['), false);
});

test('forced colour does style the human render, and still says the same things', () => {
  const r = runDoctor([], { FORCE_COLOR: '1' });
  assert.ok(r.stdout.includes('['), 'FORCE_COLOR should style the human render');
  const plain = stripAnsi(r.stdout);
  assert.match(plain, /richapi doctor/);
  assert.match(plain, /No API calls were made and no credits were spent\./,
    'styling must not drop the law 3 line');
});

test('the styled and plain renders carry identical text once stripped', () => {
  const colored = stripAnsi(runDoctor([], { FORCE_COLOR: '1' }).stdout);
  const plain = runDoctor().stdout;
  // The banner only exists in the styled render; everything after it must match.
  const marker = 'richapi doctor';
  assert.equal(
    colored.slice(colored.indexOf(marker)).replace(/\s+/g, ' ').trim(),
    plain.slice(plain.indexOf(marker)).replace(/\s+/g, ' ').trim(),
    'colour changed the content, not just the presentation'
  );
});
