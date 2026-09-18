// tests/skills/comply/country-names — the gate locates a row that names its country.
//
// Live 2026-09-17: profile enrichment writes `location_country: "United States"` and a
// state name, never an ISO code. The shipped gate imported only the code helpers, so
// every enriched row refused as `unknown_jurisdiction` with the fix "this row states no
// country at all" — which the operator had already done. The table could resolve both
// all along; the script simply never asked it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { makeGtmTree } from '../../helpers/index.mjs';
import { ensureSuppressionStore } from '../../../_lib/suppression.mjs';
import { runComply, clearRow, csvOf } from './comply-runner.mjs';

const NOW = '2026-08-28T12:00:00.000Z';

function fixture (t, rows) {
  const g = makeGtmTree({ prefix: 'cn-comply-' });
  t.after(() => g.cleanup());
  ensureSuppressionStore(g.root);
  const list = g.write('gtm/lists/people.csv', csvOf(rows));
  return { g, list, out: g.path('gtm/reviews/people.comply.json') };
}
const comply = (f, env = {}) => runComply({ LIST: f.list, ROOT: f.g.root, OUT: f.out, NOW, ...env });
const verdict = (f) => JSON.parse(fs.readFileSync(f.out, 'utf8'));

const stoppedReasons = (v) => (v.stopped ?? []).flatMap((s) => [s.reason, ...(s.reasons ?? [])]).filter(Boolean);

test('a country NAME locates the row, exactly as its ISO code does', (t) => {
  const named = fixture(t, [clearRow(1, { subject_country: 'United States', subject_region: 'Washington' })]);
  comply(named);
  const coded = fixture(t, [clearRow(1, { subject_country: 'US', subject_region: 'US-WA' })]);
  comply(coded);

  const reasons = stoppedReasons(verdict(named));
  assert.ok(!reasons.some((r) => String(r).includes('unknown_jurisdiction')),
    `a row naming its country must not read as unlocatable: ${reasons.join(', ')}`);
  assert.deepEqual(reasons.sort(), stoppedReasons(verdict(coded)).sort(),
    'the name and the code must reach the same verdict');
});

test('a row that states no country at all still refuses, with that reason', (t) => {
  const f = fixture(t, [clearRow(1, { subject_country: '', subject_region: '' })]);
  comply(f);
  assert.ok(stoppedReasons(verdict(f)).some((r) => String(r).includes('unknown_jurisdiction')));
});

test('a country nobody has rules for refuses as no_rule_set, not as unlocatable', (t) => {
  const f = fixture(t, [clearRow(1, { subject_country: 'Japan', subject_region: '' })]);
  comply(f);
  const reasons = stoppedReasons(verdict(f)).join(' ');
  assert.match(reasons, /no_rule_set/);
  assert.doesNotMatch(reasons, /unknown_jurisdiction/);
});
