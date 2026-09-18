// tests/cli/catalog-list.test.mjs
//
// `richapi catalog list` — the only user-facing catalog verb.
//
// Until it existed, a user could not see the endpoint surface at all: `doctor` said
// "Catalog loaded — 68 endpoints" and stopped, and `gen`/`diff` are maintainer tools.
// "What can this do and what does each call cost" had no answer short of reading a
// 156KB spec.
//
// The two properties that matter:
//
//   1. It prices from the LOCAL catalog, which is the same table a dry run quotes. If
//      this printed a different number from the plan, it would be worse than nothing.
//   2. It spends nothing and needs no key, in either mode. `--live` is a free,
//      unauthenticated GET, and its failure is REPORTED rather than thrown — the
//      command has to keep working on a plane.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadLocal, priceLabel, render, fetchLive } from '../../_lib/catalog-list.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(REPO, 'bin', 'richapi.mjs');
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

const catalog = JSON.parse(readFileSync(join(REPO, '_lib', 'api-catalog.json'), 'utf8'));

test('every catalog endpoint is listed, exactly once', () => {
  const rows = loadLocal();
  const names = rows.map((r) => r.name).sort();
  assert.deepEqual(names, Object.keys(catalog.endpoints).sort());
  assert.equal(new Set(names).size, names.length);
});

test('the price shown is the price the runtime would quote, never a guess', () => {
  for (const row of loadLocal()) {
    const p = catalog.endpoints[row.name].pricing;
    const per = p.credits_per_call;
    const each = p.credits_per_result;

    if (per !== null && per !== undefined) {
      assert.equal(row.price, per === 0 ? 'free' : `${per}/call`, `${row.name}`);
    } else if (each !== null && each !== undefined) {
      assert.match(row.price, new RegExp(`${each}/result`), `${row.name}`);
    } else {
      assert.equal(row.price, 'unknown',
        `${row.name}: an endpoint with no price must read "unknown", never a number`);
    }
  }
});

test('priceLabel invents nothing when pricing is absent or empty', () => {
  assert.equal(priceLabel(null), 'unknown');
  assert.equal(priceLabel(undefined), 'unknown');
  assert.equal(priceLabel({}), 'unknown');
  assert.equal(priceLabel({ credits_per_call: 0 }), 'free');
  assert.equal(priceLabel({ credits_per_result: 2, credits_base: 1 }), '1 + 2/result');
});

test('unverified shapes and unbounded endpoints are flagged, not hidden', () => {
  const rows = loadLocal();
  const unverified = rows.filter((r) => r.status === 'keys_from_spec_example');
  assert.ok(unverified.length > 0, 'expected some spec-derived shapes to still exist');
  const out = render(rows);
  for (const r of unverified) {
    const line = out.split('\n').find((l) => l.includes(r.name));
    assert.match(line, /shape unverified/, `${r.name} must be flagged as unverified`);
  }
});

test('the render says outright that nothing was spent', () => {
  const out = render(loadLocal());
  assert.match(out, /No credits were spent/);
  assert.match(out, /Add --live/, 'the offline render should point at the account view');
});

test('a live view marks endpoints the account cannot call', () => {
  const rows = loadLocal();
  const missing = rows[0].name;
  const live = new Set(rows.slice(1).map((r) => r.name));
  const out = render(rows, { live });
  const line = out.split('\n').find((l) => l.includes(missing));
  assert.match(line, /not in your account/);
  assert.match(out, /1 endpoint\(s\) are in the pinned catalog but not in your account view/);
});

test('a live fetch failure is reported, and the local table still stands', () => {
  const out = render(loadLocal(), { live: null, liveError: 'timed out' });
  assert.match(out, /live account view unavailable \(timed out\)/);
  assert.match(out, /the local table above still stands/);
  assert.equal(out.split('\n').filter((l) => l.includes('/call')).length > 10, true,
    'the endpoint table must still render when the live view fails');
});

test('fetchLive resolves rather than throwing when the host is unreachable', async () => {
  const r = await fetchLive('https://127.0.0.1:1', 1500);
  assert.equal(r.names, null);
  assert.ok(r.error, 'an unreachable host must produce an error string, not an exception');
});

// ---------------------------------------------------------------------------
// Through the real CLI
// ---------------------------------------------------------------------------

test('richapi catalog list exits 0 with no key and no network use', () => {
  const r = run('catalog', 'list');
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /endpoints/);
  assert.match(r.stdout, /No credits were spent/);
});

test('an unknown catalog subcommand names the real ones, including list', () => {
  const r = run('catalog', 'wat');
  assert.equal(r.status, 2);
  assert.match(`${r.stdout}${r.stderr}`, /list \| gen \| diff/);
});

test('--live is a declared flag, so the unknown-flag guard does not refuse it', () => {
  const r = run('catalog', 'list', '--no-color', '--live');
  assert.notEqual(r.status, 2, `the flag guard refused --live:\n${r.stdout}${r.stderr}`);
});
