// tests/skills/sequence-builder/skill-shape.test.mjs
//
// docs/skill-shape.md is FROZEN and enforces four rules, all errors. This runs the real
// validator over a sandbox holding this skill and its link closure, and asserts that no
// error and no WARNING names this skill — a warning here would mean the sole-writer exemption
// was leaned on.
//
// It filters by skill label rather than asserting on the global exit code, because the
// link closure necessarily drags in siblings other skills own and a red sibling must not
// turn this suite red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL, REPO_ROOT, skillSource, skillBody, citedGateKeys,
  validatorSandbox, runValidator, linesFor,
} from './helpers.mjs';

const body = skillBody();
const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());

test('the real validator reports neither an error nor a warning for this skill', () => {
  const dir = validatorSandbox([SKILL]);
  const { out } = runValidator(dir);
  const mine = linesFor(out, SKILL);
  assert.deepEqual(mine, [], `validator output naming ${SKILL}:\n${mine.join('\n')}`);
});

test('rule 1 — `## Related` exists and every relative link resolves', () => {
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing a `## Related` section');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, 'a skill that routes onward has at least one link');
  for (const rel of links) {
    assert.ok(existsSync(join(REPO_ROOT, 'skills', SKILL, rel)), `broken link: ${rel}`);
  }
});

test('rule 2 — a boundary section exists', () => {
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section — an unstated ceiling reads as a promise');
});

test('rule 3 — vacuous here, and that is the point: no metered call to plan for', () => {
  const invoked = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  assert.deepEqual(invoked, [], 'rule 3 has nothing to bite on because this skill spends nothing');
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', async () => {
  const { loadGates, hasGate } = await import(join(REPO_ROOT, '_lib', 'gates.mjs'));
  const g = loadGates();
  const cited = citedGateKeys(body);
  assert.ok(cited.length > 0,
    'this skill cites downstream thresholds by key, so the rule must actually be exercised');
  for (const key of cited) {
    assert.ok(hasGate(g, key),
      `cites gates.yaml:${key}, which does not resolve — a missing key reads as STOP (law 5)`);
  }
});

test('the cadence thresholds are answered from a key, never typed from memory', () => {
  // WAS: "the thresholds it does not yet have a key for are described, never typed".
  // Step count, the spacing floor and the total window are policy numbers this pack
  // sets, and for two phases they had no home: the skill deferred them to a
  // gates.yaml namespace nobody had written, so the one question it exists to answer
  // — how many follow-ups, how far apart — got a shape and no number. The namespace
  // landed, and the obligation flipped. The skill must now ANSWER, and the answer
  // must still trace to a key on the same line, which is what stops the number from
  // being retyped from memory the next time somebody edits this file.
  for (const key of ['skills.sequence_builder.max_steps',
                     'skills.sequence_builder.min_gap_business_days',
                     'skills.sequence_builder.max_window_business_days']) {
    assert.ok(citedGateKeys(body).includes(key),
      `the skill must cite gates.yaml:${key} — it owns this threshold and may not restate it`);
  }
  assert.match(body, /how many\s+follow-ups/i,
    'the headline question must be named, so the answer is findable by the person asking it');
  const prose = body.split("\n").filter(l => !/^\s*```/.test(l));
  const offenders = [];
  for (const line of prose) {
    if (/^\s*(Segment|Step|One ask|Channel|Calendar)\s{2,}/.test(line)) continue;
    if (/gates\.yaml/.test(line)) continue;
    if (/(?<!\w)\d[\d,]*(?:\.\d+)?\s*(?:credits?|cr)\b/i.test(line)) offenders.push(line.trim());
    if (/\b(?:at least|minimum of|no fewer than|floor of)\s+\d/i.test(line)) offenders.push(line.trim());
  }
  assert.deepEqual(offenders, [], 'hand-typed threshold in prose (law 1)');
});

test('the frontmatter carries what the validator requires', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'frontmatter fence');
  const fm = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `missing frontmatter key: ${key}`);
  }
  assert.match(fm, /^name: sequence-builder$/m, 'frontmatter name must match the directory');
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m, 'version must be semver');
  assert.ok(body.includes('richapi-skills-preflight'), 'missing the preflight preamble');
});

test('it invents no CLI verb', () => {
  const known = new Set(['call', 'search', 'enrich', 'preflight', 'catalog', 'gates', 'help']);
  for (const m of body.matchAll(/\brichapi ([a-z-]+)/g)) {
    assert.ok(known.has(m[1]), `invented CLI verb: richapi ${m[1]}`);
  }
});
