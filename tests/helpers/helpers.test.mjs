// Self-tests for the shared test substrate.
//
// The catalog, cost, dry-run, ledger, balance and setup suites build their
// assertions on these helpers. A helper that quietly reports "0 calls" when it never ran, or a
// validator that passes everything, would make every downstream suite green
// and meaningless. These tests exist so that cannot happen unnoticed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { makeGtmTree, withGtmTree, liveTreeCount } from './tmp-tree.mjs';
import { createFakeHttp, createThrowingHttp, ZeroCallViolation, UnexpectedCallError } from './fake-http.mjs';
import { insufficientCredits, tooManyRequests, okJson, usage } from './responses.mjs';
import { validate, assertValidJsonSchema, SchemaSupportError } from './schema.mjs';
import { parseYaml, YamlError } from './yaml.mjs';

// --------------------------------------------------------------- tmp-tree
test('makeGtmTree builds an isolated gtm/ tree and cleans it up', () => {
  const before = liveTreeCount();
  const tree = makeGtmTree({ files: { 'gtm/runs/r1.jsonl': [{ row_id: 'a' }, { row_id: 'b' }] } });
  assert.equal(liveTreeCount(), before + 1);
  assert.ok(existsSync(tree.gtm));
  for (const d of ['runs', 'enrichment-cache', 'lists', 'exports']) assert.ok(existsSync(tree.gtmPath(d)), `gtm/${d} exists`);
  assert.deepEqual(tree.readJsonl('gtm/runs/r1.jsonl'), [{ row_id: 'a' }, { row_id: 'b' }]);
  assert.deepEqual(tree.list('gtm'), ['runs/r1.jsonl']);
  const root = tree.root;
  tree.cleanup();
  assert.equal(existsSync(root), false);
  assert.equal(liveTreeCount(), before);
});

test('withGtmTree registers cleanup on the test context', async (t) => {
  let captured;
  await t.test('inner', (t2) => {
    const tree = withGtmTree(t2, { files: { 'gtm/api-calls.jsonl': [{ endpoint: 'email_finder' }] } });
    captured = tree.root;
    assert.ok(existsSync(captured));
  });
  assert.equal(existsSync(captured), false, 'tree removed when the subtest finished');
});

test('tmp tree refuses paths that escape it', () => {
  const tree = makeGtmTree();
  t: try { tree.path('..', 'evil'); assert.fail('should have thrown'); } catch (e) { assert.match(e.message, /escapes the temp tree/); }
  tree.cleanup();
});

test('makeGtmTree({git:true}) yields a real repo with gtm/ ignored', () => {
  const tree = makeGtmTree({ git: true });
  tree.write('gtm/lists/people.csv', 'email\na@b.com\n');
  const status = tree.git('status', '--porcelain');
  assert.equal(status.includes('gtm/'), false, 'gtm/ is gitignored, so it must not appear in status');
  tree.cleanup();
});

// -------------------------------------------------------------- fake-http
test('fake http records url, method, headers and parsed body', async () => {
  const http = createFakeHttp({ routes: [['email_finder', okJson({ email: 'a@b.com', provider: 'p1', confidence: 0.9 })]] });
  const res = await http.fetch('https://api.richapi.ai/api/v1/email_finder', {
    method: 'POST',
    headers: { 'x-api-key': 'k' },
    body: JSON.stringify({ first_name: 'Ada' })
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: 'a@b.com', provider: 'p1', confidence: 0.9 });
  assert.equal(http.callCount, 1);
  assert.deepEqual(http.calledEndpoints(), ['email_finder']);
  assert.equal(http.calls[0].method, 'POST');
  assert.equal(http.calls[0].headers['x-api-key'], 'k');
  assert.deepEqual(http.calls[0].body, { first_name: 'Ada' });
  assert.equal(http.callsTo('email_finder').length, 1);
});

test('an unrouted call throws instead of silently returning 200', async () => {
  const http = createFakeHttp();
  await assert.rejects(() => http.fetch('https://api.richapi.ai/api/v1/phone_finder', { method: 'POST' }), UnexpectedCallError);
});

