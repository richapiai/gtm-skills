// Verify criteria for the preflight balance check:
//   - emits `BALANCE: unknown` when /usage is absent
//   - a 402 populates it for free
//   - preflight NEVER blocks on it

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { trackedTmp } from '../helpers/index.mjs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { Ledger, writeBalanceCache } from '../../_lib/ledger.mjs';

// The balance cache is SCOPED TO THE API KEY (see _lib/ledger.mjs:balanceCachePath).
// A machine-global file crossed the per-book-of-business boundary LIMITATIONS.md §6
// promises, and survived a key change. Tests compute the same path rather than
// hardcoding a name, so the scoping rule has exactly one definition.
import { createHash } from 'node:crypto';
function balCache (dir, key) {
  if (!key) return join(dir, '.balance-cache-nokey');
  return join(dir, `.balance-cache-${createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`);
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PREFLIGHT = join(ROOT, 'bin', 'richapi-skills-preflight');

// The stable, ADD-ONLY preflight key contract.
// JQ_MISSING added 2026-09-02 (2A). The contract is ADD-ONLY, so a new key is a
// compatible change and a renamed one is not. It exists because a missing jq used to
// degrade CATALOG_OK to `no`, which reads as a broken catalog and sent every skill to a
// fix that could not work; the fact now has its own key and the checks it gates report
// `unknown` instead of `no`.
const KEYS = ['CATALOG_OK', 'CATALOG_AGE', 'CATALOG_STALE', 'CATALOG_TOOLS',
  'FILTERS_OK', 'API_KEY_SET', 'SKILLS_VERSION', 'NET', 'UPGRADE', 'BALANCE',
  'SUPPRESSION', 'JQ_MISSING'];

const tmp = () => trackedTmp('spend-gates-preflight-');

/**
 * A PATH shim so no test ever touches the network: `curl` logs its args and
 * fails, which is also exactly the "endpoint unreachable" case.
 */
function shimBin (dir, { curlBody = null } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'curl.log');
  const body = curlBody === null
    ? 'exit 22'
    : `printf '%s' ${JSON.stringify(curlBody)}`;
  writeFileSync(join(bin, 'curl'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n${body}\n`, 'utf8');
  chmodSync(join(bin, 'curl'), 0o755);
  return { bin, log };
}

function runPreflight (env = {}, { shim = null } = {}) {
  const PATH = shim ? `${shim.bin}:${process.env.PATH}` : process.env.PATH;
  const started = Date.now();
  const out = execFileSync('bash', [PREFLIGHT], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, PATH, ...env }
  });
  return { out, ms: Date.now() - started, keys: parseKeys(out) };
}

function parseKeys (out) {
  const o = {};
  for (const line of out.trim().split('\n')) {
    const m = line.match(/^([A-Z_]+):\s*(.*)$/);
    if (m) o[m[1]] = m[2];
  }
  return o;
}

// ---------------------------------------------------------------------------

test('BALANCE is emitted, and the key contract stays add-only', () => {
  const dir = tmp();
  const { keys } = runPreflight({ richapi_SKILLS_HOME: dir }, { shim: shimBin(dir) });
  for (const k of KEYS) assert.ok(k in keys, `preflight dropped the ${k} key`);
  assert.equal(Object.keys(keys).length, KEYS.length, `preflight emits keys outside the contract: ${Object.keys(keys)}`);
});

test('emits `BALANCE: unknown` when /usage is absent', () => {
  const dir = tmp();
  const shim = shimBin(dir);                      // curl always fails
  const { keys } = runPreflight({ richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' }, { shim });
  assert.equal(keys.BALANCE, 'unknown');
});

test('emits `BALANCE: unknown` with no API key at all — and never calls /usage', () => {
  const dir = tmp();
  const shim = shimBin(dir);
  const env = { ...process.env };
  delete env.richapi_API_KEY;
  const { keys } = runPreflight({ ...env, richapi_SKILLS_HOME: dir, richapi_API_KEY: '' }, { shim });
  assert.equal(keys.BALANCE, 'unknown');
  assert.equal(keys.API_KEY_SET, 'no');
  const log = existsSync(shim.log) ? readFileSync(shim.log, 'utf8') : '';
  assert.ok(!log.includes('/usage'), 'called /usage without an API key');
});

test('a 402 populates BALANCE for free — the ledger writes the cache preflight reads', () => {
  const dir = tmp();
  process.env.richapi_SKILLS_HOME = dir;
  // The cache is keyed by the API key, so the write must happen under the same key the
  // read will use — which is what production does: a 402 only arrives on a call made
  // with a key. Without this the ledger would write one account's file and preflight
  // would read another's, which is precisely the cross-account bleed the scoping fixes.
  process.env.richapi_API_KEY = 'k';
  const led = new Ledger({ dir: join(dir, 'gtm') });
  const r = led.recordInsufficientCredits({
    endpoint: 'phone_finder',
    body: { error: 'Insufficient credits', reserved: '25', balance: '2.5' }
  });
  assert.equal(r.line.credits_actual, 0, 'the 402 that taught us the balance cost nothing');
  delete process.env.richapi_SKILLS_HOME;
  delete process.env.richapi_API_KEY;

  const shim = shimBin(dir);                      // network still dead
  const { keys } = runPreflight({ richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' }, { shim });
  assert.equal(keys.BALANCE, '2.5');
  const log = existsSync(shim.log) ? readFileSync(shim.log, 'utf8') : '';
  assert.ok(!log.includes('/usage'), 'the 402-sourced balance was fresh; /usage should not have been called');
});

test('/usage is called at most once per TTL', async () => {
  const dir = tmp();
  const shim = shimBin(dir, { curlBody: '{"balance": 314.5}' });
  const env = { richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' };

  // No cache -> first run backgrounds a refresh and still answers `unknown`.
  const first = runPreflight(env, { shim });
  assert.equal(first.keys.BALANCE, 'unknown', 'the first run must not block waiting for /usage');

  // Wait for the backgrounded refresh to land.
  const cachePath = balCache(dir, 'k');
  for (let i = 0; i < 60 && !existsSync(cachePath); i++) await new Promise(r => setTimeout(r, 50));
  assert.ok(existsSync(cachePath), 'the background refresh never wrote the cache');
  assert.match(readFileSync(cachePath, 'utf8'), /314\.5/);
  assert.match(readFileSync(cachePath, 'utf8'), /usage_endpoint/);

  const callsAfterFirst = (readFileSync(shim.log, 'utf8').match(/\/usage/g) || []).length;
  assert.equal(callsAfterFirst, 1);

  // Second run inside the TTL answers from cache and calls nothing.
  const second = runPreflight(env, { shim });
  assert.equal(second.keys.BALANCE, '314.5');
  const callsAfterSecond = (readFileSync(shim.log, 'utf8').match(/\/usage/g) || []).length;
  assert.equal(callsAfterSecond, 1, '/usage was called twice inside the 1h TTL');
});

test('a stale cache still answers with the last known value and refreshes behind it', () => {
  const dir = tmp();
  const stale = new Date(Date.now() - 6 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  writeFileSync(balCache(dir, 'k'), `${stale}\n88\nusage_endpoint\n`, 'utf8');
  const shim = shimBin(dir, { curlBody: '{"balance": 99}' });
  const { keys } = runPreflight({ richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' }, { shim });
  assert.equal(keys.BALANCE, '88', 'a stale value is still better than unknown, and must not block');
});

test('a corrupt cache reads as unknown, not as a number', () => {
  for (const junk of ['not-a-number', '', '1.2.3', '-5x']) {
    const dir = tmp();
    writeFileSync(balCache(dir, 'k'),
      `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n${junk}\n402_body\n`, 'utf8');
    const { keys } = runPreflight({ richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' }, { shim: shimBin(dir) });
    assert.equal(keys.BALANCE, 'unknown', `junk cache value ${JSON.stringify(junk)} was emitted as a balance`);
  }
});

test('BALANCE never blocks preflight: exits 0, fast, with every other key intact', () => {
  const dir = tmp();
  // curl hangs for longer than any TTL; preflight must not wait for it.
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // Hang ONLY on /usage — the pre-existing NET probe also shells out to curl
  // and its own --max-time is what bounds that one.
  writeFileSync(join(bin, 'curl'),
    '#!/bin/sh\ncase "$*" in *usage*) sleep 30 ;; *) exit 22 ;; esac\n', 'utf8');
  chmodSync(join(bin, 'curl'), 0o755);

  const started = Date.now();
  const out = execFileSync('bash', [PREFLIGHT], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' }
  });
  const ms = Date.now() - started;
  const keys = parseKeys(out);
  assert.ok(ms < 10000, `preflight blocked for ${ms}ms on a hanging /usage`);
  assert.equal(keys.BALANCE, 'unknown');
  for (const k of KEYS) assert.ok(k in keys, `${k} was lost while BALANCE degraded`);
  assert.equal(keys.SKILLS_VERSION, readFileSync(join(ROOT, 'VERSION'), 'utf8').trim());
});

test('BALANCE survives the UPGRADE cache early-exit path', () => {
  const dir = tmp();
  // A fresh upgrade cache makes the upgrade block `exit 0` — BALANCE must
  // already have been emitted by then.
  writeFileSync(join(dir, '.upgrade-cache'),
    `${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}\n2.0.0-alpha.0\n`, 'utf8');
  writeBalanceCache(41, '402_body', balCache(dir, 'k'));
  const { keys, out } = runPreflight({ richapi_SKILLS_HOME: dir, richapi_API_KEY: 'k' }, { shim: shimBin(dir) });
  assert.equal(keys.BALANCE, '41');
  assert.equal(keys.UPGRADE, 'none');
  assert.ok(out.indexOf('BALANCE:') < out.indexOf('UPGRADE:'), 'BALANCE must be emitted before the UPGRADE early-exit');
});
