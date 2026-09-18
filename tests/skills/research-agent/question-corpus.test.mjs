// tests/skills/research-agent/question-corpus.test.mjs
//
// /research-agent is easy to over-trust as able to answer any custom research
// question. That is a claim, and law 6 says a claim carries a source line. So the claim
// was turned into a measurement — skills/research-agent/research-question-corpus.json,
// one classified row per real custom-research prompt — and this file makes the
// measurement load-bearing:
//
//   * every count in the map is RE-DERIVED here rather than trusted;
//   * the map vendors only the classification, never the third-party prompt titles;
//   * the numbers printed in SKILL.md are parsed back out of the prose and compared,
//     so the paragraph and the data cannot drift apart.
//
// Nothing here reads outside the repo, so a clean clone runs every assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, owners } from './helpers.mjs';
import { loadCorpusMap, loadResearchRoutes } from './harness.mjs';

const MAP = loadCorpusMap();
const ROUTES = loadResearchRoutes();
const BODY = skillBody();

const count = (pred) => MAP.prompts.filter(pred).length;

test('the map classifies all 175 prompts, exactly once each, with no gaps', () => {
  assert.equal(MAP.prompts.length, 175);
  assert.equal(MAP.source_prompt_count, 175);
  const seen = new Set(MAP.prompts.map(p => p.i));
  assert.equal(seen.size, 175, 'a prompt index is duplicated');
  for (let i = 0; i < 175; i += 1) assert.ok(seen.has(i), `prompt ${i} is unclassified`);
  for (const p of MAP.prompts) {
    assert.ok(['routed', 'grounded', 'local', 'unreachable'].includes(p.tier), `${p.i}: bad tier ${p.tier}`);
    assert.ok(p.template, `${p.i}: no template`);
    assert.ok(Array.isArray(p.endpoints), `${p.i}: endpoints is not a list`);
  }
});

test('every summary number is re-derived, not trusted', () => {
  const s = MAP.summary;
  assert.equal(s.total, MAP.prompts.length);
  assert.equal(s.routed, count(p => p.tier === 'routed'));
  assert.equal(s.grounded, count(p => p.tier === 'grounded'));
  assert.equal(s.local, count(p => p.tier === 'local'));
  assert.equal(s.unreachable, count(p => p.tier === 'unreachable'));
  assert.equal(s.routed_owned_here, count(p => p.tier === 'routed' && p.owned_by_research_agent));
  assert.equal(s.routed_handoff, count(p => p.template === 'handoff'));
  assert.equal(s.reachable_at_all, count(p => p.tier !== 'unreachable'));
  assert.equal(s.needs_a_paid_call, count(p => p.tier === 'routed' || p.tier === 'grounded'));
  assert.equal(s.routed + s.grounded + s.local + s.unreachable, 175, 'the tiers must partition the corpus');
  assert.equal(s.routed_owned_here + s.routed_handoff, s.routed);
});

test('the map vendors the classification only — no third-party prompt titles', () => {
  const allowed = new Set(['i', 'tier', 'owned_by_research_agent', 'template', 'endpoints', 'handoff_to', 'why']);
  for (const p of MAP.prompts) {
    for (const k of Object.keys(p)) assert.ok(allowed.has(k), `row ${p.i} carries unexpected field "${k}"`);
  }
});

test('every template the map names exists in the routing table', () => {
  const known = new Set(ROUTES.templates.map(t => t.id));
  known.add('undiscoverable');            // the register, not a template
  for (const p of MAP.prompts) {
    assert.ok(known.has(p.template), `row ${p.i} routes to template "${p.template}", which does not exist`);
  }
  // And the register's rows really are the unreachable tier, not a dumping ground.
  for (const p of MAP.prompts) {
    assert.equal(p.template === 'undiscoverable', p.tier === 'unreachable', `row ${p.i} disagrees with itself`);
    if (p.tier === 'unreachable') assert.ok(p.why, `row ${p.i} refuses without a reason`);
  }
});

test('every endpoint named in the map is a real endpoint, owned by the skill the map says', () => {
  const OWNERS = owners();
  for (const p of MAP.prompts) {
    for (const e of p.endpoints) {
      const holders = OWNERS.endpoints[e];
      assert.ok(holders, `row ${p.i} names ${e}, which is not in endpoint-owners.yaml`);
      if (p.owned_by_research_agent) {
        assert.ok(holders.includes('research-agent'), `row ${p.i} claims ${e} for research-agent, which does not own it`);
      } else {
        assert.ok(holders.includes(p.handoff_to),
          `row ${p.i} hands ${e} to /${p.handoff_to}, which does not own it`);
      }
    }
  }
});

test('THE finding — this skill is not a catch-all, and the numbers say so', () => {
  const s = MAP.summary;
  // Most of the deterministic corpus already has a home. Answering it here would
  // reimplement six skills and route the user around their gates.
  assert.ok(s.routed_handoff > s.routed_owned_here * 4,
    `handoffs (${s.routed_handoff}) should dominate own routes (${s.routed_owned_here}); `
    + 'if that ever flips, the "not a catch-all" argument in SKILL.md needs rewriting');
  // A fifth of the corpus should never make a call at all.
  assert.ok(s.local >= 30, `only ${s.local} prompts are free-local; re-check the classification`);
  // And a real, non-trivial slice is simply not answerable.
  assert.ok(s.unreachable > 0, 'a corpus with nothing unreachable means the register has no evidence behind it');
});

test('the numbers printed in SKILL.md are the numbers in the map', () => {
  // The prose and the measurement cannot be allowed to drift: a table of counts that
  // nobody re-derives is exactly the "prose table drifted before a line of code
  // existed" failure the owners file was written to prevent.
  const s = MAP.summary;
  const row = (label) => {
    const m = BODY.match(new RegExp(`^\\|[^|\\n]*${label}[^|\\n]*\\|\\s*(\\d+)\\s*\\|`, 'm'));
    assert.ok(m, `no table row matching /${label}/ in SKILL.md`);
    return Number(m[1]);
  };
  assert.equal(row('own output \\*\\*is\\*\\* the answer'), s.routed);
  assert.equal(row('belongs to \\*\\*another skill\\*\\*'), s.routed_handoff);
  assert.equal(row('belongs to this skill'), s.routed_owned_here);
  assert.equal(row('returns a \\*\\*document\\*\\*'), s.grounded);
  assert.equal(row('No fetch at all'), s.local);
  assert.equal(row('Not reachable'), s.unreachable);

  // The per-skill handoff counts quoted in the prose paragraph.
  const derived = {};
  for (const p of MAP.prompts) if (p.handoff_to) derived[p.handoff_to] = (derived[p.handoff_to] || 0) + 1;
  assert.deepEqual(MAP.handoff_targets, derived);
  const flat = BODY.replace(/\s+/g, ' ');
  assert.match(flat, new RegExp(`account-research/SKILL\\.md\\) has ${derived['account-research']} of them`),
    'the account-research handoff count in the prose does not match the map');
  assert.match(flat, new RegExp(`enrich-waterfall/SKILL\\.md\\) ${derived['enrich-waterfall']}`),
    'the enrich-waterfall handoff count in the prose does not match the map');
  assert.match(flat, new RegExp(`list-hygiene/SKILL\\.md\\) ${derived['list-hygiene']}`),
    'the list-hygiene handoff count in the prose does not match the map');
});