test('createThrowingHttp proves the zero-call claim', async () => {
  const http = createThrowingHttp('--dry-run must make zero calls');
  await assert.rejects(
    () => http.fetch('https://api.richapi.ai/api/v1/phone_finder', { method: 'POST' }),
    (err) => {
      assert.ok(err instanceof ZeroCallViolation);
      assert.match(err.message, /--dry-run must make zero calls/);
      assert.match(err.message, /phone_finder/);
      return true;
    }
  );
  // The attempt is still recorded, so a failure message can name the offender.
  assert.deepEqual(http.calledEndpoints(), ['phone_finder']);
});

test('assertNoCalls names the calls that broke the promise', async () => {
  const http = createFakeHttp({ fallback: okJson({}) });
  http.assertNoCalls();
  await http.fetch('https://api.richapi.ai/api/v1/phone_finder', { method: 'POST' });
  assert.throws(() => http.assertNoCalls('dry run'), /dry run — but 1 were made: POST phone_finder/);
});

test('queue is FIFO and routes win over the queue', async () => {
  const http = createFakeHttp({ queue: [okJson({ n: 1 }), okJson({ n: 2 })], routes: [[/phone_finder/, okJson({ routed: true })]] });
  assert.deepEqual(await (await http.fetch('/api/v1/email_finder')).json(), { n: 1 });
  assert.deepEqual(await (await http.fetch('/api/v1/phone_finder')).json(), { routed: true });
  assert.deepEqual(await (await http.fetch('/api/v1/email_verifier')).json(), { n: 2 });
});

// ------------------------------------------------------------- responses
test('402 carries reserved and balance AS STRINGS, matching the real API', async () => {
  const res = insufficientCredits({ balance: 2.5, reserved: 5 });
  assert.equal(res.status, 402);
  assert.equal(res.ok, false);
  const body = await res.json();
  assert.deepEqual(body, { error: 'Insufficient credits', reserved: '5', balance: '2.5' });
  assert.equal(typeof body.balance, 'string', 'a ledger that assumes a number will mis-read the free balance refresh');
});

test('429 carries Retry-After, case-insensitively readable', async () => {
  const res = tooManyRequests({ retryAfter: 12 });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('Retry-After'), '12');
  assert.equal(res.headers.get('retry-after'), '12');
  assert.deepEqual(await res.json(), { error: 'Too Many Requests' });
});

test('usage response matches the shape documented in the spec', async () => {
  const body = await usage().json();
  assert.deepEqual(Object.keys(body).sort(), ['apis', 'months', 'total_credits']);
  assert.equal(body.apis.enrich_profile.credits, 25);
});

test('response bodies are cloned, so one test cannot mutate another', async () => {
  const res = okJson({ nested: { v: 1 } });
  const a = await res.json();
  a.nested.v = 99;
  assert.equal((await res.json()).nested.v, 1);
});

// ---------------------------------------------------------------- schema
test('validator enforces type, required, enum, const, pattern and $ref', () => {
  const schema = {
    type: 'object',
    required: ['a', 'b'],
    properties: {
      a: { const: 1 },
      b: { enum: ['x', 'y'] },
      c: { type: ['string', 'null'], pattern: '^[a-f0-9]{4}$' },
      d: { $ref: '#/$defs/pos' }
    },
    $defs: { pos: { type: 'integer', minimum: 0 } }
  };
  assert.equal(validate(schema, { a: 1, b: 'x', c: 'ab12', d: 3 }).valid, true);
  assert.equal(validate(schema, { a: 1 }).valid, false, 'missing required');
  assert.equal(validate(schema, { a: 2, b: 'x' }).valid, false, 'const mismatch');
  assert.equal(validate(schema, { a: 1, b: 'z' }).valid, false, 'enum mismatch');
  assert.equal(validate(schema, { a: 1, b: 'x', c: 'zz' }).valid, false, 'pattern mismatch');
  assert.equal(validate(schema, { a: 1, b: 'x', c: null }).valid, true, 'null allowed by type union');
  assert.equal(validate(schema, { a: 1, b: 'x', d: -1 }).valid, false, '$ref minimum enforced');
});

test('validator enforces format: date-time assertively', () => {
  const s = { type: 'string', format: 'date-time' };
  assert.equal(validate(s, '2026-08-28T12:00:00Z').valid, true);
  assert.equal(validate(s, '2026-08-28T12:00:00.123+02:00').valid, true);
  assert.equal(validate(s, '2026-08-28').valid, false);
  assert.equal(validate(s, 'yesterday').valid, false);
});

