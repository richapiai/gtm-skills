// tests/skills/pre-meeting-briefing/skill-shape.test.mjs
//
// The four rules in docs/skill-shape.md are FROZEN and enforced by
// scripts/validate-skills.mjs. This suite runs the real validator against a sandbox
// holding only this skill and its link closure, so another skill's in-progress SKILL.md
// cannot decide whether this suite is green — and so a rule that stops being enforced
// upstream fails here rather than silently passing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL, SKILL_MD, skillSource, skillBody, citedGateKeys, directLinks,
  validatorSandbox, runValidator, linesFor, REPO_ROOT,
} from './helpers.mjs';
import { loadGates, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';

const GATES = loadGates();
const body = skillBody();

test('the shipped SKILL.md draws no error or warning from the real validator', () => {
  const dir = validatorSandbox([SKILL]);
  const { out } = runValidator(dir);
  assert.deepEqual(linesFor(out, SKILL), [], `validator complained about ${SKILL}:\n${out}`);
});

test('rule 1 — a `## Related` section, with every relative link resolving', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'no `## Related` heading');
  const links = directLinks(body);
  assert.ok(links.length >= 3, 'a composition skill that routes to fewer than three skills is a dead end');
  // The whole design is delegation, so the two skills it borrows from must be reachable.
  for (const must of ['account-research', 'enrich-waterfall']) {
    assert.ok(links.includes(must), `does not link to /${must}, which it delegates its fetching to`);
  }
});

test('rule 2 — a boundary section exists and states the permanently-external ceiling', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'no boundary section');
  assert.match(body, /dial|calling/i,
    'the plan lists dialing and live calling as deliberately external forever, and this skill '
    + 'flanks a call — an unstated ceiling reads as a promise');
});

test('rule 3 — law 3 is satisfied, and satisfied honestly', () => {
  // This skill invokes no metered endpoint, so the validator's rule 3 does not fire.
  // That is only acceptable while the skill genuinely spends nothing of its own, and
  // it still has to show a plan for the spend it CAUSES elsewhere.
  const invoked = [...body.matchAll(/`([a-z_][a-z0-9_]{3,})\(/g)].map(m => m[1]);
  assert.deepEqual(invoked, [], `invokes ${invoked.join(', ')} — this skill owns no endpoints`);
  assert.match(body, /--dry-run/, 'the delegated spend must still be planned before it runs');
  assert.match(body, /zero calls/i, 'the skill must state that a dry run makes no calls');
  assert.match(body, /one approval for the whole plan/i,
    'the user approves one plan; a per-call nod is how a time-boxed brief becomes an open tab');
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = [...citedGateKeys(body)];
  assert.ok(cited.length > 0, 'a skill that constrains spend must cite the keys it constrains it with');
  for (const key of cited) {
    assert.doesNotThrow(() => gateValue(GATES, key), `gates.yaml:${key} does not resolve`);
  }
});

test('law 1 — no bare credit, spend, quality or TTL number in the prose', () => {
  const hits = scanForBareNumbers(body, { file: `skills/${SKILL}/SKILL.md` });
  assert.deepEqual(hits.map(h => `${h.line}: ${h.message}`), []);
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  const src = skillSource();
  const fm = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `frontmatter is missing ${key}`);
  }
  assert.match(fm, new RegExp(`^name: ${SKILL}$`, 'm'));
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m);
  assert.match(src, /richapi-skills-preflight/, 'missing the preflight preamble');
});

test('the shape rules are actually load-bearing — removing `## Related` fails the sandbox', () => {
  // A shape test that only ever sees a passing file proves nothing about the rule. This
  // mutates the copy inside the sandbox and asserts the validator notices.
  const dir = validatorSandbox([SKILL]);
  const file = join(dir, 'skills', SKILL, 'SKILL.md');
  const src = readFileSync(file, 'utf8');
  writeFileSync(file, src.replace(/\n## Related\n[\s\S]*$/, '\n'), 'utf8');
  const { out } = runValidator(dir);
  assert.ok(linesFor(out, SKILL).some(l => /Related/.test(l)),
    `the validator did not object to a missing \`## Related\`:\n${out}`);
});

test('the skill is registered nowhere it should not be — it owns no gates.yaml block', () => {
  // These tests may not edit gates.yaml. If a `skills.pre_meeting_briefing` block ever
  // appears, this test is the reminder to cite it here instead of leaning on
  // account_research's ceilings.
  const gatesSrc = readFileSync(join(REPO_ROOT, '_lib', 'gates.yaml'), 'utf8');
  const hasOwnBlock = /^\s{2}pre_meeting_briefing:/m.test(gatesSrc);
  if (hasOwnBlock) {
    assert.ok(body.includes('gates.yaml:skills.pre_meeting_briefing.'),
      'gates.yaml now carries a skills.pre_meeting_briefing block, but this skill still '
      + 'borrows account_research ceilings. Cite its own keys.');
  } else {
    assert.ok(body.includes('gates.yaml:skills.account_research.'),
      'with no block of its own, the skill must cite the ceilings it inherits from the '
      + 'skill that owns the endpoints');
  }
});
