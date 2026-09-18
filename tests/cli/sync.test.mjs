// The rebuilt absorption orchestrator.
//
// An earlier sync fetched the MCP tool list and AUTO-COMMITTED the result, which is
// how a price increase reaches main with nobody looking. That is one of the five gaps
// the plan names, so the headline test here is that this thing cannot commit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SYNC = path.join(REPO, 'bin', 'richapi-skills-sync.mjs');

const run = (args) => spawnSync(process.execPath, [SYNC, ...args], { encoding: 'utf8', cwd: REPO });

test('sync cannot commit, push, or otherwise mutate git', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  // Exact source check, because "it does not commit" is the whole point of the rewrite.
  for (const forbidden of ['git commit', 'git push', 'git add', 'git config']) {
    assert.ok(!src.includes(forbidden), `sync must never run \`${forbidden}\``);
  }
  assert.match(src, /never commits/i, 'and it should say so, for whoever reads it next');
});

test('it targets openapi.yaml, not the MCP tool list', () => {
  const src = fs.readFileSync(SYNC, 'utf8');
  // Check CODE, not prose: the header comment explains what the old sync did, and
  // naming the thing you removed is not the same as still using it.
  const code = src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/tools\/list/.test(code), 'the MCP tool list is no longer the source of truth');
  assert.ok(!/mcp-catalog\.json/.test(code));
  assert.match(src, /catalog-gen/);
  assert.match(src, /catalog-diff/);
  assert.match(src, /owners-check/);
});

test('a clean tree exits 0 and says so', () => {
  const r = run(['--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /clean — no blocking changes/);
});

test('--json is machine-readable and reports every step', () => {
  const r = run(['--check', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.blocking, false);
  assert.equal(out.failed, false);
  assert.deepEqual(out.steps.map(s => s.label), ['catalog-gen', 'catalog-diff', 'owners-check']);
  assert.ok(out.steps.every(s => typeof s.status === 'number'));
});

test('--help explains the exit codes without running anything', () => {
  const help = execFileSync(process.execPath, [SYNC, '--help'], { encoding: 'utf8', cwd: REPO });
  assert.match(help, /Exit: 0 clean/);
  assert.match(help, /NEVER commits/);
});
