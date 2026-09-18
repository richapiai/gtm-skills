// tests/skills/research-agent/no-duplication.test.mjs
//
// /research-agent shares four endpoints with /account-research and sits one step
// upstream of /evidence-score. That makes it the skill most likely to grow a second
// copy of either — a research pass structure here, a grading table there — and a
// second copy is worse than no copy, because the two drift and nothing notices.
//
// The line the pack draws:
//   /account-research  one account, in depth, many fields
//   /research-agent    one field (or one question), across many rows
//   /evidence-score    whether an answer may be ASSERTED
//
// These tests hold that line structurally: not by checking a sentence exists, but by
// checking the structures that would mean it had been crossed are absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { skillBody, sections } from './helpers.mjs';
import { loadResearchRoutes } from './harness.mjs';

const BODY = skillBody();
const ROUTES = loadResearchRoutes();
const FLAT = BODY.replace(/\s+/g, ' ');

test('it does not re-describe /account-research\'s pass structure', () => {
  // The depth skill runs Pass 0-4 over one account. A freeform question across a list
  // is a different shape, and copying the passes here would mean two files deciding
  // what a research brief contains.
  assert.ok(!/\bPass [0-4]\b/.test(BODY), 'the account-research pass structure was copied in');
  assert.ok(!/\bdeep pass\b/i.test(BODY));
  assert.match(FLAT, /account-research\/SKILL\.md\)/,
    'the depth case must be routed to the skill that owns it');
  const related = sections(BODY).find(s => /^related/i.test(s.heading)).text.replace(/\s+/g, ' ');
  assert.match(related, /one account in depth/i,
    'Related must say WHEN to use the other skill, not merely link it');
});

test('it does not carry a grading table, a rubric, or a score', () => {
  // /evidence-score is the pack's fabrication boundary and the only place that decides
  // what counts as known. A second rubric here would let copy assert something this
  // skill graded and that skill never saw.
  for (const forbidden of ['dimensions', 'bands', 'rubric', 'band_hot_min',
    'emit_min_confidence', 'signals', 'points']) {
    assert.equal(ROUTES[forbidden], undefined,
      `the routing table carries \`${forbidden}\` — that belongs to /evidence-score`);
  }
  assert.ok(!/\b0-100\b/.test(BODY), 'a score belongs to /evidence-score');
  assert.ok(!/\bsupported\b\s*\/\s*\bweak\b/i.test(BODY), 'the grade vocabulary belongs to /evidence-score');
  assert.match(FLAT, /evidence-score\/SKILL\.md\)/);
});

test('the boundary names both neighbours by the job it refuses, not by their names alone', () => {
  const flat = sections(BODY).find(s => /will not/i.test(s.heading)).text.replace(/\s+/g, ' ');
  assert.match(flat, /Grading a claim belongs to/i, 'the /evidence-score boundary is unstated');
  assert.match(flat, /will not write outreach copy/i, 'the /personalize boundary is unstated');
  assert.match(flat, /will not shadow another skill's endpoints/i,
    'the handoff rule is the boundary against every skill it overlaps, and it must be written down');
});

test('the answer this skill produces is a dual-contract record, not a brief and not a score', () => {
  // One row, one record: result / confidence / reasoning / source. That is the whole
  // output contract, and it is deliberately narrower than a brief and narrower than a
  // scored row.
  assert.match(FLAT, /`result`, `confidence`, `reasoning`, `source`/,
    'the record shape must be stated where the reader writes one');
  assert.equal(ROUTES.inference.dual_contract, '_lib/dual-contract.schema.json');
  assert.equal(ROUTES.inference.llm_output_provenance, 'ai_inferred');
});

test('the handoff table covers every skill this one overlaps on endpoints', () => {
  // Sharing an endpoint with another skill is fine; answering the question that
  // endpoint exists for, here, is not. Every overlapping owner must be a handoff
  // target or the overlap is unmanaged.
  const handoff = ROUTES.templates.find(t => t.id === 'handoff');
  for (const skill of ['account-research', 'enrich-waterfall', 'build-prospect-list',
    'list-hygiene', 'signal-watch', 'tam-map', 'org-map', 'competitive-intel']) {
    assert.ok(handoff.targets[skill], `/${skill} overlaps this skill and is not a handoff target`);
    assert.ok(Array.isArray(handoff.targets[skill]) && handoff.targets[skill].length > 0,
      `/${skill} is a handoff target with no question shapes attached to it`);
  }
});
