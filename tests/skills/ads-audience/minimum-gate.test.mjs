// tests/skills/ads-audience/minimum-gate.test.mjs
//
// THE test this skill exists for.
//
// An upload under the platform floor is rejected by the platform AFTER the credits are
// already spent. So the assertion is not "the skill mentions a minimum" — it is that a
// list which cannot clear the floor produces a refusal and **zero paid calls**, and
// that an unfamiliar platform fails closed instead of falling through to a default that
// `gates.yaml:audience_minimums` deliberately does not contain.
//
// Every paid call in this harness goes through an injected `call` function, so "before
// spending" is a countable fact rather than a claim about ordering in prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { loadGates, gateValue } from '../../../_lib/gates.mjs';
import { ensureSuppressionStore } from '../../../_lib/suppression.mjs';
import {
  loadAudienceRules, planAudience, buildAudience,
  BUILD, REFUSE, AudienceRefused, SuppressionUnavailableError,
} from './harness.mjs';
import { tmpRoot } from './helpers.mjs';

const RULES = loadAudienceRules();
const GATES = loadGates();

const LINKEDIN_FLOOR = gateValue(GATES, 'audience_minimums.linkedin');
const META_FLOOR = gateValue(GATES, 'audience_minimums.meta');

/** n rows with a real corporate address. */
function corporateRows (n, prefix = 'p') {
  return Array.from({ length: n }, (_, i) => ({
    first_name: `P${i}`, company_domain: 'acme.example', email: `${prefix}${i}@acme.example`,
  }));
}

/** n rows with no address but enough to search on — the paid fill's input. */
function fillableRows (n, prefix = 'f') {
  return Array.from({ length: n }, (_, i) => ({
    first_name: `${prefix}${i}`, last_name: 'Doe', company_domain: 'acme.example',
  }));
}

function freshRoot (prefix = 'ads-min-') {
  const root = tmpRoot(prefix);
  ensureSuppressionStore(root);
  return root;
}

/** A paid-call spy. Calling it is the thing under test, so it records every attempt. */
function spy (result = 'found@acme.example') {
  const calls = [];
  const fn = (endpoint, row) => { calls.push({ endpoint, row }); return result; };
  fn.calls = calls;
  return fn;
}

// ===========================================================================
// 1. Under the floor — refused, and refused for FREE.
// ===========================================================================

test('an audience whose CEILING is under the floor is refused before a credit moves', () => {
  const root = freshRoot();
  // Everything the list could ever become is still short of LinkedIn's floor: the paid
  // fill cannot manufacture rows that are not there.
  const rows = [...corporateRows(LINKEDIN_FLOOR - 40), ...fillableRows(20)];
  const plan = planAudience({ rows, platform: 'linkedin', gates: GATES, root, rules: RULES });

  assert.equal(plan.decision, REFUSE);
  assert.equal(plan.spend, null, 'a refused plan carries no spend plan at all');
  assert.equal(plan.counts.ceiling, LINKEDIN_FLOOR - 20);
  assert.equal(plan.floor.value, LINKEDIN_FLOOR);
  assert.equal(plan.floor.key, 'audience_minimums.linkedin');
  assert.match(plan.gate, /^audience_minimums\.linkedin$/);
});

test('the refusal is reached without ever calling the paid hop', () => {
  const root = freshRoot();
  const rows = [...corporateRows(10), ...fillableRows(10)];
  const call = spy();

  const plan = planAudience({ rows, platform: 'meta', gates: GATES, root, rules: RULES });
  assert.equal(plan.decision, REFUSE);
  assert.equal(call.calls.length, 0, 'planning must not spend');

  // And the runner refuses the refused plan before it looks at anything else.
  assert.throws(() => buildAudience({ plan, file: join(root, 'a.csv'), root, gates: GATES, rules: RULES, call }),
    (e) => e instanceof AudienceRefused);
  assert.equal(call.calls.length, 0, 'a refused plan must never reach the paid hop');
  assert.equal(existsSync(join(root, 'a.csv')), false, 'a refused build leaves nothing behind');
});

test('the refusal names all four numbers a user needs to act on it', () => {
  const root = freshRoot();
  const plan = planAudience({
    rows: [...corporateRows(5), { email: 'info@acme.example' }, ...fillableRows(3)],
    platform: 'google', gates: GATES, root, rules: RULES,
  });
  assert.equal(plan.decision, REFUSE);
  for (const k of ['source', 'suppressed', 'role', 'ceiling']) {
    assert.equal(typeof plan.counts[k], 'number', `the refusal must report ${k}`);
  }
  assert.equal(plan.counts.role, 1, 'a role address is counted, not silently dropped');
});

