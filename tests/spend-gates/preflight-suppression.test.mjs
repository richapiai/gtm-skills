// The PII wiring in bin/richapi-skills-preflight: the SUPPRESSION key and the
// PII cache sweep. Both are guarded on file existence, so the script must be
// correct with the PII modules absent AND with them present.
//
// So every case builds a throwaway ROOT — a copy of the preflight script
// plus a stand-in _lib/ — and runs the real script against it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { trackedTmp } from '../helpers/index.mjs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REAL_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REAL_PREFLIGHT = join(REAL_ROOT, 'bin', 'richapi-skills-preflight');

/**
 * A throwaway ROOT containing the real preflight script and a stand-in _lib/.
 * `suppression` / `pii` are module source strings; omit one to leave it absent.
 */
function fakeRoot ({ suppression = null, pii = null } = {}) {
  const root = trackedTmp('spend-gates-sup-');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, '_lib'), { recursive: true });
  copyFileSync(REAL_PREFLIGHT, join(root, 'bin', 'richapi-skills-preflight'));
  writeFileSync(join(root, 'VERSION'), readFileSync(join(REAL_ROOT, 'VERSION')));
  if (suppression !== null) writeFileSync(join(root, '_lib', 'suppression.mjs'), suppression, 'utf8');
  if (pii !== null) writeFileSync(join(root, '_lib', 'pii.mjs'), pii, 'utf8');

  // no network in tests: curl always fails
  const bin = join(root, 'shim');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'curl'), '#!/bin/sh\nexit 22\n', 'utf8');
  chmodSync(join(bin, 'curl'), 0o755);
  return { root, shimBin: bin };
}

function run ({ root, shimBin }, env = {}) {
  const home = trackedTmp('spend-gates-sup-home-');
  const started = Date.now();
  const out = execFileSync('bash', [join(root, 'bin', 'richapi-skills-preflight')], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, PATH: `${shimBin}:${process.env.PATH}`, richapi_SKILLS_HOME: home, ...env }
  });
  const keys = {};
  for (const line of out.trim().split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) keys[m[1]] = m[2];
  }
  return { out, keys, ms: Date.now() - started, home };
}

// ---------------------------------------------------------------------------

test('SUPPRESSION is STOP when the PII modules are absent — a check we could not run is not a pass', () => {
  const { keys } = run(fakeRoot());          // no _lib/suppression.mjs at all
  assert.equal(keys.SUPPRESSION, 'STOP');
});

test('the real preflight fails CLOSED against a workspace with no suppression store', () => {
  // HERMETIC. This used to run the real preflight in the ambient repo and assert the
  // repo had no gtm/suppression.jsonl — so running `./setup`, the FIRST STEP IN THE
  // README, turned the suite red. The 397 depended on the developer never having
  // followed the docs. What the test is really about is fail-closed behaviour for a
  // KNOWN-missing store, so it now builds one and points the preflight at it.
  const home = trackedTmp('spend-gates-sup-real-');
  const workspace = trackedTmp('spend-gates-sup-ws-');       // a workspace with no gtm/
  const out = execFileSync('bash', [REAL_PREFLIGHT], {
    encoding: 'utf8', timeout: 30000, cwd: workspace,
    env: { ...process.env, richapi_SKILLS_HOME: home }
  });
  assert.match(out, /^SUPPRESSION: STOP$/m);

  // And the STOP is the REAL fail-closed answer from suppressionStatus(),
  // not the module-missing fallback — the module ships with the package.
  assert.ok(existsSync(join(REAL_ROOT, '_lib', 'suppression.mjs')),
    'the suppression module ships with the package');
  assert.ok(!existsSync(join(workspace, 'gtm', 'suppression.jsonl')),
    'the workspace under test genuinely has no store, which is why STOP is correct');
});

test('SUPPRESSION is OK once suppressionStatus() says so', () => {
  for (const body of [
    'export const suppressionStatus = () => "OK";',
    'export const suppressionStatus = () => true;',
    'export const suppressionStatus = async () => ({ ok: true });',
    'export const suppressionStatus = async () => ({ status: "ok", entries: 12 });'
  ]) {
    const { keys } = run(fakeRoot({ suppression: body }));
    assert.equal(keys.SUPPRESSION, 'OK', `suppressionStatus returning ${body} was not read as OK`);
  }
});

test('anything that is not a clear OK reads as STOP', () => {
  for (const body of [
    'export const suppressionStatus = () => "STOP";',
    'export const suppressionStatus = () => false;',
    'export const suppressionStatus = () => ({ status: "degraded" });',
    'export const suppressionStatus = () => null;',
    'export const suppressionStatus = () => { throw new Error("list unreadable"); };',
    'export const somethingElse = () => "OK";',                 // wrong export
    'this is not valid javascript ((('                          // module will not load
  ]) {
    const { keys } = run(fakeRoot({ suppression: body }));
    assert.equal(keys.SUPPRESSION, 'STOP', `"${body.slice(0, 40)}..." was not read as STOP`);
  }
});

test('a hanging suppressionStatus() times out to STOP and does not wedge preflight', () => {
  const { keys, ms } = run(fakeRoot({
    suppression: 'export const suppressionStatus = () => new Promise(() => {});'
  }));
  assert.equal(keys.SUPPRESSION, 'STOP');
  assert.ok(ms < 10000, `preflight blocked for ${ms}ms on a hanging suppression check`);
});

test('the PII cache sweep is called, in the background, and never gates the run', async () => {
  const marker = join(trackedTmp('spend-gates-sweep-'), 'swept');
  const fixture = fakeRoot({
    suppression: 'export const suppressionStatus = () => "OK";',
    pii: `import { writeFileSync } from 'node:fs';
          export async function sweepEnrichmentCache () {
            writeFileSync(${JSON.stringify(marker)}, 'swept', 'utf8');
          }`
  });
  const { keys } = run(fixture);
  assert.equal(keys.SUPPRESSION, 'OK');
  for (let i = 0; i < 60 && !existsSync(marker); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(marker), 'sweepEnrichmentCache() was never called');
});

test('a throwing or slow sweep cannot affect the emitted keys', () => {
  const fixture = fakeRoot({
    suppression: 'export const suppressionStatus = () => "OK";',
    pii: `export async function sweepEnrichmentCache () {
            await new Promise(r => setTimeout(r, 30000));
            throw new Error('boom');
          }`
  });
  const { keys, ms } = run(fixture);
  assert.equal(keys.SUPPRESSION, 'OK');
  assert.equal(keys.BALANCE, 'unknown');
  assert.ok(ms < 10000, `a slow sweep blocked preflight for ${ms}ms`);
});

test('SUPPRESSION is emitted before the UPGRADE early-exit', () => {
  const fixture = fakeRoot({ suppression: 'export const suppressionStatus = () => "OK";' });
  const home = trackedTmp('spend-gates-sup-order-');
  writeFileSync(join(home, '.upgrade-cache'),
    `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n${readFileSync(join(REAL_ROOT, 'VERSION'), 'utf8').trim()}\n`, 'utf8');
  const out = execFileSync('bash', [join(fixture.root, 'bin', 'richapi-skills-preflight')], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, PATH: `${fixture.shimBin}:${process.env.PATH}`, richapi_SKILLS_HOME: home }
  });
  assert.match(out, /^SUPPRESSION: OK$/m);
  assert.match(out, /^UPGRADE: none$/m);
  assert.ok(out.indexOf('SUPPRESSION:') < out.indexOf('UPGRADE:'));
});
