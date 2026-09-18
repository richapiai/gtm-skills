// tests/skills/outreach-expert/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for /outreach-expert. The helpers come from
// tests/skills/crm-sync-expert/helpers.mjs — this suite owns both directories, and one
// copy of the validator sandbox is the point: two copies drift, and a drifted sandbox
// is a green run that proves nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';
import {
  SUITE_SKILLS, skillDir, skillMd, skillBody, frontmatterBlock, headings, boundarySection,
  validatorSandbox, runValidator, linkClosure,
} from '../crm-sync-expert/helpers.mjs';

const NAME = 'outreach-expert';
const body = skillBody(NAME);
const LINKED = linkClosure(SUITE_SKILLS);

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(skillMd(NAME)), `skills/${NAME}/SKILL.md is missing`);
});

test('the real validator passes this suite, isolated from every other skill', () => {
  const dir = validatorSandbox(LINKED);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed over ${LINKED.join(', ')}:\n${out}`);
  assert.match(out, /0 warning\(s\)/, `validator emitted warnings:\n${out}`);
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const block = frontmatterBlock(NAME);
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(block, new RegExp(`^name: ${NAME}$`, 'm'));
  assert.match(block, /^version: \d+\.\d+\.\d+$/m);
  const triggers = block.split('\n').filter(l => /^\s+- /.test(l));
  assert.ok(triggers.length >= 3, 'a skill nobody can trigger is a skill nobody uses');
});

test('the description says it does not send, before the body gets a chance to', () => {
  // An agent router reads the description and nothing else. If it reads as a sending
  // tool, the boundary section two hundred lines down is never reached.
  // Whitespace-normalised first. `description:` is a FOLDED YAML scalar (`>`), so a
  // line break inside it carries no meaning — but matching the raw block means any
  // re-wrap that happens to split "never sends" across two lines fails this test while
  // the description still says exactly what it must. That is a test that guards its own
  // line wrapping instead of the claim.
  const description = frontmatterBlock(NAME).replace(/\s+/g, ' ');
  assert.match(description, /never sends|does not send/i);
});

test('rule 1 — a `## Related` section whose relative links all resolve', () => {
  assert.ok(headings(body).some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, '`## Related` must route onward to at least one skill');
  for (const rel of links) {
    assert.ok(existsSync(join(skillDir(NAME), rel)), `broken link: ${rel}`);
  }
  for (const must of ['comply', 'launch', 'campaign-review', 'list-hygiene', 'crm-sync-expert']) {
    assert.ok(links.some(l => l.includes(`/${must}/`)), `does not route to /${must}`);
  }
});

test('rule 2 — a boundary section exists and is not a formality', () => {
  assert.ok(headings(body).some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  assert.ok(boundarySection(body).length > 400,
    'the boundary is the load-bearing part of a skill that cannot execute; a one-liner is not one');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(body, /richapi-skills-preflight/);
});

test('rule 4 — every gate key the skill cites resolves against the real gates.yaml', () => {
  const gates = loadGates();
  const cited = [...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= 3,
    'a deliverability skill lives on thresholds; it must cite them, not restate them');
  for (const key of cited) {
    assert.ok(hasGate(gates, key),
      `gates.yaml:${key} does not resolve — a missing key reads as STOP (law 5)`);
  }
  // The two the pack genuinely owns for this subject must be the ones cited.
  for (const key of ['quality_stops.verification_max_hard_bounce_pct',
                     'quality_stops.verification_max_fail_rate_pct']) {
    assert.ok(cited.includes(key), `the skill does not cite gates.yaml:${key}`);
  }
});

test('law 1 — no hand-typed warmup ramp, send rate, bounce ceiling or percentage', () => {
  // The hardest rule to hold in this skill and the most important: every number a
  // deliverability advisor wants to type is a number that moved last quarter.
  const hits = scanForBareNumbers(body, { file: `skills/${NAME}/SKILL.md` });
  assert.deepEqual(hits, [], hits.map(h => `line ${h.line}: ${h.message}`).join('\n'));
});

test('the CLI verbs it names are verbs the CLI actually has', () => {
  const REAL = new Set(['enrich', 'call', 'search', 'preflight', 'catalog', 'gates', 'help']);
  for (const m of body.matchAll(/\brichapi\s+([a-z][a-z-]*)/g)) {
    if (m[1] === 'skills-preflight') continue;
    assert.ok(REAL.has(m[1]), `\`richapi ${m[1]}\` is not a subcommand of bin/richapi`);
  }
});