test('validator enforces additionalProperties:false', () => {
  const s = { type: 'object', properties: { a: {} }, additionalProperties: false };
  assert.equal(validate(s, { a: 1 }).valid, true);
  assert.equal(validate(s, { a: 1, b: 2 }).valid, false);
});

test('errors carry a JSON-pointer-ish path', () => {
  const { errors } = validate({ type: 'object', properties: { a: { type: 'number' } } }, { a: 'nope' });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, '/a');
});

test('assertValidJsonSchema refuses a keyword the validator does not enforce', () => {
  assert.throws(
    () => assertValidJsonSchema({ type: 'string', contentEncoding: 'base64' }, 'x'),
    (e) => e instanceof SchemaSupportError && /contentEncoding/.test(e.message)
  );
});

test('assertValidJsonSchema refuses a dangling $ref and a bad regex', () => {
  assert.throws(() => assertValidJsonSchema({ $ref: '#/$defs/nope' }, 'x'), SchemaSupportError);
  assert.throws(() => assertValidJsonSchema({ type: 'string', pattern: '([' }, 'x'), SchemaSupportError);
});

// ------------------------------------------------------------------ yaml
test('yaml parser handles the constructs the spec actually uses', () => {
  const doc = parseYaml([
    'openapi: 3.1.0',
    'info:',
    '  title: RichAPI API',
    '  version: 1.0.0',
    'paths:',
    '  /email_finder:',
    '    post:',
    '      operationId: email_finder',
    '      description: Find a verified work email using name, domain, or LinkedIn URL.',
    '        Tries multiple providers automatically.',
    '      tags:',
    '        - Enrichment',
    '      requestBody:',
    '        required: false',
    '      responses:',
    '        "200":',
    '          example:',
    '            confidence: example',
    '            tags: []',
    '            meta: {}',
    '      security:',
    '        - API Key: []',
    '      x-pricing:',
    '        credits_per_call: 5'
  ].join('\n'));

  assert.equal(doc.openapi, '3.1.0');
  assert.equal(doc.info.version, '1.0.0', 'a version like 1.0.0 must stay a string');
  const op = doc.paths['/email_finder'].post;
  assert.equal(op.description, 'Find a verified work email using name, domain, or LinkedIn URL. Tries multiple providers automatically.');
  assert.deepEqual(op.tags, ['Enrichment']);
  assert.equal(op.requestBody.required, false);
  assert.deepEqual(op.responses['200'].example, { confidence: 'example', tags: [], meta: {} });
  assert.deepEqual(op.security, [{ 'API Key': [] }]);
  assert.equal(op['x-pricing'].credits_per_call, 5);
  assert.equal(typeof op['x-pricing'].credits_per_call, 'number', 'credit values must be numbers, not strings');
});

test('yaml parser handles folded and literal block scalars with chomping', () => {
  const doc = parseYaml([
    'folded: >-',
    '  line one',
    '  line two',
    'literal: |-',
    '  a',
    '  b'
  ].join('\n'));
  assert.equal(doc.folded, 'line one line two');
  assert.equal(doc.literal, 'a\nb');
});

test('yaml parser handles multi-line double-quoted scalars', () => {
  const doc = parseYaml([
    'description: "Date range: last-30-days, current-month,',
    '  or custom-date-range"'
  ].join('\n'));
  assert.equal(doc.description, 'Date range: last-30-days, current-month, or custom-date-range');
});

test('yaml parser REFUSES unsupported constructs instead of guessing', () => {
  assert.throws(() => parseYaml('a: &anchor 1\nb: *anchor\n'), YamlError);
  assert.throws(() => parseYaml('---\na: 1\n---\nb: 2\n'), YamlError);
  assert.throws(() => parseYaml('a: 1\na: 2\n'), /duplicate mapping key/);
  assert.throws(() => parseYaml('a:\n\tb: 1\n'), /tab character/);
});

test('yaml parser keeps 0.5 a number and 4XX a string', () => {
  const doc = parseYaml('credits: 0.5\nstatus: 4XX\nmonth: 2026-03\nflag: true\nempty:\n');
  assert.equal(doc.credits, 0.5);
  assert.equal(doc.status, '4XX');
  assert.equal(doc.month, '2026-03');
  assert.equal(doc.flag, true);
  assert.equal(doc.empty, null);
});
