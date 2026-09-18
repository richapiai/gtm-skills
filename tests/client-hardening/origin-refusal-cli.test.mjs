// tests/client-hardening/origin-refusal-cli.test.mjs
//
// THE ORIGIN REFUSAL HAS TO READ LIKE A REFUSAL.
//
// `tests/client-hardening/origin-guard.test.mjs` proves the control: a non-https or
// non-allowlisted `richapi_API_ORIGIN` throws `UnsafeOrigin` and nothing is sent. This
// file covers the half that a user actually experiences.
//
// It reached the terminal as an UNCAUGHT exception. The message is carefully worded
// ("Nothing was sent. There is NO fallback"), and it arrived buried under a `throw`
// line, a caret, six stack frames and `Node.js v26.8.1` — which reads as a crash in the
// pack, not as the pack protecting the key. Worse, those frames carry absolute paths
// including the user's home directory, and this is exactly the output someone pastes
// into a public issue when a tool "crashes".
//
// So: the control is unchanged and still uncaught inside _lib/client.mjs. The CLI
// boundary catches it for PRESENTATION only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { trackedTmp } from '../helpers/index.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'bin', 'richapi.mjs');

function workspace () {
  const root = trackedTmp('origin-cli-');
  const r = spawnSync(process.execPath, [join(REPO, 'setup.mjs'), '--root', root, '--no-sweep'],
    { encoding: 'utf8' });
  assert.equal(r.status, 0, `setup failed:\n${r.stdout}${r.stderr}`);
  const list = join(root, 'leads.csv');
  writeFileSync(list, 'email\nada@example.com\n');
  return { gtm: join(root, 'gtm'), list };
}

const runWithOrigin = (origin, extraEnv = {}) => {
  const { gtm, list } = workspace();
  return spawnSync(process.execPath,
    [BIN, 'enrich', list, '--yes', '--budget', '5', '--dir', gtm],
    {
      encoding: 'utf8',
      env: { ...process.env, richapi_API_KEY: 'sk-must-never-be-sent', richapi_API_ORIGIN: origin, ...extraEnv },
    });
};

test('a plaintext origin is refused as a message, not as a stack trace', () => {
  const r = runWithOrigin('http://evil.tld');
  const all = `${r.stdout}${r.stderr}`;

  assert.equal(r.status, 2, 'a refused configuration exits 2');
  assert.match(all, /REFUSED/);
  assert.match(all, /Nothing was sent/);
  assert.match(all, /NO fallback/);
});

test('the refusal carries no stack trace and no internal paths', () => {
  const all = (() => { const r = runWithOrigin('http://evil.tld'); return `${r.stdout}${r.stderr}`; })();

  assert.doesNotMatch(all, /^\s+at /m, 'a stack frame reached the user');
  assert.doesNotMatch(all, /\bthrow new\b/, 'the source line reached the user');
  assert.doesNotMatch(all, /Node\.js v\d/, 'the node crash footer reached the user');
  assert.doesNotMatch(all, /_lib\/client\.mjs/, 'an internal path reached the user');
  assert.doesNotMatch(all, /file:\/\//, 'a file URL reached the user');
});

test('the key never appears in the output, whatever happens', () => {
  const r = runWithOrigin('http://evil.tld');
  const all = `${r.stdout}${r.stderr}`;
  assert.doesNotMatch(all, /sk-must-never-be-sent/,
    'the refusal echoed the credential it exists to protect');
});

test('an https origin that is not allowlisted is refused the same way', () => {
  const r = runWithOrigin('https://not-allowlisted.example');
  const all = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2);
  assert.match(all, /REFUSED/);
  assert.doesNotMatch(all, /^\s+at /m);
});

test('credentials embedded in the origin are refused without echoing them', () => {
  const r = runWithOrigin('https://user:hunter2@api.richapi.ai');
  const all = `${r.stdout}${r.stderr}`;
  assert.equal(r.status, 2);
  assert.doesNotMatch(all, /hunter2/, 'the refusal printed the embedded password');
});

test('a dry run makes zero calls even with a key set and an unreachable origin', () => {
  // The strongest available proof that --dry-run does not touch the network: point it
  // at a closed port with a key present. A single call would fail the run.
  const { gtm, list } = workspace();
  const r = spawnSync(process.execPath, [BIN, 'enrich', list, '--dry-run', '--dir', gtm], {
    encoding: 'utf8',
    env: {
      ...process.env,
      richapi_API_KEY: 'sk-must-never-be-sent',
      richapi_API_ORIGIN: 'https://127.0.0.1:1',
      richapi_ALLOW_CUSTOM_ORIGIN: '127.0.0.1',
    },
  });
  assert.equal(r.status, 0, `dry run did not survive an unreachable origin:\n${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /no calls made/i);
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /sk-must-never-be-sent/);
});
