// `richapi call` and `richapi search` as a user meets them.
//
// The module tests prove the guarantees; these prove the CLI is a faithful, thin
// wrapper over them: the arguments parse, the exit codes are the documented contract,
// and the free path (`--dry-run`) works with no API key and no project.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeGtmTree, trackedTmp } from '../helpers/index.mjs';
import { ensureSuppressionStore } from '../../_lib/suppression.mjs';
import { parseArgs, parseParams } from '../../bin/richapi.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(REPO, 'bin', 'richapi.mjs');

function run (args, opts = {}) {
  const env = { ...process.env, ...(opts.env ?? {}) };
  delete env.richapi_API_KEY;   // the free paths must not need one
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts, env });
}

function project (t, { rows = null } = {}) {
  const tree = makeGtmTree({ prefix: 's8-cli-' });
  t.after(() => tree.cleanup());
  ensureSuppressionStore(tree.root);
  if (rows) {
    const header = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    fs.writeFileSync(path.join(tree.root, 'l.csv'),
      [header.join(','), ...rows.map((r) => header.map((h) => r[h] ?? '').join(','))].join('\n') + '\n');
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

test('--param is repeatable, and the old forms still parse', () => {
  const a = parseArgs(['call', 'email_finder', '--param', 'first_name=Ada', '--param=last_name=L', '--dry-run']);
  assert.deepEqual(a._, ['call', 'email_finder']);
  assert.deepEqual(a.flags.param, ['first_name=Ada', 'last_name=L'],
    'a request body has more than one field — last-one-wins silently dropped the rest');
  assert.equal(a.flags.dry_run, true);

  // Nothing about the pre-existing surface may change.
  const b = parseArgs(['enrich', 'list.csv', '--dry-run', '--out', 'x.csv', '--budget=50', '--phone']);
  assert.deepEqual(b._, ['enrich', 'list.csv']);
  assert.equal(b.flags.out, 'x.csv');
  assert.equal(b.flags.budget, '50');
  const c = parseArgs(['enrich', '--no-cache', 'list.csv']);
  assert.deepEqual(c._, ['enrich', 'list.csv'], 'a boolean flag must not swallow a positional');
});

test('a param value keeps its type, and JSON is opt-in', () => {
  const p = parseParams(['title=CTO', 'limit=25', 'page=0', 'verified=true', 'filters:=["a","b"]', 'q=a=b']);
  assert.equal(p.title, 'CTO');
  assert.equal(p.limit, 25, 'limit and page are numbers in every search endpoint');
  assert.equal(p.page, 0);
  assert.equal(p.verified, true);
  assert.deepEqual(p.filters, ['a', 'b']);
  assert.equal(p.q, 'a=b', 'only the FIRST = separates key from value');

  assert.throws(() => parseParams(['nokey']), /is not key=value/);
  assert.throws(() => parseParams(['x:={bad']), /not valid JSON/);
});

// ---------------------------------------------------------------------------
// The free paths
// ---------------------------------------------------------------------------

test('`call --dry-run` needs no API key, spends nothing, and prints a plan', (t) => {
  const tree = project(t, {
    rows: [
      { first_name: 'Ada', last_name: 'L', company_domain: 'acme.example', linkedin_url: 'https://linkedin.com/in/ada' },
      { first_name: 'Bob', last_name: 'M', company_domain: 'b.example', linkedin_url: 'https://linkedin.com/in/bob' },
    ],
  });

  const r = run(['call', 'enrich_profile', '--in', 'l.csv', '--dry-run'], { cwd: tree.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ZERO calls made/);
  assert.match(r.stdout, /TOTAL:\s+2 credits/);
  assert.match(r.stdout, /batching\s+OFF/, 'the batching decision is always reported');
  assert.equal(fs.existsSync(path.join(tree.root, 'gtm', 'api-calls.jsonl')), false,
    'a dry run must not write a ledger');
});

test('`search --dry-run` prices every page and names the page gate', (t) => {
  const tree = project(t);
  const r = run(['search', 'people_search', '--param', 'title=CTO', '--param', 'limit=25', '--pages', '3', '--dry-run'],
    { cwd: tree.root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ZERO calls made/);
  assert.match(r.stdout, /3 calls/);
  assert.match(r.stdout, /ceiling/, 'a search total is a ceiling, not a promise');
});

test('help documents both new verbs', () => {
  const ws = trackedTmp('s8-help-');
  const r = run(['help'], { cwd: ws });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /richapi call <endpoint>/);
  assert.match(r.stdout, /richapi search <endpoint>/);
  assert.match(r.stdout, /--param/);
});

// ---------------------------------------------------------------------------
// Exit codes — each is a documented contract
// ---------------------------------------------------------------------------

test('no endpoint exits 2', () => {
  const r = run(['call']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs an endpoint name/);
});

test('an unknown endpoint exits 2 rather than being POSTed blind', (t) => {
  const tree = project(t);
  const r = run(['call', 'not_an_endpoint', '--param', 'x=1', '--dry-run'], { cwd: tree.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not in the catalog/);
});

test('a bad --param exits 2 before anything is planned', (t) => {
  const tree = project(t);
  const r = run(['call', 'email_verifier', '--param', 'nonsense', '--dry-run'], { cwd: tree.root });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /is not key=value/);
});

test('a disabled endpoint exits 3 (blocked), not 0', (t) => {
  // Nothing ships disabled, so run a copy of the package whose catalog disables one.
  const pkg = trackedTmp('s8-cli-pkg-');
  for (const d of ['bin', '_lib']) fs.cpSync(path.join(REPO, d), path.join(pkg, d), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(pkg, 'package.json'));
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(pkg, 'node_modules'));
  const catFile = path.join(pkg, '_lib', 'api-catalog.json');
  const cat = JSON.parse(fs.readFileSync(catFile, 'utf8'));
  cat.endpoints.post_keyword_search.pricing.disabled_by_default = true;
  cat.endpoints.post_keyword_search.pricing.disabled_reason = 'test: disabled in the catalog';
  fs.writeFileSync(catFile, JSON.stringify(cat));

  const tree = project(t);
  const args = ['search', 'post_keyword_search', '--param', 'keyword=x', '--dry-run'];
  const r = spawnSync(process.execPath, [path.join(pkg, 'bin', 'richapi.mjs'), ...args],
    { encoding: 'utf8', cwd: tree.root, env: { ...process.env, richapi_API_KEY: '' } });
  assert.equal(r.status, 3, `expected 3, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /disabled_by_default/);

  // The shipped catalog enables it: the same dry run is not blocked.
  const shipped = run(args, { cwd: tree.root });
  assert.equal(shipped.status, 0, `expected 0, got ${shipped.status}: ${shipped.stderr}`);
});

test('a missing suppression store exits 5 and names the fix', () => {
  const ws = trackedTmp('s8-nosup-');
  const r = run(['call', 'email_verifier', '--param', 'email=a@b.example', '--dry-run'], { cwd: ws });
  assert.equal(r.status, 5, `expected 5, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /failing closed/i);
  assert.match(r.stderr, /setup/);
});

test('a real run with no API key exits 4, not one failure per row', (t) => {
  const tree = project(t, { rows: [{ email: 'ada@acme.example' }, { email: 'bob@acme.example' }] });
  const r = run(['call', 'email_verifier', '--in', 'l.csv', '--budget', '500', '--yes'],
    { cwd: tree.root, input: '' });
  assert.equal(r.status, 4, `expected 4, got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /richapi_API_KEY is not set/);
  assert.ok(!/units attempted/.test(r.stdout), 'a missing key must not look like row failures');
});

test('a plan needing approval on a non-TTY exits 7 and spends nothing', (t) => {
  const tree = project(t);
  // 8 pages of an unbounded endpoint: the page gate confirms, and there is no TTY.
  const r = run(['search', 'people_search', '--param', 'title=CTO', '--param', 'limit=25',
    '--pages', '8', '--budget', '500'], { cwd: tree.root, input: '' });
  assert.equal(r.status, 7, `expected 7 (not approved), got ${r.status}: ${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /--dry-run/, 'the refusal must name the free alternative');
  assert.equal(fs.existsSync(path.join(tree.root, 'gtm', 'api-calls.jsonl')), false);
});

test('--json emits a machine-readable result', (t) => {
  const tree = project(t, { rows: [{ email: 'ada@acme.example' }] });
  const r = run(['call', 'email_verifier', '--in', 'l.csv', '--dry-run', '--json'], { cwd: tree.root });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.mode, 'dry-run');
  assert.equal(parsed.endpoint, 'email_verifier');
  assert.equal(parsed.calls_made, 0);
  assert.ok(parsed.plan.totals.credits_estimated >= 0);
});
