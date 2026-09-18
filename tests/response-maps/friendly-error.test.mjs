/**
 * A waterfall 400 already carries the fix, and this client used to bin it.
 *
 * handler.py:2729-2758 pre-validates the input shape before spending anything and, on
 * failure, returns a `claude_friendly_error` body carrying `how_to_fix`,
 * `accepted_input_shapes` and `example_request`. Unconditionally. For every caller.
 * `post()` turned that into `HttpError(400)` and dropped the body.
 *
 * This pack has already paid for that exact class of failure once: the
 * `linkedin_url` -> `url` mapping divergence cost a full 500-row run, and the server
 * was saying which field name it wanted on every single call.
 *
 * The split under test:
 *
 *   HUMAN   `err.hint` / `err.message` — rich, multi-line, names the fields and shows
 *           a working example. Read by a person at a terminal.
 *   RECORD  the journal line — still the SAFE_TOKEN `http_400` and nothing else.
 *           `_lib/journal.mjs:213-217` refuses free text because "a message can carry
 *           a contact", and that refusal must stay unreachable from here.
 *
 * And the threat that makes the split necessary: an error body may ECHO the request,
 * and the request carries contacts. Every string lifted out is checked against the
 * payload we just sent.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RichApiClient, httpErrorFor, extractRemediation, renderRemediation, ECHO_REDACTED,
} from '../../_lib/client.mjs';
import { HttpError, RunJournal, runWaterfall, readJournal, sanitizeLine, JournalContractError } from '../../_lib/journal.mjs';

/** The literal body handler.py + claude_friendly_error produce for a bad email_finder. */
const FRIENDLY_400 = Object.freeze({
  error: 'Missing required input. Provide one of the following field combinations so the waterfall can call at least one provider.',
  accepted_input_shapes: [
    { provider: 'provider_b', required_fields: ['first_name', 'last_name', 'domain'] },
    { provider: 'provider_c', required_fields: ['linkedin_url'] },
  ],
  status: 400,
  how_to_fix: 'Send one of: first_name+last_name+domain, linkedin_url. See `example_input` on the catalog entry for a concrete payload.',
  example_request: { first_name: 'Satya', last_name: 'Nadella', domain: 'microsoft.com' },
});

function erroringClient (status, body, { retryAfter = null } = {}) {
  return new RichApiClient({
    apiKey: 'k',
    env: {},
    fetchImpl: () => Promise.resolve({
      ok: false,
      status,
      headers: { get: (h) => (h === 'retry-after' ? retryAfter : null) },
      json: () => Promise.resolve(body),
    }),
  });
}

// ---------------------------------------------------------------------------
// the human half
// ---------------------------------------------------------------------------

test('a friendly 400 reaches the human with the fix in it', async () => {
  const err = await erroringClient(400, FRIENDLY_400).post('email_finder', { email: 'x@y.com' })
    .then(() => null, (e) => e);

  assert.ok(err instanceof HttpError, 'the error path stopped throwing HttpError');
  assert.equal(err.status, 400);

  // The three things the server sent, all of them present for the reader.
  assert.match(err.hint, /first_name\+last_name\+domain/);
  assert.match(err.hint, /linkedin_url/);
  assert.match(err.hint, /Satya/, 'the working example did not survive');
  assert.match(err.hint, /microsoft\.com/);
  assert.match(err.hint, /Missing required input/);
  assert.match(err.hint, /email_finder/, 'the hint did not name the endpoint that refused');

  // And the message a bare `throw` or a log statement would show.
  assert.match(err.message, /^http_400: /);
  assert.match(err.message, /Send one of/);
});

test('the OLD behaviour is preserved for a 400 with nothing to say', async () => {
  const err = await erroringClient(400, { error: 'Invalid JSON' }).post('email_finder', {})
    .then(() => null, (e) => e);
  assert.equal(err.status, 400);
  assert.equal(err.remediation.error, 'Invalid JSON');

  const bare = await erroringClient(400, null).post('email_finder', {}).then(() => null, (e) => e);
  assert.equal(bare.remediation, null);
  assert.equal(bare.hint, null);
  assert.equal(bare.message, 'http_400', 'a bodyless 400 grew a message it has nothing to fill with');
});

test('the body is still on the error, unmodified', async () => {
  const err = await erroringClient(400, FRIENDLY_400).post('email_finder', {}).then(() => null, (e) => e);
  assert.deepEqual(err.body, FRIENDLY_400, 'the raw body was mutated on the way past');
});

// ---------------------------------------------------------------------------
// law 7 — the echo
// ---------------------------------------------------------------------------

