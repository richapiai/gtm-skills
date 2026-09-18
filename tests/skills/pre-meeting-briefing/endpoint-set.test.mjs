// tests/skills/pre-meeting-briefing/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint. CI already fails on an endpoint owned by nobody; it cannot see the other
// direction — a SKILL.md that quietly calls something it does not own.
//
// This skill's set is EMPTY, and that is the design rather than an oversight: every
// fact a call sheet needs is already owned by a skill that fetches it with its own
// dry-run, page gate and cache. A second owner for `enrich_profile` would be a second
// place for the discipline around it to rot. The tests below hold that line in both
// directions — it must invoke nothing, and it must still NAME what it borrows, because
// a delegation nobody can see is indistinguishable from a gap.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SKILL, catalog, owners, skillBody, skillProse, ownedEndpoints,
  invokedEndpoints, mentionedEndpoints, directLinks,
} from './helpers.mjs';

const body = skillBody();
const owned = ownedEndpoints();

test('the owners file assigns this skill no endpoints, deliberately', () => {
  assert.deepEqual([...owned], [],
    `endpoint-owners.yaml now assigns ${SKILL} ${[...owned].join(', ')}. That is a design change: `
    + 'this skill composes /account-research and /enrich-waterfall rather than owning a second '
    + 'copy of their endpoints. Re-read "What it owns, and what it borrows" before accepting it.');
});

test('the SKILL.md invokes exactly the endpoints it owns — which is none', () => {
  const invoked = invokedEndpoints(body);
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL}: ${extra.join(', ')} — hand it to the owning skill instead`);
  assert.deepEqual([...invoked], []);
});

test('nothing that looks like a tool call survives anywhere in the body', () => {
  // The validator resolves ``name(`` against the catalog. A backticked identifier with
  // a paren that ISN'T a catalog endpoint is just as wrong here: it reads as a call.
  const callish = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  assert.deepEqual(callish, [], `these read as invocations: ${callish.join(', ')}`);
});

test('the borrowed endpoints are named, not silently assumed', () => {
  // Delegation is only honest if the reader can see what is being delegated. These are
  // the ones the call sheet actually depends on.
  for (const name of ['enrich_profile', 'enrich_company', 'linkedin_company_posts',
    'post_activities', 'post_details', 'profile_social_metrics', 'profile_activities']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(body), `never names the borrowed endpoint ${name}`);
    assert.ok(!body.includes(`${name}(`), `${name} is written as an invocation; it belongs to another skill`);
    assert.ok(catalog.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('every endpoint it names is real, claimed, and not disabled', () => {
  for (const name of mentionedEndpoints(skillProse())) {
    assert.ok(catalog.endpoints[name], `${name} is not in _lib/api-catalog.json`);
    assert.ok(!(name in (owners.unclaimed || {})),
      `${name} is unclaimed (${owners.unclaimed?.[name]}) and must not be named as a source`);
    assert.notEqual(catalog.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default and must not appear as a route`);
  }
});

// `ai_enrich` is named in the inference-mode section precisely to say it is NOT used
// (local inference). Requiring a route to its owners would force this skill to link to skills it
// deliberately has nothing to do with.
const NAMED_TO_BE_REFUSED = new Set(['ai_enrich']);

test('every endpoint it names has an owner that this skill links to', () => {
  const links = new Set(directLinks(body));
  const named = [...mentionedEndpoints(skillProse())].filter(n => !NAMED_TO_BE_REFUSED.has(n));
  assert.ok(named.length > 0, 'the fixture must reflect that this skill names its sources');
  for (const name of named) {
    const ownersOf = owners.endpoints[name] ?? [];
    const built = ownersOf.filter(o => links.has(o));
    assert.ok(built.length > 0,
      `${name} is named but this skill links to none of its owners (${ownersOf.join(', ')}). `
      + 'A borrowed endpoint with no route to its owner is a call this skill is implicitly making.');
  }
});

test('it spends nothing of its own, so law 3 is satisfied by naming nothing', () => {
  const metered = [...invokedEndpoints(body)].filter(n => {
    const p = catalog.endpoints[n]?.pricing;
    return p && p.metered !== false;
  });
  assert.deepEqual(metered, []);
  assert.match(body, /owns no endpoints/i, 'the skill must say plainly that it owns none');
});
