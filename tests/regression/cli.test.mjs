// The CLI was once effectively untested.
//
// One test touched the binary, exercising help, gates and an unknown command. Untested:
// argument parsing, every exit code, and the spend confirmation — the last thing
// between a user and an unintended charge. Law 3 ("every paid call is named and costed
// before it runs") was enforced by a code path with no tests at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, trackedTmp } from '../helpers/index.mjs';
import { parseArgs, confirmAccepted } from '../../bin/richapi.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(REPO, 'bin', 'richapi.mjs');
const run = (args, opts = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });

// ---------------------------------------------------------------------------
// The spend gate
// ---------------------------------------------------------------------------

test('only the exact total approves a spend', () => {
  assert.equal(confirmAccepted('16', 16), true);
  assert.equal(confirmAccepted(' 16 ', 16), true, 'surrounding whitespace is not a refusal');
  assert.equal(confirmAccepted('1,600', 1600), true, 'a thousands separator is not a refusal');

  // Everything a hurried user might type that must NOT spend money.
  for (const answer of ['y', 'Y', 'yes', 'YES', 'ok', 'sure', '', '  ', '\n', null, undefined,
    '17', '1', '160', '16.0', '16 credits', 'no']) {
    assert.equal(confirmAccepted(answer, 16), false,
      `answer ${JSON.stringify(answer)} must not approve a 16-credit spend`);
  }
});

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('parseArgs handles every documented form', () => {
  const a = parseArgs(['enrich', 'list.csv', '--dry-run', '--out', 'x.csv', '--budget=50', '--phone']);
  assert.deepEqual(a._, ['enrich', 'list.csv']);
  assert.equal(a.flags.dry_run, true, 'dashes become underscores');
  assert.equal(a.flags.out, 'x.csv', 'a value-consuming flag takes the next argv');
  assert.equal(a.flags.budget, '50', 'the inline --flag=value form works');
  assert.equal(a.flags.phone, true);

  // A boolean flag must NOT swallow the next argument.
  const b = parseArgs(['enrich', '--no-cache', 'list.csv']);
  assert.deepEqual(b._, ['enrich', 'list.csv'], '--no-cache consumed a positional');
  assert.equal(b.flags.no_cache, true);

  // `--` passes the rest through untouched.
  const c = parseArgs(['catalog', 'gen', '--', '--spec', 'other.yaml']);
  assert.deepEqual(c._, ['catalog', 'gen', '--spec', 'other.yaml']);

  assert.deepEqual(parseArgs([])._, []);
});

// ---------------------------------------------------------------------------
// Exit codes — each one is a documented contract
// ---------------------------------------------------------------------------

test('an unknown command exits 2 and names what was wrong', () => {
  const r = run(['nonsense']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command "nonsense"/);
});

test('enrich with no input exits 2', () => {
  const r = run(['enrich']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs an input list/i);
});

test('a non-numeric budget exits 2 rather than being coerced', () => {
  const r = run(['enrich', 'x.csv', '--budget', 'lots']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--budget must be a number/);
});

test('a missing suppression store exits 5 and names the fix', (t) => {
  const ws = trackedTmp('cli-nosup-');
  fs.writeFileSync(path.join(ws, 'l.csv'), 'first_name,company_domain\nA,acme.example\n');
  const r = run(['enrich', 'l.csv', '--dry-run'], { cwd: ws });
  assert.equal(r.status, 5, `expected exit 5, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /failing closed/i);
  assert.match(r.stderr, /setup/, 'the error must say how to fix it');
});

test('a missing input file exits 2', (t) => {
  const tree = makeGtmTree({ prefix: 'cli-noinput-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  const r = run(['enrich', 'does-not-exist.csv', '--dry-run'], { cwd: tree.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /input list not found/i);
});

test('a missing API key is one clear error, not one failure per row', (t) => {
  const tree = makeGtmTree({ prefix: 'cli-tty-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  fs.writeFileSync(path.join(tree.root, 'l.csv'),
    'first_name,last_name,company_domain,linkedin_url\nAda,L,acme.example,https://linkedin.com/in/ada\n');

  // Before the fix this ran the waterfall and reported "3 units failed" — once per
  // row — because MissingApiKey was thrown per call and caught as a unit failure.
  const env = { ...process.env };
  delete env.richapi_API_KEY;
  const r = run(['enrich', 'l.csv', '--budget', '500', '--yes'], { cwd: tree.root, env, input: '' });
  assert.equal(r.status, 4, `expected exit 4 (no API key), got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /richapi_API_KEY is not set/);
  assert.match(r.stderr, /--dry-run/, 'the error must name the free alternative');
  assert.ok(!/units attempted/.test(r.stdout), 'a missing key must not look like row failures');
});

// ---------------------------------------------------------------------------
// The commands that should always work
// ---------------------------------------------------------------------------

test('help, gates and preflight work with no project and no key', () => {
  const ws = trackedTmp('cli-bare-');
  const help = run(['help'], { cwd: ws });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /richapi enrich/);
  assert.match(help.stdout, /--dry-run/);

  const gates = run(['gates', 'session_budget.fractions.stop'], { cwd: ws });
  assert.equal(gates.status, 0);
  assert.equal(gates.stdout.trim(), '1');

  const pre = run(['preflight'], { cwd: ws });
  assert.equal(pre.status, 0, 'preflight must never block');
  assert.match(pre.stdout, /^CATALOG_OK: yes$/m, 'the catalog ships with the package');
});

test('a dry run from a clean project spends nothing and exits 0', (t) => {
  const tree = makeGtmTree({ prefix: 'cli-dry-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  fs.writeFileSync(path.join(tree.root, 'l.csv'),
    'first_name,last_name,company_domain,linkedin_url\nAda,L,acme.example,https://linkedin.com/in/ada\n');

  const env = { ...process.env };
  delete env.richapi_API_KEY;
  const r = run(['enrich', 'l.csv', '--dry-run'], { cwd: tree.root, env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ZERO calls made/);
  assert.match(r.stdout, /TOTAL:/);
  assert.equal(fs.existsSync(path.join(tree.root, 'gtm', 'api-calls.jsonl')), false,
    'a dry run must not write a ledger');
});
