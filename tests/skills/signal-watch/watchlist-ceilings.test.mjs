// tests/skills/signal-watch/watchlist-ceilings.test.mjs
//
// `gates.yaml:watchlist` exists for exactly one skill, and until this one shipped nothing
// cited it. Four keys, and each one guards a different failure:
//
//   max_entities            a watchlist big enough that every refresh is a material spend
//   max_entities_hard_stop  a watchlist nobody meant to create
//   max_refresh_batch       the blast radius of one mis-scoped cycle
//   min_refresh_interval_hours  a cadence that re-buys facts that have not moved
//
// The block is only worth anything if the skill cites it AND the runtime enforces it, so
// both halves are asserted: the citations resolve against the real file, and the real
// `checkWatchlistSize` is exercised at its boundaries — including the fail-closed case,
// where a dropped merge hunk must produce a STOP rather than "no ceiling".

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadGates, gateValue, hasGate, checkWatchlistSize, ALLOW, CONFIRM, STOP }
  from '../../../_lib/gates.mjs';
import { skillBody, proseOnly } from './helpers.mjs';

const GATES = loadGates();
const body = skillBody();
const flat = (t) => t.replace(/\s+/g, ' ');

const KEYS = ['max_entities', 'max_entities_hard_stop', 'max_refresh_batch', 'min_refresh_interval_hours'];

test('all four watchlist keys exist in gates.yaml', () => {
  for (const k of KEYS) {
    assert.ok(hasGate(GATES, `watchlist.${k}`), `gates.yaml:watchlist.${k} does not resolve`);
  }
});

test('the SKILL.md cites all four of them, by key', () => {
  for (const k of KEYS) {
    assert.ok(body.includes(`gates.yaml:watchlist.${k}`),
      `the skill never cites gates.yaml:watchlist.${k} — an uncited ceiling is a ceiling `
      + 'nobody applies, and rule 4 cannot check a number that was typed instead');
  }
});

test('every gates.yaml key the SKILL.md cites resolves (rule 4, checked here too)', () => {
  const cited = [...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length > 0);
  for (const key of new Set(cited)) {
    assert.ok(hasGate(GATES, key), `cites gates.yaml:${key}, which does not resolve — a missing key `
      + 'reads as STOP (law 5), so this ships a skill that silently refuses to run');
  }
});

test('the real engine allows, confirms and stops at the documented boundaries', () => {
  const soft = gateValue(GATES, 'watchlist.max_entities');
  const hard = gateValue(GATES, 'watchlist.max_entities_hard_stop');
  assert.ok(soft < hard, 'the soft ceiling must sit below the hard one');

  assert.equal(checkWatchlistSize(GATES, soft).decision, ALLOW);
  assert.equal(checkWatchlistSize(GATES, soft + 1).decision, CONFIRM,
    'one entity over the soft ceiling asks, because every refresh re-costs the whole list');
  assert.equal(checkWatchlistSize(GATES, hard).decision, CONFIRM);
  assert.equal(checkWatchlistSize(GATES, hard + 1).decision, STOP,
    'past the hard ceiling there is no confirmation that makes it acceptable');
});

test('a dropped watchlist key is a STOP, not an absent ceiling (law 5)', () => {
  const withoutSoft = { ...GATES, watchlist: { ...GATES.watchlist } };
  delete withoutSoft.watchlist.max_entities;
  const r = checkWatchlistSize(withoutSoft, 1);
  assert.equal(r.decision, STOP);
  assert.equal(r.failed_closed, true,
    'losing the key in a merge must wedge the skill, not silently uncap it');

  const withoutHard = { ...GATES, watchlist: { ...GATES.watchlist } };
  delete withoutHard.watchlist.max_entities_hard_stop;
  assert.equal(checkWatchlistSize(withoutHard, 1).decision, STOP);
});

test('the skill delegates the size check to the engine instead of comparing by hand', () => {
  const f = flat(body);
  assert.match(f, /checkWatchlistSize/,
    'name the function, so a reader knows there is one and does not re-derive it');
  assert.match(f, /_lib\/gates\.mjs/);
  assert.match(f, /Do not restate those ceilings as prose numbers/i);
  assert.match(f, /hand-comparison converts a fail-closed stop into a fail-open shrug/i);
});

test('the cadence floor and the batch ceiling are used, not just cited', () => {
  const f = flat(body);
  assert.match(f, /batches of at most `gates\.yaml:watchlist\.max_refresh_batch`|batches of `gates\.yaml:watchlist\.max_refresh_batch`/,
    'the batch ceiling must be applied to the cycle, not listed in a table');
  assert.match(f, /resumable/, 'a batched cycle that cannot resume re-charges the batch it finished');
  assert.match(f, /blast radius/,
    'the batch is the blast radius of a mis-scoped query, which is why it is small');
  assert.match(f, /gates\.yaml:watchlist\.min_refresh_interval_hours[\s\S]{0,400}?floor/i);
});

test('the cadence floor is not the only floor: a watch is also floored by its own cache TTL', () => {
  const f = flat(body);
  assert.match(f, /cadence floor equal to its own TTL/i,
    'the rule that stops a daily watch re-buying a monthly fact');
  // Each TTL the skill leans on must be a key that resolves, not a remembered duration.
  for (const key of [
    'cache_ttl.endpoints.web_tech_stack',
    'cache_ttl.endpoints.crunchbase_company_scraper_sync',
    'cache_ttl.capability_groups.search_trends',
    'cache_ttl.capability_groups.ads_libraries',
    'cache_ttl.capability_groups.posts_activity',
    'cache_ttl.capability_groups.people_search',
    'cache_ttl.capability_groups.enrichment',
  ]) {
    assert.ok(body.includes(`gates.yaml:${key}`), `the cadence section must cite gates.yaml:${key}`);
    assert.ok(hasGate(GATES, key), `gates.yaml:${key} does not resolve`);
  }
  assert.match(f, /--no-cache/, 'the alternative to a cache hit is paying full price for the same fact');
});

test('the ceilings are cited, never transcribed', () => {
  const prose = proseOnly(body).split('\n').filter(l => !/gates\.yaml/.test(l)).join('\n');
  for (const k of KEYS) {
    const v = String(gateValue(GATES, `watchlist.${k}`));
    assert.ok(!new RegExp(`\\b${v}\\b`).test(prose),
      `watchlist.${k} (${v}) is transcribed into the prose; cite the key instead (law 1)`);
  }
});
