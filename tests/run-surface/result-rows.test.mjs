// tests/run-surface/result-rows.test.mjs — every recorded search answer yields its rows.
//
// A paged search that is billed and then read as "no rows" hands the user nothing for
// their credits. The row reader is checked against the real recordings, not against
// the spec's examples.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readResultRows } from '../../_lib/run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATALOG = JSON.parse(fs.readFileSync(path.join(ROOT, '_lib', 'api-catalog.json'), 'utf8'));
const LIVE = path.join(ROOT, 'tests', 'fixtures', 'live');

const recording = (name) => {
  const f = path.join(LIVE, `${name}.json`);
  if (!fs.existsSync(f)) return null;
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  return j.http_status >= 200 && j.http_status < 300 ? j.body : null;
};

test('every recorded page-gated search yields a row array', () => {
  const paged = Object.entries(CATALOG.endpoints).filter(([, e]) => e.pricing.page_gated).map(([n]) => n);
  const unread = [];
  let checked = 0;
  for (const name of paged) {
    const body = recording(name);
    if (!body) continue;
    checked += 1;
    if (!Array.isArray(readResultRows(body))) unread.push(name);
  }
  assert.ok(checked >= 10, `only ${checked} paged endpoints have a 2xx recording`);
  assert.deepEqual(unread, [], 'these searches would be billed and written as no rows');
});

test('the shapes that were being dropped are read', () => {
  for (const name of ['people_search', 'post_activities', 'post_keyword_search', 'search_bing', 'directory_yellowpages']) {
    const body = recording(name);
    assert.ok(body, `${name} has no 2xx recording`);
    const rows = readResultRows(body);
    assert.ok(Array.isArray(rows) && rows.length > 0, `${name} yields no rows`);
  }
});

test('a body with no row container is still unreadable, not guessed', () => {
  assert.equal(readResultRows({ error: 'x' }), null);
  assert.equal(readResultRows({ data: { title: 'x' } }), null);
  assert.equal(readResultRows(null), null);
});
