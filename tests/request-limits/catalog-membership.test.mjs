// `__proto__` passed the
// catalog membership guard.
//
// `catalog.endpoints['__proto__']` answers with Object.prototype and
// `catalog.endpoints['constructor']` with the Object function, so a bare `if (!def)`
// membership check said yes. The guard whose entire job is "refusing to guess a
// payload" then:
//
//   - PLANNED the call, with `__proto__` as the hop's endpoint name;
//   - priced it at ZERO, because Object.prototype carries no `pricing`;
//   - gated it against Object.prototype's absent everything.
//
// `nope_not_real` was refused correctly the whole time, which is exactly what made the
// guard look sound.
//
// Fixed the same way `_lib/gates.mjs` and `_lib/batch.mjs` already do it: an
// own-property lookup. Asserted here across every entry point AND every prototype key,
// derived from Object.prototype rather than from a list somebody keeps.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CATALOG, GATES, noCache, noStore } from './helpers.mjs';
import { planRowCall, planSearch, buildRequestFor, RunError } from '../../_lib/run.mjs';
import { gatePlan } from '../../_lib/enrich.mjs';
import { createSession, setBudget } from '../../_lib/gates.mjs';

// Every name Object.prototype answers to, plus the two that matter most, derived so a
// future V8 addition is covered without anyone updating a literal.
const PROTOTYPE_KEYS = [
  ...new Set([...Object.getOwnPropertyNames(Object.prototype), '__proto__', 'constructor']),
].filter((k) => !Object.prototype.hasOwnProperty.call(CATALOG.endpoints, k));

test('the prototype key set is non-empty and really is not in the catalog', () => {
  assert.ok(PROTOTYPE_KEYS.length >= 5,
    `derived only ${PROTOTYPE_KEYS.length} prototype names — the derivation is broken`);
  assert.ok(PROTOTYPE_KEYS.includes('__proto__'));
  assert.ok(PROTOTYPE_KEYS.includes('constructor'));
});

test('planRowCall refuses every prototype name, exactly as it refuses a typo', () => {
  for (const name of [...PROTOTYPE_KEYS, 'nope_not_real']) {
    assert.throws(
      () => planRowCall({
        runId: 'r', endpoint: name, records: [{}], catalog: CATALOG, gates: GATES,
        store: noStore, cache: noCache, params: { q: 'x' },
      }),
      RunError,
      `planRowCall PLANNED a call to "${name}" — Object.prototype is not an endpoint, and `
      + 'a plan built on it is priced at zero and gated against nothing');
  }
});

test('planSearch refuses them too', () => {
  for (const name of [...PROTOTYPE_KEYS, 'nope_not_real']) {
    assert.throws(
      () => planSearch({
        runId: 'r', endpoint: name, params: { q: 'x' }, catalog: CATALOG, gates: GATES,
        cache: noCache, pages: 1,
      }),
      RunError,
      `planSearch PLANNED a paged search against "${name}"`);
  }
});

test('buildRequestFor refuses to build a payload for any of them', () => {
  for (const name of [...PROTOTYPE_KEYS, 'nope_not_real']) {
    const req = buildRequestFor(name, {}, CATALOG, { params: { q: 'x' }, gates: GATES });
    assert.equal(req.ok, false, `buildRequestFor built a payload for "${name}"`);
    assert.match(req.reason, /is not in the catalog/,
      `"${name}" must be refused for the RIGHT reason — a refusal that happens to fall out `
      + 'of a missing required field would come back the day the endpoint list changes');
  }
});

test('the hand-written request contracts are not reachable by a prototype name either', () => {
  // `REQUEST_CONTRACTS['__proto__']` is truthy, so the branch that defers to
  // client.buildRequest used to be taken for a name no contract was written for.
  const req = buildRequestFor('__proto__', { url: 'https://linkedin.com/in/x' }, CATALOG,
    { params: {}, gates: GATES });
  assert.equal(req.ok, false);
  assert.match(req.reason, /is not in the catalog/);
});

test('a real endpoint still resolves, so the guard is not just "refuse everything"', () => {
  const planned = planRowCall({
    runId: 'r', endpoint: 'people_search', records: [{}], catalog: CATALOG, gates: GATES,
    store: noStore, cache: noCache, params: { limit: 10, page: 1 },
  });
  assert.equal(planned.plan.waterfall[0].endpoint, 'people_search');
  assert.ok(planned.plan.totals.credits_estimated > 0,
    'a real per-result endpoint costs something — pricing at zero is the symptom the '
    + 'prototype hole produced');
});

test('enrich.gatePlan does not price a hop against Object.prototype', () => {
  // The enrichment waterfall draws its endpoint names from a fixed list, so this is
  // defence in depth rather than a live hole. It is asserted so that the next hop added
  // from a config file does not have to remember.
  const session = createSession({ gates: GATES, runId: 'r' });
  setBudget(session, 100);

  const plan = { per_hop: [{ endpoint: '__proto__', calls_planned: 1, credits_estimated: 5 }], totals: { credits_estimated: 5 } };
  const gate = gatePlan({ plan, catalog: CATALOG, session });
  assert.equal(gate.blocked, true,
    'an endpoint with no catalog entry has no known pricing model, which fails closed — '
    + 'and Object.prototype must not be able to supply one');
  assert.ok(gate.stops.some((s) => s.gate === 'catalog.endpoint'),
    `expected the not-in-the-catalog stop, got ${gate.stops.map((s) => s.gate).join(', ')}`);

  // The refusal must be EXPLICIT, not a side effect of Object.prototype happening to
  // have no `pricing.model`. `checkCall` reads a null catalogEntry as "the caller did
  // not supply one" — correct for the (plan total) line, and consent by accident here.
  const stop = gate.stops.find((d) => d.gate === 'catalog.endpoint');
  assert.equal(stop.failed_closed, true);
  assert.match(stop.reason, /is not in the catalog/);
});

test('a hop that IS in the catalog still gates on its real pricing', () => {
  const session = createSession({ gates: GATES, runId: 'r' });
  setBudget(session, 100000);
  const plan = {
    per_hop: [{ endpoint: 'enrich_profile', calls_planned: 1, credits_estimated: 1 }],
    totals: { credits_estimated: 1 },
  };
  const gate = gatePlan({ plan, catalog: CATALOG, session });
  assert.equal(gate.blocked, false,
    'the new refusal must not turn every real endpoint into a stop');
});
