// The drift check must never wedge anything.
//
// THE REQUIREMENT THIS FILE EXISTS FOR
//
//   `scripts/ci-local.sh` is run offline routinely and states "network NONE" in its own
//   header. A gate that turns a missing network into a red build gets deleted inside a
//   week, and then it protects nothing. So every way the live catalog can fail to
//   arrive — no DNS, refused connection, a server that accepts and never answers, a
//   server that answers headers and stalls mid-body, a 5xx, a 401, HTML instead of
//   JSON, a truncated payload — must SKIP with a loud message and exit 0.
//
//   None of this is asserted against the real api.richapi.ai. Every case is driven by a
//   local `node:http` server or an unbound port, so the suite behaves identically on a
//   plane and in CI.
//
// The blocking half of the contract is in catalog-drift.test.mjs; this file only proves
// the check cannot be the reason a build stops.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { fetchLiveCatalog } from '../../bin/richapi-catalog-drift.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CLI = path.join(ROOT, 'bin', 'richapi-catalog-drift.mjs');
const PINNED = path.join(HERE, 'fixtures', 'pinned-baseline.json');

/** Run the CLI and return {code, stdout, stderr} without throwing on a non-zero exit. */
async function run(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      timeout: 60_000,
      ...opts,
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Start a local server with the given handler; returns its URL and a stop(). */
async function serve(handler) {
  const sockets = new Set();
  const server = http.createServer(handler);
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/catalog`;
  return {
    url,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A port nothing is listening on: the closest thing to "no network" that is portable. */
async function deadPort() {
  const s = await serve(() => {});
  const { url } = s;
  await s.stop();
  return url;
}

const SKIP_BANNER = /catalog drift {2}SKIPPED/;
const NOT_A_FAILURE = /No network is not a failure/;

// --- no network -----------------------------------------------------------------

test('a refused connection SKIPS, says so, and exits 0', async () => {
  const url = await deadPort();
  const r = await run(['--pinned', PINNED, '--url', url, '--timeout', '3000']);
  assert.equal(r.code, 0, `offline must not wedge CI; stdout:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, SKIP_BANNER);
  assert.match(r.stdout, NOT_A_FAILURE);
  // "unknown" is not a reason. The operator must be able to tell an outage from a bug.
  assert.match(r.stdout, /reason: .*(ECONNREFUSED|fetch failed|connect)/i);
});

test('an unresolvable host SKIPS and exits 0', async () => {
  const r = await run([
    '--pinned', PINNED,
    '--url', 'https://catalog.invalid.richapi-drift-test/api/v1/catalog',
    '--timeout', '5000',
  ]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, SKIP_BANNER);
});

test('the skip is honest — it says drift is UNKNOWN, never that there is none', async () => {
  const url = await deadPort();
  const r = await run(['--pinned', PINNED, '--url', url, '--timeout', '3000']);
  assert.match(r.stdout, /drift is simply UNKNOWN on this run, not absent/);
  assert.ok(!/No blocking drift/.test(r.stdout), 'a skip must not be reported as a clean run');
});

// --- a server that hangs ----------------------------------------------------------

test('a server that accepts and never answers is bounded by --timeout, not by CI', async () => {
  const s = await serve(() => {
    /* accept the socket, write nothing, ever */
  });
  try {
    const t0 = Date.now();
    const r = await run(['--pinned', PINNED, '--url', s.url, '--timeout', '400']);
    const elapsed = Date.now() - t0;
    assert.equal(r.code, 0);
    assert.match(r.stdout, SKIP_BANNER);
    assert.match(r.stdout, /timed out after 400ms/);
    // Generous: the assertion is "it returns", not "it returns in exactly 400ms".
    // Node process startup dominates. Without the bound this test never finishes.
    assert.ok(elapsed < 30_000, `took ${elapsed}ms — the deadline did not fire`);
  } finally {
    await s.stop();
  }
});

test('a server that sends 200 headers and then stalls mid-body is ALSO bounded', async () => {
  // The abort timer has to survive past the headers. Clearing it as soon as the
  // response object exists — which is the obvious way to write this — leaves a slow
  // body able to hang for as long as the server likes, and that is the shape of hang
  // that actually happens in the wild.
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '9999' });
    res.write('{"tools":');
    // and never finish
  });
  try {
    const t0 = Date.now();
    const r = await run(['--pinned', PINNED, '--url', s.url, '--timeout', '400']);
    const elapsed = Date.now() - t0;
    assert.equal(r.code, 0);
    assert.match(r.stdout, SKIP_BANNER);
    assert.ok(elapsed < 30_000, `took ${elapsed}ms — the deadline did not cover the body read`);
  } finally {
    await s.stop();
  }
});

// --- a server that answers badly ---------------------------------------------------

test('a 5xx SKIPS with the status in the reason — an outage is not drift', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(503);
    res.end('upstream down');
  });
  try {
    const r = await run(['--pinned', PINNED, '--url', s.url, '--timeout', '5000']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /reason: HTTP 503/);
  } finally {
    await s.stop();
  }
});

test('a 401 SKIPS rather than reporting "no drift" — losing access is losing sight', async () => {
  // The catalog is public today. If it ever stops being public, the check must degrade
  // to "cannot see", never to "nothing changed".
  const s = await serve((_req, res) => {
    res.writeHead(401);
    res.end('{"error":"unauthorized"}');
  });
  try {
    const r = await run(['--pinned', PINNED, '--url', s.url, '--timeout', '5000']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /reason: HTTP 401/);
    assert.ok(!/No blocking drift/.test(r.stdout));
  } finally {
    await s.stop();
  }
});

