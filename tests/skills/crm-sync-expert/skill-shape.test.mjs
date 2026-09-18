// tests/skills/crm-sync-expert/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for /crm-sync-expert. The four rules are checked by
// running the REAL validator inside a sandbox holding only this suite's two skills and
// their link targets — many skills are written in parallel into one skills/ directory, and this
// suite being green must not depend on another skill's in-progress SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';
import {
  SUITE_SKILLS, skillDir, skillMd, skillBody, frontmatterBlock, headings, boundarySection,
  validatorSandbox, runValidator, linkClosure,
} from './helpers.mjs';

const NAME = 'crm-sync-expert';
const body = skillBody(NAME);

// Both of this suite's skills plus everything they route to, transitively.
const LINKED = linkClosure(SUITE_SKILLS);

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(skillMd(NAME)), `skills/${NAME}/SKILL.md is missing`);
});

test('the real validator passes this suite, isolated from every other skill', () => {
  for (const s of SUITE_SKILLS) {
    assert.ok(LINKED.includes(s), `the sandbox must contain ${s}; got ${LINKED.join(', ')}`);
  }
  const dir = validatorSandbox(LINKED);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed over ${LINKED.join(', ')}:\n${out}`);
  assert.match(out, new RegExp(`${LINKED.length} skill\\(s\\) validated`));
  // Definition of done is zero WARNINGS, not merely a zero exit code. The validator
  // prints warnings and still exits 0, so a passing exit proves less than it looks.
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

test('the description warns the reader before they read the body', () => {
  // The description is what an agent router reads. If it implies execution, the
  // boundary section three hundred lines down never gets a chance.
  const block = frontmatterBlock(NAME);
  assert.match(block, /never writes to a CRM|does not write to a CRM/i,
    'the description must say the skill does not write to a CRM');
});

test('rule 1 — a `## Related` section whose relative links all resolve', () => {
  assert.ok(headings(body).some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, '`## Related` must route onward to at least one skill');
  for (const rel of links) {
    assert.ok(existsSync(join(skillDir(NAME), rel)), `broken link: ${rel}`);
  }
  for (const must of ['comply', 'launch', 'list-hygiene', 'outreach-expert', 'crm-export']) {
    assert.ok(links.some(l => l.includes(`/${must}/`)), `does not route to /${must}`);
  }
});

test('rule 2 — a boundary section exists and is not a formality', () => {
  assert.ok(headings(body).some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  assert.ok(boundarySection(body).length > 400,
    'the boundary section is the load-bearing part of an advisory skill; a one-liner is not one');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(body, /richapi-skills-preflight/);
});

test('rule 4 — every gate key the skill cites resolves against the real gates.yaml', () => {
  const gates = loadGates();
  const cited = [...body.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length >= 2,
    'a skill that states a threshold must cite it; a skill that cites none has stated none');
  for (const key of cited) {
    assert.ok(hasGate(gates, key),
      `gates.yaml:${key} does not resolve — a missing key reads as STOP (law 5)`);
  }
});

test('law 1 — no hand-typed credit number, threshold, TTL or percentage in the prose', () => {
  const hits = scanForBareNumbers(body, { file: `skills/${NAME}/SKILL.md` });
  assert.deepEqual(hits, [], hits.map(h => `line ${h.line}: ${h.message}`).join('\n'));
});

test('the CLI verbs it names are verbs the CLI actually has', () => {
  // `richapi call`, `richapi search`, `richapi catalog`, `richapi gates`, `richapi
  // enrich`, `richapi preflight`, `richapi help`. Inventing a subcommand is the
  // cheapest way to make a skill unrunnable, and nothing else checks for it.
  const REAL = new Set(['enrich', 'call', 'search', 'preflight', 'catalog', 'gates', 'help']);
  for (const m of body.matchAll(/\brichapi\s+([a-z][a-z-]*)/g)) {
    if (m[1] === 'skills-preflight') continue;   // the separate bin, not a subcommand
    assert.ok(REAL.has(m[1]), `\`richapi ${m[1]}\` is not a subcommand of bin/richapi`);
  }
});