test('an error body that echoes the request never repeats the contact back', () => {
  const payload = {
    linkedin_url: 'https://www.linkedin.com/in/jane-quarterly-9911',
    first_name: 'Jane',
    last_name: 'Quarterly',
    email: 'jane.quarterly@northwind-partners.example',
  };
  // A server that helpfully quotes what you sent. This is the shape law 7 exists for.
  const echoing = {
    error: 'Unrecognised field `linkedin_url` for input https://www.linkedin.com/in/jane-quarterly-9911',
    how_to_fix: 'This endpoint wants `url`, not `linkedin_url`.',
    accepted_input_shapes: [{ required_fields: ['url'] }],
    example_request: { url: 'https://www.linkedin.com/in/jane-quarterly-9911' },
  };

  const rem = extractRemediation(echoing, payload);
  const rendered = renderRemediation(rem, { endpoint: 'enrich_profile', status: 400 });
  const haystack = `${JSON.stringify(rem)}\n${rendered}`;

  for (const secret of Object.values(payload)) {
    assert.ok(!haystack.includes(secret),
      `the contact value ${JSON.stringify(secret)} was echoed straight back into a human-facing string`);
  }
  assert.ok(haystack.includes(ECHO_REDACTED), 'the echo was dropped silently instead of marked');
  // The part that is genuinely useful — the field NAME — still survives the scrub.
  assert.match(rendered, /wants `url`, not `linkedin_url`/);
  assert.match(rendered, /Accepted input shapes: url/);
});

test('only four server-authored keys are ever lifted out of a body', () => {
  const hostile = {
    error: 'nope',
    how_to_fix: 'do this',
    accepted_input_shapes: [{ required_fields: ['url'] }],
    example_request: { url: 'https://example.com' },
    // Everything below is NOT on the allowlist and must be dropped unread.
    request: { email: 'leak@contact.example' },
    echo: 'leak@contact.example',
    debug: { headers: { 'x-api-key': 'live-key-do-not-leak' } },
    trace: ['leak@contact.example'],
    detail: 'contact: +1 415 555 2671',
    message: 'we could not find leak@contact.example',
  };
  const rem = extractRemediation(hostile, {});
  const dump = JSON.stringify(rem) + renderRemediation(rem, {});
  for (const forbidden of ['leak@contact.example', 'live-key-do-not-leak', '555 2671', 'x-api-key']) {
    assert.ok(!dump.includes(forbidden), `an unallowlisted key carried ${forbidden} through`);
  }
  assert.deepEqual(Object.keys(rem).sort(),
    ['accepted_input_shapes', 'error', 'example_request', 'how_to_fix']);
});

test('accepted_input_shapes contributes FIELD NAMES, never values', () => {
  const rem = extractRemediation({
    accepted_input_shapes: [
      { provider: 'a-vendor-we-do-not-name', required_fields: ['first_name', 'last_name'], sample: { first_name: 'Jane' } },
    ],
  }, {});
  assert.deepEqual(rem.accepted_input_shapes, [['first_name', 'last_name']]);
  const dump = JSON.stringify(rem);
  assert.ok(!dump.includes('Jane'), 'a sample VALUE rode in on a shape');
  assert.ok(!dump.includes('a-vendor-we-do-not-name'), 'the shape carried more than field names');
});

test('a verbose body cannot become an unbounded terminal dump', () => {
  const rem = extractRemediation({
    error: 'x'.repeat(50_000),
    how_to_fix: 'y'.repeat(50_000),
    accepted_input_shapes: Array.from({ length: 200 }, (_, i) => ({ required_fields: [`f${i}`] })),
    example_request: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i])),
  }, {});
  assert.ok(rem.error.length <= 410);
  assert.ok(rem.how_to_fix.length <= 410);
  assert.ok(rem.accepted_input_shapes.length <= 8);
  assert.ok(Object.keys(rem.example_request).length <= 12);
});

// ---------------------------------------------------------------------------
// the persisted half — a contact must never reach the journal
// ---------------------------------------------------------------------------