// ===========================================================================
// 2. An unknown platform fails closed.
// ===========================================================================

test('an unknown platform is a STOP, not a default floor', () => {
  const root = freshRoot();
  // Far more rows than any floor in the file. Size is not the reason this fails.
  const rows = corporateRows(Math.max(LINKEDIN_FLOOR, META_FLOOR) * 3);
  for (const platform of ['tiktok', 'reddit', 'x', 'twitter', 'snapchat', '', 'LINKEDIN_2']) {
    const plan = planAudience({ rows, platform, gates: GATES, root, rules: RULES });
    assert.equal(plan.decision, REFUSE, `${JSON.stringify(platform)} was allowed through`);
    assert.equal(plan.failed_closed, true, `${JSON.stringify(platform)} did not fail closed`);
    assert.equal(plan.spend, null);
    assert.equal(plan.floor, null, 'an unknown platform has no floor to report');
  }
});

test('gates.yaml:audience_minimums carries no default key — that is what makes it fail closed', () => {
  const mins = gateValue(GATES, 'audience_minimums');
  assert.equal(Object.prototype.hasOwnProperty.call(mins, 'default'), false,
    'a `default` key here would silently authorise every unknown platform');
  assert.deepEqual(Object.keys(mins).sort(), ['google', 'linkedin', 'meta']);
  // The rules table in the SKILL.md must not drift from the file it mirrors.
  assert.deepEqual([...RULES.platforms].sort(), Object.keys(mins).sort(),
    'audience-rules.platforms disagrees with gates.yaml:audience_minimums');
});

test('a gates file with the platform key removed also fails closed', () => {
  const root = freshRoot();
  const holed = JSON.parse(JSON.stringify(GATES));
  delete holed.audience_minimums.linkedin;
  const plan = planAudience({
    rows: corporateRows(LINKEDIN_FLOOR * 2), platform: 'linkedin', gates: holed, root, rules: RULES,
  });
  assert.equal(plan.decision, REFUSE);
  assert.equal(plan.failed_closed, true,
    'a merge that drops a gate key must wedge the call, not open it (law 5)');
});

// ===========================================================================
// 3. Over the floor — the spend is planned, priced, and still dry-run gated.
// ===========================================================================

test('a list that clears the floor plans the fill and nothing more', () => {
  const root = freshRoot();
  const rows = [...corporateRows(LINKEDIN_FLOOR), ...fillableRows(25)];
  const plan = planAudience({ rows, platform: 'linkedin', gates: GATES, root, rules: RULES });

  assert.equal(plan.decision, BUILD);
  assert.equal(plan.spend.endpoint, 'email_finder');
  assert.equal(plan.spend.planned_calls, 25, 'only the rows that need filling are planned');
  assert.equal(plan.spend.dry_run_required, true);
  assert.equal(plan.counts.ready, LINKEDIN_FLOOR);
});

test('the fill under-delivering below the floor is refused at write time, and writes nothing', () => {
  const root = freshRoot();
  // Clears the floor only if every fill succeeds. None of them do.
  const rows = [...corporateRows(LINKEDIN_FLOOR - 30), ...fillableRows(60)];
  const plan = planAudience({ rows, platform: 'linkedin', gates: GATES, root, rules: RULES });
  assert.equal(plan.decision, BUILD, 'the ceiling clears, so the fill is legitimately offered');

  const call = spy(null);              // every lookup comes back empty
  const file = join(root, 'gtm', 'audiences', 'q3.linkedin.csv');
  const res = buildAudience({ plan, file, root, gates: GATES, rules: RULES, call });

  assert.equal(res.decision, REFUSE);
  assert.equal(res.code, 'REALISED_BELOW_FLOOR');
  assert.equal(res.file, null);
  assert.equal(existsSync(file), false, 'an audience that cannot be uploaded is not written');
  assert.equal(call.calls.length, 60, 'the credits WERE spent — the report must not pretend otherwise');
  assert.equal(res.counts.realised, LINKEDIN_FLOOR - 30);
});

// ===========================================================================
// 4. No store, no audience.
// ===========================================================================

test('an unreadable suppression store stops the plan before it counts anything', () => {
  const root = tmpRoot('ads-nostore-');   // deliberately NOT ensureSuppressionStore
  assert.throws(
    () => planAudience({ rows: corporateRows(LINKEDIN_FLOOR * 2), platform: 'linkedin', gates: GATES, root, rules: RULES }),
    (e) => e instanceof SuppressionUnavailableError,
    'a check we could not run is not a passing check (law 5)');
});
