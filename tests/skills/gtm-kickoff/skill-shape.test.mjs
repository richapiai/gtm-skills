// tests/skills/gtm-kickoff/skill-shape.test.mjs
//
// docs/skill-shape.md, asserted for this skill. The four rules are checked by running
// the REAL validator inside a sandbox holding only this suite's two skills and their
// link targets — many skills are written in parallel into one skills/ directory, and this suite
// being green must not depend on another skill's in-progress half-written SKILL.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadGates, hasGate } from '../../../_lib/gates.mjs';
import { scanForBareNumbers } from '../../../_lib/gates.mjs';
import { REPO_ROOT, SKILL_DIR, SKILL_MD, SKILL_NAME, skillSource, skillBody,
         validatorSandbox, runValidator, linkClosure } from './helpers.mjs';

// This suite's two skills plus everything they route to, transitively — rule 1 makes
// the validator resolve every link, so the sandbox needs the link targets and nothing
// else. Many skills are written into skills/ at once; none of the others may decide this result.
const LINKED = linkClosure(['gtm-kickoff', 'icp-review']);

test('the skill exists where the pack expects it', () => {
  assert.ok(existsSync(SKILL_MD), 'skills/gtm-kickoff/SKILL.md is missing');
});

test('the real validator passes this suite, isolated from every other skill', () => {
  assert.ok(LINKED.includes('gtm-kickoff') && LINKED.includes('icp-review'),
    `the sandbox must contain both of this suite's skills; got ${LINKED.join(', ')}`);
  const dir = validatorSandbox(LINKED);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, `validator failed over ${LINKED.join(', ')}:\n${out}`);
  assert.match(out, new RegExp(`${LINKED.length} skill\\(s\\) validated`));
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource();
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const block = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(block, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(block, new RegExp(`^name: ${SKILL_NAME}$`, 'm'));
  assert.match(block, /^version: \d+\.\d+\.\d+$/m);
  const triggers = block.split('\n').filter(l => /^\s+- /.test(l));
  assert.ok(triggers.length >= 3, 'a skill nobody can trigger is a skill nobody uses');
});

test('rule 1 — a `## Related` section whose relative links all resolve', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map(m => m[1]);
  assert.ok(links.length > 0, '`## Related` must route onward to at least one skill');
  for (const rel of links) {
    assert.ok(existsSync(join(SKILL_DIR, rel)), `broken link: ${rel}`);
  }
  assert.ok(links.some(l => l.includes('icp-review')),
    'the kickoff must route to the skill that turns its hypothesis into an ICP');
});

test('rule 2 — a boundary section naming what stays external', () => {
  const body = skillBody();
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  assert.match(boundary, /send/i, 'sending is deliberately external forever; say so');
  assert.match(boundary, /approval/i,
    'the boundary must restate that the brief is not written without approval');
  assert.match(boundary, /research/i,
    'this skill owns one endpoint and cannot research; an unstated ceiling reads as a promise');
});

test('rule 3 — the preflight preamble is present', () => {
  assert.match(skillBody(), /richapi-skills-preflight/);
});

test('rule 3 — the one endpoint it names is covered by a visible plan', () => {
  const body = skillBody();
  assert.match(body, /dry[- ]?run/i, 'even a zero-priced call goes on a plan (law 3)');
  assert.match(body, /gates\.yaml/, 'the skill must cite policy rather than state it');
});

test('rule 4 — every gate key the skill cites resolves against the real gates.yaml', () => {
  const gates = loadGates();
  const cited = [...skillBody().matchAll(/gates\.yaml:([a-z0-9_]+(?:\.[a-z0-9_]+)+)/gi)]
    .map(m => m[1]);
  assert.ok(cited.length >= 4,
    'the kickoff is where the session budget is set; it must cite those keys, not describe them');
  for (const key of cited) {
    assert.ok(hasGate(gates, key), `gates.yaml:${key} does not resolve — a missing key reads as STOP (law 5)`);
  }
  // The budget conversation belongs here, so these specific keys must be the ones cited.
  for (const key of ['session_budget.ask_once_per_session', 'session_budget.suggestion_credits',
                     'session_budget.fractions.stop', 'session_budget.on_stop']) {
    assert.ok(cited.includes(key), `the skill does not cite gates.yaml:${key}`);
  }
});

test('law 1 — no hand-typed credit number, threshold, TTL or percentage in the prose', () => {
  const hits = scanForBareNumbers(skillBody(), { file: `skills/${SKILL_NAME}/SKILL.md` });
  assert.deepEqual(hits, [], hits.map(h => `line ${h.line}: ${h.message}`).join('\n'));
});

test('the skill is honest that the runtime cannot issue its one endpoint yet', () => {
  const body = skillBody();
  assert.match(body, /refuses to (issue|send)/i,
    'law 6: the empty-POST guard blocks search_reference_data today, so do not imply it works');
  assert.match(body, /filters-catalog\.json/,
    'the working path — the local snapshot — must be named, not just the blocked one');
});

test('the brief is never written before approval, in the prose and in the contract', () => {
  const body = skillBody();
  assert.match(body, /only after approval|after explicit approval/i);
  assert.match(readFileSync(SKILL_MD, 'utf8'), /write_requires_explicit_approval: true/,
    'the machine-readable contract must carry the rule, not only the prose');
});

test('the documented steps run in the order the skill claims', () => {
  const body = skillBody();
  const at = re => body.search(re);
  const interview = at(/^##.*the interview/im);
  const challenge = at(/^##.*challenge the premise/im);
  const write     = at(/^##.*write the brief/im);
  assert.ok(interview > -1 && challenge > -1 && write > -1, 'a documented step is missing');
  assert.ok(interview < challenge, 'you cannot challenge a premise you have not heard');
  assert.ok(challenge < write, 'the challenge is mandatory BEFORE the artifact exists');
});
