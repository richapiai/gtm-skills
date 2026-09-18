// tests/skills/research-agent/endpoint-set.test.mjs
//
// `_lib/endpoint-owners.yaml` is the source of truth for which skill reaches for which
// endpoint. CI already fails on an endpoint owned by nobody; it cannot see the other
// direction — a SKILL.md that quietly calls something it does not own, or that silently
// drops one it is responsible for.
//
// This skill is the widest surface in the pack after /account-research: eleven
// endpoints, one of them the shared LLM hop. So the set is checked in three places
// that must agree — the owners file, the SKILL.md, and the routing table the harness
// executes. Two out of three agreeing is how a route ends up calling an endpoint no
// gate was written for.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SKILL, skillBody, invokedEndpoints, ownedEndpoints, catalog, owners } from './helpers.mjs';
import { loadResearchRoutes } from './harness.mjs';
import { loadGates, gateValue } from '../../../_lib/gates.mjs';

const CATALOG = catalog();
const OWNERS = owners();
const ROUTES = loadResearchRoutes();
const BODY = skillBody();
const owned = ownedEndpoints();
const invoked = invokedEndpoints(BODY);

const EXPECTED = [
  'ai_enrich',
  'crunchbase_company_scraper_sync',
  'find_sitemap_urls',
  'google_search_scraper_sync',
  'search_bing',
  'web_scrape',
  'website_intelligence',
  'youtube_channel',
  'youtube_channel_videos',
  'youtube_search',
  'youtube_video',
];

test('the owners file assigns this skill exactly eleven endpoints', () => {
  assert.deepEqual([...owned].sort(), EXPECTED);
  assert.equal(owned.size, 11);
});

test('the SKILL.md invokes exactly the endpoints it owns — no more, no fewer', () => {
  const missing = [...owned].filter(e => !invoked.has(e)).sort();
  const extra = [...invoked].filter(e => !owned.has(e)).sort();
  assert.deepEqual(missing, [], `owned but never invoked: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `invoked but not owned by ${SKILL} in endpoint-owners.yaml: ${extra.join(', ')}`);
});

test('every endpoint the routing table routes to is one this skill owns', () => {
  const routed = new Set();
  for (const t of ROUTES.templates) {
    for (const hop of t.route || []) routed.add(hop.endpoint);
    if (t.alternate?.endpoint) routed.add(t.alternate.endpoint);
  }
  for (const name of routed) {
    assert.ok(owned.has(name), `the table routes to ${name}, which ${SKILL} does not own`);
    assert.ok(CATALOG.endpoints[name], `${name} is not in _lib/api-catalog.json`);
  }
  // And the table reaches every one of them: an owned endpoint no template can route
  // to is a claim on the owners file that nothing honours.
  const unreachable = [...owned].filter(e => !routed.has(e));
  assert.deepEqual(unreachable, [], `owned but unreachable from any template: ${unreachable.join(', ')}`);
});

test('no invoked endpoint is disabled by default or unclaimed', () => {
  for (const name of invoked) {
    assert.ok(!(name in (OWNERS.unclaimed || {})), `${name} is unclaimed and must not be invoked`);
    assert.notEqual(CATALOG.endpoints[name].pricing?.disabled_by_default, true, `${name} is disabled by default`);
  }
});

test('the handoff targets are real skills, and they are the ones the corpus map points at', () => {
  const handoff = ROUTES.templates.find(t => t.id === 'handoff');
  assert.ok(handoff, 'the library must carry a handoff template — 50 of the 61 routed research '
    + 'prompts belong to skills that already exist');
  for (const skill of Object.keys(handoff.targets)) {
    assert.ok(BODY.includes(`../${skill}/SKILL.md`) || skill === 'org-map' || skill === 'competitive-intel',
      `${skill} is a handoff target but the skill never links to it`);
  }
  // A handoff target must not be this skill: handing a question to yourself is a loop.
  assert.ok(!Object.keys(handoff.targets).includes(SKILL));
});

test('search_bing is the one page-gated endpoint, and the skill has a page-gate section for it', () => {
  // Fan-out here is mostly a ROW problem. search_bing is the exception: flat per call,
  // but it takes `page`, so it is in gates.yaml:unbounded_endpoints.endpoints. If another
  // owned endpoint joins it, this is where that is noticed.
  const unbounded = new Set(gateValue(loadGates(), 'unbounded_endpoints.endpoints'));
  const gated = [...owned].filter(n => unbounded.has(n)).sort();
  assert.deepEqual(gated, ['search_bing'],
    'the page-gated subset of /research-agent moved — its page-gate section must cover it');
  assert.match(BODY, /### The page gate/);
  assert.match(BODY, /gates\.yaml:unbounded_endpoints\.pages_before_confirm/);
  assert.match(BODY, /gates\.yaml:unbounded_endpoints\.hard_page_ceiling/);
});

test('there is no filings, whois, DNS or review-corpus endpoint to reach for', () => {
  // The pack's permanent ceiling for this skill, and the reason five of the six
  // undiscoverable shapes exist. If one of these ever appears in the catalog the
  // register needs revisiting, and this is where that is noticed.
  for (const invented of ['sec_filings', 'whois', 'dns_lookup', 'mx_record', 'g2_reviews',
    'trustpilot', 'market_data', 'crm_sync']) {
    assert.equal(CATALOG.endpoints[invented], undefined,
      `${invented} now exists in the catalog — re-check the undiscoverable register`);
    assert.ok(!new RegExp(`\`${invented}\\(`).test(BODY), `the SKILL.md invokes \`${invented}(\`, which is not real`);
  }
});

test('the LLM hop is bound to the dual contract, as the validator requires of any skill using it', () => {
  assert.ok(owned.has('ai_enrich'));
  assert.match(BODY, /dual-contract\.schema\.json|dual contract/i);
  assert.equal(ROUTES.inference.dual_contract, '_lib/dual-contract.schema.json');
  assert.equal(ROUTES.inference.llm_output_provenance, 'ai_inferred');
  assert.equal(ROUTES.inference.llm_output_merged_into_verified, false);
  assert.equal(ROUTES.inference.confidence, 'numeric_0_1');
  assert.ok(!/\bconfidence\b\s*[:=]\s*"?(?:high|medium|low)"?/i.test(BODY),
    'a worded confidence is one of the conventions the dual contract abolished');
});