test('the journal still records the token, and the contact is not in the file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-journal-'));
  const journal = new RunJournal({ runId: 'g3run', dir });

  const CONTACT = 'jane.quarterly@northwind-partners.example';
  const PROFILE = 'https://www.linkedin.com/in/jane-quarterly-9911';

  // The real thing: a client whose 400 body echoes the caller's contact, run through
  // the real runWaterfall and the real RunJournal.
  const api = erroringClient(400, {
    error: `No provider accepted ${CONTACT}`,
    how_to_fix: 'This endpoint wants `url`, not `linkedin_url`.',
    accepted_input_shapes: [{ required_fields: ['url'] }],
    example_request: { url: PROFILE },
  });

  const client = {
    call: ({ endpoint }) => api.post(endpoint, { linkedin_url: PROFILE, email: CONTACT }),
  };

  const res = await runWaterfall({
    journal,
    units: [{ row_id: 'row-1', hop: 0, endpoint: 'enrich_profile', credits_estimated: 1 }],
    client,
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });
  assert.equal(res.failed, 1);

  const { lines } = readJournal(journal.path);
  const after = lines.find(l => l.status === 'failed');
  assert.equal(after.error, 'http_400',
    'the journal recorded something other than the machine code — law 7');

  const raw = fs.readFileSync(journal.path, 'utf8');
  for (const secret of [CONTACT, PROFILE, 'jane', 'Quarterly', 'northwind']) {
    assert.ok(!raw.toLowerCase().includes(secret.toLowerCase()),
      `the journal file contains ${JSON.stringify(secret)}`);
  }
  // Nor did the rich text get in by any other route.
  assert.ok(!/how_to_fix|Accepted input shapes|example/i.test(raw),
    'remediation prose reached the persisted record');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the journal contract still refuses a rich message outright', async () => {
  // The boundary this change had to respect, asserted directly: even if a future caller
  // tried to journal the hint, journal.mjs stops it.
  const err = await erroringClient(400, FRIENDLY_400).post('email_finder', {}).then(() => null, (e) => e);
  assert.throws(
    () => sanitizeLine({
      run_id: 'r', row_id: 'row-1', hop: 0, endpoint: 'email_finder',
      status: 'failed', error: err.hint,
    }),
    (e) => e instanceof JournalContractError && /never a message/.test(e.message),
  );
});

// ---------------------------------------------------------------------------
// the type contract — 402 and 429 handling must not notice any of this
// ---------------------------------------------------------------------------

test('a 402 still aborts the run and still yields its balance', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-402-'));
  const journal = new RunJournal({ runId: 'g3402', dir });
  const api = erroringClient(402, { error: 'Insufficient credits', balance: 12, reserved: '5' });

  const res = await runWaterfall({
    journal,
    units: [
      { row_id: 'r1', hop: 0, endpoint: 'email_finder', credits_estimated: 5 },
      { row_id: 'r2', hop: 0, endpoint: 'email_finder', credits_estimated: 5 },
    ],
    client: { call: ({ endpoint }) => api.post(endpoint, {}) },
    maxAttempts: 1,
    sleep: () => Promise.resolve(),
  });

  assert.equal(res.aborted, true);
  assert.equal(res.abort_reason, 'insufficient_credits');
  assert.equal(res.balance, 12, 'the 402 body stopped being readable');
  assert.equal(res.skipped_budget, 1);

  const { lines } = readJournal(journal.path);
  assert.ok(lines.some(l => l.error === 'http_402'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a 429 still carries Retry-After and still retries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-429-'));
  const journal = new RunJournal({ runId: 'g3429', dir });
  const api = erroringClient(429, { error: 'Rate limited' }, { retryAfter: '3' });

  const slept = [];
  const res = await runWaterfall({
    journal,
    units: [{ row_id: 'r1', hop: 0, endpoint: 'email_finder', credits_estimated: 5 }],
    client: { call: ({ endpoint }) => api.post(endpoint, {}) },
    maxAttempts: 3,
    sleep: (ms) => { slept.push(ms); return Promise.resolve(); },
  });

  assert.equal(res.retries, 2);
  assert.deepEqual(slept, [3000, 3000], 'Retry-After stopped reaching the backoff');
  const { lines } = readJournal(journal.path);
  assert.ok(lines.every(l => l.status !== 'failed' || l.error === 'http_429'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('httpErrorFor is still an HttpError with the three fields callers read', () => {
  const err = httpErrorFor(429, { body: { error: 'slow down' }, retryAfter: 7, endpoint: 'email_finder', payload: {} });
  assert.ok(err instanceof HttpError);
  assert.equal(err.name, 'HttpError');
  assert.equal(err.status, 429);
  assert.equal(err.retryAfter, 7);
  assert.deepEqual(err.body, { error: 'slow down' });
});

test('a network failure is untouched by any of this', async () => {
  const client = new RichApiClient({
    apiKey: 'k', env: {}, fetchImpl: () => Promise.reject(new Error('ECONNREFUSED')),
  });
  const err = await client.post('email_finder', {}).then(() => null, (e) => e);
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 0);
  assert.equal(err.code, 'network_error');
});
