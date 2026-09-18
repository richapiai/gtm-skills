// tests/skills/org-map/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint, and CI already fails on an endpoint owned by nobody. It cannot see the
// other direction: a SKILL.md that quietly calls something it does not own, or silently
// drops one of the five it is responsible for.
//
// It also pins the ownership question this suite resolves —
// `slack_channel_members` arrived here from a capability-group default, and the design
// uses it as THE example of a claim that "buys nothing". The claim is kept only under a
// condition, and the condition is asserted rather than trusted.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners, section } from './helpers.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const BODY = skillBody();
const owned = ownedEndpoints();

test('the owners file assigns this skill exactly the five-endpoint surface', () => {
  assert.deepEqual([...owned].sort(), [
    'ai_enrich',
    'enrich_profiles_bulk',
    'lead_search',
    'linkedin_company_employees_search',
    'slack_channel_members',
  ]);
  assert.equal(owned.size, 5);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const invoked = invokedEndpoints(BODY);
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [],
    `owned but never invoked: ${missing.join(', ')} — either call it or hand it to another skill`);
  assert.deepEqual(extra, [],
    `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the SKILL.md invokes exists in the generated catalog', () => {
  for (const name of invokedEndpoints(BODY)) {
    assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invokedEndpoints(BODY)) {
    assert.ok(!(name in (OWNERS.unclaimed || {})),
      `${name} is unclaimed (${OWNERS.unclaimed?.[name]}) and must not be invoked`);
    assert.notEqual(CATALOG.endpoints[name].pricing?.disabled_by_default, true,
      `${name} is disabled by default`);
  }
});

test('this skill owns no resolution endpoint, and says so instead of guessing', () => {
  // Getting from "Acme" to a LinkedIn company URL needs enrich_company /
  // find_website_by_company_name / web_social_links, none of which are here. A silently
  // chosen homonym poisons every node with no way to detect it afterwards.
  for (const e of ['enrich_company', 'find_website_by_company_name', 'web_social_links',
    'linkedin_company_search']) {
    assert.ok(!owned.has(e), `${e} is now owned by ${SKILL} — re-read Step 0`);
    assert.ok(!new RegExp(`\`${e}\\(`).test(BODY), `${SKILL} invokes ${e}, which it does not own`);
  }
  assert.match(BODY, /owns no resolution endpoint/i,
    'the skill must state that it cannot resolve a company name, and route instead');
});

// ---------------------------------------------------------------------------
// slack_channel_members — the open ownership question.
// ---------------------------------------------------------------------------

test('slack_channel_members is claimed by a capability-group default, not by the plan', () => {
  // The design names four endpoints for this skill. The fifth arrived
  // through `defaults_by_capability_group: social: [org-map]`. If that default ever
  // changes, this test is where the skill finds out.
  assert.deepEqual(OWNERS.defaults_by_capability_group.social, [SKILL]);
  assert.equal(CATALOG.endpoints.slack_channel_members.capability_group, 'social');
  assert.deepEqual(OWNERS.endpoints.slack_channel_members, [SKILL]);
});

test('the claim is kept only under a stated condition, and the condition is in the skill', () => {
  const s = section(/participation/i);
  assert.match(s.text, /shared Slack Connect channel/i,
    'the only honest use of this endpoint must be named as the condition, not implied');
  assert.match(s.text, /not_applicable/,
    'outside that condition the answer is an explicit null, not a call');
  assert.match(s.text, /participation, never hierarchy/i,
    'the endpoint must be stated to produce a node attribute and never an edge');
  // And the boundary section repeats it, because that is the section a reader skims.
  const b = section(/will not/i);
  assert.match(b.text, /will not read hierarchy out of Slack/i);
  assert.match(b.text, /capability-group default/i,
    'the skill must be honest about where this claim came from');
});

test('retired endpoint names that do not exist stay uninvoked', () => {
  // An earlier /competitive-intel invoked `ad_search`, `ad_details` and `post_keyword_search`.
  // /org-map is new, but the same class of error — an endpoint name from memory — is the
  // one this pack keeps catching, so the guard is cheap and it is here.
  for (const fake of ['ad_search', 'ad_details', 'enrich_profile_bulk', 'org_chart', 'company_org']) {
    assert.equal(CATALOG.endpoints[fake], undefined,
      `${fake} now exists in the catalog — re-check this assertion against the spec`);
    assert.ok(!new RegExp(`\`${fake}\\(`).test(BODY), `the SKILL.md invokes \`${fake}(\`, which is not real`);
  }
});