test('an HTML error page instead of JSON SKIPS', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>502 Bad Gateway</body></html>');
  });
  try {
    const r = await run(['--pinned', PINNED, '--url', s.url, '--timeout', '5000']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /not JSON/);
  } finally {
    await s.stop();
  }
});

test('a truncated catalog SKIPS instead of blocking on fabricated removals', async () => {
  const s = await serve((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tools: [{ name: 'ai_enrich', api_path: 'ai_enrich', pricing: { credits_per_call: 2 } }], total: 68 }));
  });
  try {
    const r = await run(['--pinned', PINNED, '--url', s.url, '--timeout', '5000']);
    assert.equal(r.code, 0, 'a short read must not be read as nine endpoints disappearing');
    assert.match(r.stdout, /truncated/);
  } finally {
    await s.stop();
  }
});

// --- no API key -------------------------------------------------------------------

test('no Authorization header is ever sent — the catalog is public', async () => {
  let seen = null;
  const s = await serve((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tools: [], total: 0 }));
  });
  try {
    await run(['--pinned', PINNED, '--url', s.url, '--timeout', '5000']);
    assert.ok(seen, 'the server was never reached');
    assert.equal(seen.authorization, undefined);
    assert.equal(seen['x-api-key'], undefined);
    assert.equal(seen.accept, 'application/json');
  } finally {
    await s.stop();
  }
});

test('an API key in the environment changes nothing', async () => {
  let seen = null;
  const s = await serve((req, res) => {
    seen = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ tools: [], total: 0 }));
  });
  try {
    await run(['--pinned', PINNED, '--url', s.url, '--timeout', '5000'], {
      env: { ...process.env, RICHAPI_API_KEY: 'sk-should-never-be-sent' },
    });
    assert.ok(seen);
    for (const v of Object.values(seen)) {
      assert.ok(!String(v).includes('sk-should-never-be-sent'), 'the key leaked into a header');
    }
  } finally {
    await s.stop();
  }
});

// --- the strict opt-out ------------------------------------------------------------

test('--require-network turns a skip into a failure, for callers that want it', async () => {
  const url = await deadPort();
  const lax = await run(['--pinned', PINNED, '--url', url, '--timeout', '3000']);
  const strict = await run(['--pinned', PINNED, '--url', url, '--timeout', '3000', '--require-network']);
  assert.equal(lax.code, 0);
  assert.equal(strict.code, 1);
  assert.match(strict.stdout, /--require-network was given, so this is a failure/);
});

test('--warn-only never exits non-zero, even on a real blocker', async () => {
  const drifted = path.join(HERE, 'fixtures', 'live-real-drift.json');
  const blocking = await run(['--pinned', PINNED, '--live', drifted]);
  const warnOnly = await run(['--pinned', PINNED, '--live', drifted, '--warn-only']);
  assert.equal(blocking.code, 1);
  assert.equal(warnOnly.code, 0);
  assert.match(warnOnly.stdout, /BLOCK REMOVED_UNMAPPED/, 'the report must still name the blocker');
});

// --- everything else that could wedge a build ---------------------------------------

test('--help never touches the network and exits 0', async () => {
  const t0 = Date.now();
  const r = await run(['--help', '--url', 'https://catalog.invalid.richapi-drift-test/']);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - t0 < 20_000);
  assert.match(r.stdout, /richapi-catalog-drift/);
});

test('an unreadable pinned catalog IS a failure — that is a repo bug, not an outage', async () => {
  const r = await run(['--pinned', path.join(HERE, 'fixtures', 'does-not-exist.json'), '--live', path.join(HERE, 'fixtures', 'live-baseline.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read pinned catalog/);
});

test('--json is parseable on both the drift path and the skip path', async () => {
  const drifted = await run(['--pinned', PINNED, '--live', path.join(HERE, 'fixtures', 'live-real-drift.json'), '--json']);
  const parsed = JSON.parse(drifted.stdout);
  assert.equal(parsed.skipped, false);
  assert.equal(parsed.exit_code, 1);
  assert.deepEqual(parsed.blocking, [{ class: 'REMOVED_UNMAPPED', endpoint: 'profile_social_metrics' }]);
  assert.ok(Array.isArray(parsed.not_compared.billing_field_present_in_response));

  const url = await deadPort();
  const skipped = await run(['--pinned', PINNED, '--url', url, '--timeout', '3000', '--json']);
  const s = JSON.parse(skipped.stdout);
  assert.equal(s.skipped, true);
  assert.equal(s.exit_code, 0);
  assert.equal(typeof s.reason, 'string');
});

test('fetchLiveCatalog returns its error rather than throwing it', async () => {
  // Nothing above this in the call chain has a try/catch it can rely on; a throw here
  // is a wedged build.
  const url = await deadPort();
  const r = await fetchLiveCatalog({ url, timeoutMs: 2000 });
  assert.equal(r.payload, null);
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.length > 0);
});

test('a mistyped --live path FAILS — a silent pass from a typo is the worst outcome', async () => {
  const r = await run(['--pinned', PINNED, '--live', path.join(HERE, 'fixtures', 'typo.json')]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot read --live/);
});
