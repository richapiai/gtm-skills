// tests/skills/evidence-score/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for this skill. The four rules are checked by running
// the REAL validator, but inside a sandbox holding only this suite's skills and their
// link targets — many skills are written in parallel into one skills/ directory,
// and this suite being green must not depend on another skill's in-progress or empty
// SKILL.md. Not hypothetical: while this suite was being written, skills/tam-map/ existed as
// a directory with no SKILL.md and failed the repo-wide validator run for reasons that
// had nothing to do with these two skills.

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

const NAME = 'evidence-score';
const SUITE = ['evidence-score', 'personalize'];
// This suite's two skills plus everything their links reach, transitively. Computed
// rather than listed: a hand-written list goes stale the week another skill adds a link,
// and the staleness shows up as a rule-1 failure in THIS suite's test.
const SANDBOX_SKILLS = linkClosure(SUITE);

const BODY = skillBody(NAME);

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(skillMd(NAME)), 'skills/evidence-score/SKILL.md is missing');
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

test('strip skills.evidence_score back out and the validator fails this skill', () => {
  // The inverse of the test above, and the reason this suite's gate citations are worth
  // anything. Before the merge this was asserted the other way round — "the skill still
  // validates once the requested keys are merged" — which stopped saying anything the
  // moment they landed. What has to stay true forever is that the citations BITE: a
  // merge that drops the block does not quietly leave this skill unthresholded, it
  // fails rule 4 in CI. A missing key reads as STOP (law 5), and the validator is where
  // that is caught before production.
  const dir = validatorSandbox(SANDBOX_SKILLS, { gatesMutate: (g) => { delete g.skills.evidence_score; } });
  const { code, out } = runValidator(dir);
  const errs = errorsFor(out, [NAME]);
  assert.ok(errs.length > 0, `the validator had nothing to say about a skill citing seven vanished keys:\n${out}`);
  assert.ok(errs.every(e => /skills\.evidence_score/.test(e)),
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
  assert.match(block, /^name: evidence-score$/m);
  assert.match(block, /^version: \d+\.\d+\.\d+$/m);
  const triggers = block.split('\n').filter(l => /^\s+- /.test(l));
  assert.ok(triggers.length >= 3, 'a skill nobody can trigger is a skill nobody uses');
});

test('rule 1 — a `## Related` section that routes onward, with links that resolve', () => {
  const headings = [...BODY.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...BODY.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, '`## Related` must link to at least one other skill');
  for (const rel of links) {
    assert.ok(existsSync(join(REPO_ROOT, 'skills', NAME, rel)), `broken link: ${rel}`);
  }
  assert.ok(links.some(l => /personalize/.test(l)),
    'the downstream consumer of these grades must be reachable from here');
});

test('rule 2 — a boundary section that names what stays external', () => {
  const headings = [...BODY.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const boundary = BODY.slice(BODY.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /guess/i, 'the boundary must restate that a dimension is never guessed');
  assert.match(boundary, /ai_inferred/, 'the boundary must restate that inferred values are not asserted');
  assert.match(boundary, /send/i, 'sending is deliberately external forever; say so');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(BODY, /richapi-skills-preflight/);
});

test('rule 3 (law 3) — the one metered call is named and shown as a dry-run plan first', () => {
  assert.match(BODY, /profile_social_metrics\(/, 'the owned endpoint must be named');
  const idx = BODY.search(/profile_social_metrics\(/);
  const after = BODY.slice(idx);
  assert.match(after, /--dry-run/, 'the metered call must be preceded or accompanied by a dry-run plan');
  assert.match(BODY, /gates\.yaml:session_budget\.fractions\.single_call_confirm/,
    'a big batch must be able to ask on its own');
});

test('rule 4 — every cited gates.yaml key resolves against the real file', () => {
  const gates = loadGates();
  const cited = [...BODY.matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)].map(m => m[1]);
  assert.ok(cited.length > 0, 'a skill with thresholds should cite at least one key');
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
  assert.deepEqual(owned, ['profile_social_metrics'], 'the owners file changed under this suite');

  const invoked = [...new Set([...BODY.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]))];
  for (const ep of invoked) {
    assert.ok(owned.includes(ep), `invokes \`${ep}()\`, which this skill does not own`);
  }
});

test('the skill states its inference mode and the reason', () => {
  assert.match(BODY, /Inference mode:/i, 'the mode must be stated, not implied');
  const idx = BODY.search(/Inference mode:/i);
  const section = BODY.slice(idx, idx + 1200);
  assert.match(section, /none/i, 'this skill runs no LLM hop, and must say so');
  assert.match(section, /never\s+calls?\s+`ai_enrich`/i);
  assert.match(section, /deterministic|lookup|addition/i, 'the reason must be given, not just the mode');
});

test('the skill is honest about its gate keys — they are merged, and it says so', () => {
  // Law 6, in both directions. Before the merge this asserted the pending note; the
  // keys have landed, so the honest statement is the opposite one and the note must be
  // gone. What does NOT change is the fail-closed contract the skill states about them.
  assert.doesNotMatch(BODY, /requested,? (and )?not yet merged/i,
    'the keys are merged — a pending note is now the inaccuracy');
  assert.match(BODY, /MissingGateKey/,
    'the skill must still state what happens when a key goes missing (law 5)');

  const gates = loadGates();
  const named = [...new Set([...BODY.matchAll(/\bskills\.evidence_score\.([a-z0-9_]+)/g)].map(m => m[1]))];
  assert.deepEqual(named.sort(), Object.keys(PINNED_GATES.evidence_score).sort(),
    'the keys the skill names and the keys this suite scores against must be the same set');
  for (const key of named) {
    assert.ok(hasGate(gates, `skills.evidence_score.${key}`),
      `skills/evidence-score/SKILL.md names skills.evidence_score.${key}, which does not resolve`);
  }
});
