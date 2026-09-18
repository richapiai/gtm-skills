// tests/skills/personalize/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for this skill, by running the REAL validator inside a
// sandbox holding only this suite's skills and their link targets. Many skills fan out
// into one skills/ directory and this suite being green must not depend on another
// skill's in-progress or empty SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

import { loadGates, hasGate, scanForBareNumbers } from '../../../_lib/gates.mjs';
import {
  REPO_ROOT, skillMd, skillSource, skillBody, validatorSandbox, runValidator,
  PINNED_GATES, linkClosure, errorsFor,
} from './helpers.mjs';

const NAME = 'personalize';
const SUITE = ['evidence-score', 'personalize'];
const SANDBOX_SKILLS = linkClosure(SUITE);

const BODY = skillBody(NAME);

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(skillMd(NAME)), 'skills/personalize/SKILL.md is missing');
});

test('the real validator passes this skill (all four shape rules)', () => {
  const dir = validatorSandbox(SANDBOX_SKILLS);
  const { code, out } = runValidator(dir);
  // Isolation: this suite is green when the validator has nothing to say about THIS
  // suite's skills. Another skill's in-progress SKILL.md sitting in the link closure must
  // not decide whether these two are shaped correctly.
  assert.deepEqual(errorsFor(out, SUITE), [], `validator failed on this suite:\n${out}`);
  assert.match(out, /0 warning\(s\)/, `validator warned:\n${out}`);
  assert.equal(code, 0, `validator failed for another skill's reasons:\n${out}`);
});

test('strip skills.personalize back out and the validator fails this skill', () => {
  // The inverse of the test above. Before the merge this asserted "the skill still
  // validates once the requested key is merged", which stopped saying anything once it
  // did. The property that has to hold forever is that the citation BITES: a merge that
  // drops the block fails rule 4 in CI rather than leaving the batch route quietly
  // unthresholded. A missing key reads as STOP, never as "no gate" (law 5).
  const dir = validatorSandbox(SANDBOX_SKILLS, { gatesMutate: (g) => { delete g.skills.personalize; } });
  const { code, out } = runValidator(dir);
  const errs = errorsFor(out, [NAME]);
  assert.ok(errs.length > 0, `the validator had nothing to say about a skill citing a vanished key:\n${out}`);
  assert.ok(errs.every(e => /skills\.personalize\.ai_enrich_batch_min_rows/.test(e)),
    `the failures are not the ones the strip should cause:\n${errs.join('\n')}`);
  assert.notEqual(code, 0, 'a gates.yaml that lost this block must not exit clean');
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource(NAME).replace(/\r\n/g, '\n');
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const block = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(block, /^name: personalize$/m);
  assert.match(block, /^version: \d+\.\d+\.\d+$/m);
  const triggers = block.split('\n').filter(l => /^\s+- /.test(l));
  assert.ok(triggers.length >= 3, 'a skill nobody can trigger is a skill nobody uses');
});

test('rule 1 — a `## Related` section that routes onward, with links that resolve', () => {
  const headings = [...BODY.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...BODY.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  for (const rel of links) {
    assert.ok(existsSync(join(REPO_ROOT, 'skills', NAME, rel)), `broken link: ${rel}`);
  }
  assert.ok(links.some(l => /evidence-score/.test(l)),
    'the grader this skill delegates to must be reachable from here');
});

test('rule 2 — a boundary section that names what stays external', () => {
  const headings = [...BODY.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const boundary = BODY.slice(BODY.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /hedge/i, 'the boundary must refuse the hedge, not only the invention');
  assert.match(boundary, /ai_inferred/, 'the boundary must refuse asserting an inferred value');
  assert.match(boundary, /suppress/i, 'no draft for a contact it cannot screen');
  assert.match(boundary, /send/i, 'sending is deliberately external forever; say so');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(BODY, /richapi-skills-preflight/);
});

test('rule 3 (law 3) — the metered hop is named and shown as a dry-run plan first', () => {
  assert.match(BODY, /ai_enrich\(/, 'the endpoint must be named where it is invoked');
  assert.match(BODY, /--dry-run/, 'a metered call needs a visible plan before it runs');
  assert.match(BODY, /gates\.yaml:session_budget\.fractions\.single_call_confirm/);
});

test('rule 4 — every cited gates.yaml key resolves against the real file', () => {
  const gates = loadGates();
  const cited = [...BODY.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length > 0);
  for (const key of cited) {
    assert.ok(hasGate(gates, key), `cites gates.yaml:${key}, which does not resolve`);
  }
});

test('law 1 — no bare threshold number anywhere in the body', () => {
  const findings = scanForBareNumbers(BODY, { file: `skills/${NAME}/SKILL.md` });
  assert.deepEqual(findings, [], JSON.stringify(findings, null, 1));
});

test('this suite invokes only the endpoint _lib/endpoint-owners.yaml gives it', () => {
  const owners = parseYaml(readFileSync(join(REPO_ROOT, '_lib', 'endpoint-owners.yaml'), 'utf8'));
  const owned = Object.entries(owners.endpoints)
    .filter(([, list]) => (list || []).includes(NAME))
    .map(([ep]) => ep);
  assert.deepEqual(owned, ['ai_enrich'], 'the owners file changed under this suite');

  const invoked = [...new Set([...BODY.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]))];
  for (const ep of invoked) {
    assert.ok(owned.includes(ep), `invokes \`${ep}()\`, which this skill does not own`);
  }
});

test('the Iron Law is stated as a law, not as a preference', () => {
  assert.match(BODY, /^#{2,3}\s+The Iron Law\s*$/m, 'the law needs its own heading, not a footnote');
  assert.match(BODY, /No claim in copy without a source line in the research brief/i);
});

test('the skill states its inference mode and the reason, and both exceptions', () => {
  assert.match(BODY, /Inference mode:/i);
  const idx = BODY.search(/Inference mode:/i);
  const section = BODY.slice(idx, idx + 2500);
  assert.match(section, /local agent inference/i, 'the mode must be named');
  assert.match(section, /metered|charge|billing/i, 'the reason must be given, not just the mode');
  assert.match(section, /Perplexity/i, 'exception 1 — web grounding');
  assert.match(section, /search_domain_filter/);
  assert.match(section, /search_recency_filter/);
  assert.match(section, /Batch scale/i, 'exception 2 — batch scale');
  assert.match(section, /openapi\.yaml/, 'the Perplexity-only claim must cite where it comes from');
});

test('the skill is honest about its gate key — it is merged, and it says so', () => {
  // Was: "honest that its gate key is not merged yet". It is merged, so the honest
  // statement flipped. The fail-closed sentence the skill makes about the key did not.
  assert.doesNotMatch(BODY, /requested,? (and )?not yet merged/i,
    'the key is merged — a pending note is now the inaccuracy');
  assert.match(BODY, /MissingGateKey/,
    'the skill must still state what happens when the key goes missing (law 5)');

  const gates = loadGates();
  const named = [...new Set([...BODY.matchAll(/\bskills\.personalize\.([a-z0-9_]+)/g)].map(m => m[1]))];
  assert.deepEqual(named.sort(), Object.keys(PINNED_GATES.personalize).sort(),
    'the keys the skill names and the keys this suite drafts against must be the same set');
  for (const key of named) {
    assert.ok(hasGate(gates, `skills.personalize.${key}`),
      `skills/personalize/SKILL.md names skills.personalize.${key}, which does not resolve`);
  }
});
