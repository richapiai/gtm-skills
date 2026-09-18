/**
 * The API key went onto `curl`'s argv on every stale balance preflight.
 *
 *   curl -fsS --max-time 3 -H "x-api-key: $richapi_API_KEY" "$API_ORIGIN/api/v1/usage"
 *
 * Arguments are world-readable in `ps auxww`, so any other local user could read the
 * live key. It fired hourly (BALANCE_TTL=3600) in the background behind every skill
 * invocation, which is roughly the worst possible duty cycle for that exposure.
 *
 * CREDIT WHERE DUE, AND DO NOT REGRESS IT. The key is handled correctly everywhere
 * else in this script: `API_KEY_SET: yes|no` prints a boolean and never the value,
 * and the key appears in no journal, ledger, receipt or error. The tests at the
 * bottom pin that down so the fix above cannot quietly undo it.
 *
 * Also here: the same origin rule as _lib/client.mjs. This curl sends the key to
 * $API_ORIGIN, which richapi_API_ORIGIN used to point anywhere over any scheme.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { trackedTmp } from '../helpers/tmp-tree.mjs';

// The balance cache is SCOPED TO THE API KEY (see _lib/ledger.mjs:balanceCachePath).
// A machine-global file crossed the per-book-of-business boundary LIMITATIONS.md §6
// promises, and survived a key change. Tests compute the same path rather than
// hardcoding a name, so the scoping rule has exactly one definition.
import { createHash } from 'node:crypto';
function balCache (dir, key) {
  if (!key) return join(dir, '.balance-cache-nokey');
  return join(dir, `.balance-cache-${createHash('sha256').update(String(key)).digest('hex').slice(0, 16)}`);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFLIGHT = join(ROOT, 'bin', 'richapi-skills-preflight');

/** A key that is unmistakable in any output, and that exercises curl-config quoting. */
const KEY = 'sk-live-SECRET-do-not-leak-9f3a';

/**
 * A curl shim that records ARGV and STDIN separately. That separation is the whole
 * test: the header must be in one and never in the other.
 */
function shim (dir, { body = '{"balance": 42}' } = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const argvLog = join(dir, 'curl.argv');
  const stdinLog = join(dir, 'curl.stdin');
  writeFileSync(join(bin, 'curl'), [
    '#!/bin/sh',
    `echo "$@" >> ${JSON.stringify(argvLog)}`,
    // Only the /usage call is given a config on stdin; the NET probe is not, and
    // reading stdin there would block. Gate on the argument we can see.
    'case "$*" in',
    `  *--config*) cat >> ${JSON.stringify(stdinLog)} ;;`,
    'esac',
    `case "$*" in`,
    `  */usage*) printf '%s' ${JSON.stringify(body)} ;;`,
    '  *) exit 22 ;;',
    'esac',
  ].join('\n') + '\n', 'utf8');
  chmodSync(join(bin, 'curl'), 0o755);
  return { bin, argvLog, stdinLog };
}

function run (env = {}, sh = null) {
  const PATH = sh ? `${sh.bin}:${process.env.PATH}` : process.env.PATH;
  // spawnSync, not execFileSync: the refusal goes to STDERR on a SUCCESSFUL exit, and
  // execFileSync only hands stderr back when the child fails.
  const r = spawnSync('bash', [PREFLIGHT], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, PATH, richapi_API_ORIGIN: '', richapi_ALLOW_CUSTOM_ORIGIN: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw r.error;
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.status };
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

/** The refresh is backgrounded on purpose; wait for it to land. */
async function settle (path) {
  for (let i = 0; i < 80 && !existsSync(path); i += 1) {
    await new Promise((r) => { setTimeout(r, 50); });
  }
}

// ---------------------------------------------------------------------------

test('the API key is never passed to curl as an argument', async () => {
  const dir = trackedTmp('f4-preflight-argv-');
  const sh = shim(dir);
  run({ richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY }, sh);
  await settle(balCache(dir, KEY));

  const argv = read(sh.argvLog);
  assert.ok(argv.includes('/usage'), `/usage was never called; argv log was:\n${argv}`);
  assert.ok(!argv.includes(KEY), `the API key is in curl's argv (ps auxww):\n${argv}`);
  assert.ok(!/x-api-key/i.test(argv), `the x-api-key header is in curl's argv:\n${argv}`);
  assert.ok(!/\s-H\s/.test(argv), `a -H flag is back on the /usage call:\n${argv}`);
});

test('the key IS delivered, on stdin, so the fix is not a silent 401 machine', async () => {
  const dir = trackedTmp('f4-preflight-stdin-');
  const sh = shim(dir);
  run({ richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY }, sh);
  await settle(balCache(dir, KEY));

  const stdin = read(sh.stdinLog);
  assert.match(stdin, /--config|header/, `curl received no config on stdin:\n${stdin}`);
  assert.ok(stdin.includes(`x-api-key: ${KEY}`), `the header did not reach curl at all:\n${stdin}`);
  // And the call actually worked end to end.
  assert.match(read(balCache(dir, KEY)), /42/);
});

test('a key containing a quote or a backslash still produces a valid header', async () => {
  // curl's config format is `name = "value"`; an unescaped " would truncate the
  // header and produce a mystery 401 instead of a balance.
  const awkward = 'sk-live-a"b\\c-9f3a';
  const dir = trackedTmp('f4-preflight-quote-');
  const sh = shim(dir);
  run({ richapi_SKILLS_HOME: dir, richapi_API_KEY: awkward }, sh);
  await settle(balCache(dir, KEY));

  const stdin = read(sh.stdinLog);
  assert.match(stdin, /^header = "x-api-key: sk-live-a\\"b\\\\c-9f3a"$/m,
    `the awkward key was not escaped for curl's config format:\n${stdin}`);
  assert.ok(!read(sh.argvLog).includes(awkward), 'the awkward key reached argv');
});

test('no other process in the pipeline carries the key on ITS argv either', async () => {
  // `printf` is a shell builtin and `sed` reads the key from a pipe. A future
  // refactor to `echo $key | ...` or `sed "s/x/$key/"` would break both.
  const src = readFileSync(PREFLIGHT, 'utf8');
  const block = src.slice(src.indexOf('# --- BALANCE -'), src.indexOf('# --- SUPPRESSION -'));
  // Comments in this block quote the old form on purpose; scan the CODE only.
  const code = block.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/-H\s+["']x-api-key/i.test(code),
    'the -H "x-api-key: $key" form is back in the balance refresh');
  assert.match(code, /--config\s+-/, 'the /usage call no longer reads its config from stdin');
  assert.ok(!/\becho\b[^\n]*richapi_API_KEY/.test(code),
    'the key is being echoed rather than printf-ed into the config');
});

// ---------------------------------------------------------------------------
// do not regress what was already right
// ---------------------------------------------------------------------------

test('API_KEY_SET still prints a boolean, never the key', () => {
  const dir = trackedTmp('f4-preflight-boolean-');
  const { stdout, stderr } = run({ richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY }, shim(dir));
  assert.match(stdout, /^API_KEY_SET: yes$/m);
  assert.ok(!stdout.includes(KEY), `preflight printed the API key on stdout:\n${stdout}`);
  assert.ok(!stderr.includes(KEY), `preflight printed the API key on stderr:\n${stderr}`);
});

test('with no key, /usage is not called at all', () => {
  const dir = trackedTmp('f4-preflight-nokey-');
  const sh = shim(dir);
  const { stdout } = run({ richapi_SKILLS_HOME: dir, richapi_API_KEY: '' }, sh);
  assert.match(stdout, /^API_KEY_SET: no$/m);
  assert.match(stdout, /^BALANCE: unknown$/m);
  assert.ok(!read(sh.argvLog).includes('/usage'), 'called /usage with no API key');
});

// ---------------------------------------------------------------------------
// The origin guard, in the shell half of the pack
// ---------------------------------------------------------------------------

test('preflight refuses to send the key to an http: origin, loudly, and skips it', () => {
  const dir = trackedTmp('f4-preflight-http-');
  const sh = shim(dir);
  const { stdout, stderr } = run(
    { richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY, richapi_API_ORIGIN: 'http://evil.tld' },
    sh,
  );
  assert.match(stderr, /REFUSED/);
  assert.match(stderr, /evil\.tld/);
  assert.match(stderr, /nothing fell back/i);
  assert.ok(!read(sh.argvLog).includes('evil.tld'), 'preflight called the hostile origin anyway');
  assert.match(stdout, /^BALANCE: unknown$/m, 'a refused origin must degrade to unknown, not to a guess');
  assert.ok(!stderr.includes(KEY), 'the refusal echoed the API key');
});

test('preflight refuses a non-default https origin without an opt-in, and honours one with', () => {
  const dir = trackedTmp('f4-preflight-optin-');
  const sh = shim(dir);
  const denied = run(
    { richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY, richapi_API_ORIGIN: 'https://evil.tld' },
    sh,
  );
  assert.match(denied.stderr, /REFUSED/);
  assert.match(denied.stderr, /richapi_ALLOW_CUSTOM_ORIGIN/);
  assert.ok(!read(sh.argvLog).includes('evil.tld'));

  const dir2 = trackedTmp('f4-preflight-optin-ok-');
  const sh2 = shim(dir2);
  const allowed = run({
    richapi_SKILLS_HOME: dir2,
    richapi_API_KEY: KEY,
    richapi_API_ORIGIN: 'https://api.selfhosted.example',
    richapi_ALLOW_CUSTOM_ORIGIN: 'api.selfhosted.example',
  }, sh2);
  assert.ok(!/REFUSED/.test(allowed.stderr), `a valid opt-in was refused:\n${allowed.stderr}`);
  assert.ok(read(sh2.argvLog).includes('api.selfhosted.example/api/v1/usage'),
    'the opted-in origin was never called');
});

test('preflight still allows a loopback origin with no opt-in', () => {
  const dir = trackedTmp('f4-preflight-loopback-');
  const sh = shim(dir);
  const { stderr } = run(
    { richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY, richapi_API_ORIGIN: 'http://127.0.0.1:8099' },
    sh,
  );
  assert.ok(!/REFUSED/.test(stderr), `loopback was refused:\n${stderr}`);
  assert.ok(read(sh.argvLog).includes('127.0.0.1:8099/api/v1/usage'));
});

test('the stdout key contract is untouched: a refusal adds no KEY: line', () => {
  // tests/spend-gates/preflight-balance.test.mjs asserts the EXACT key set. A security
  // refusal is not a status key, so it goes to stderr and the contract is unchanged.
  const dir = trackedTmp('f4-preflight-contract-');
  const clean = run({ richapi_SKILLS_HOME: dir, richapi_API_KEY: KEY }, shim(dir));
  const dir2 = trackedTmp('f4-preflight-contract2-');
  const refused = run(
    { richapi_SKILLS_HOME: dir2, richapi_API_KEY: KEY, richapi_API_ORIGIN: 'http://evil.tld' },
    shim(dir2),
  );
  const keys = (out) => out.trim().split('\n')
    .map(l => l.match(/^([A-Z_]+):\s/)).filter(Boolean).map(m => m[1]).sort();
  assert.deepEqual(keys(refused.stdout), keys(clean.stdout),
    'the refusal changed the stdout key set');
});
