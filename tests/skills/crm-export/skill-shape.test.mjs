// tests/skills/crm-export/skill-shape.test.mjs
//
// The four rules in docs/skill-shape.md are FROZEN and enforced by
// scripts/validate-skills.mjs. This suite runs the real validator against a sandbox
// holding only this skill and its link closure, so another skill's in-progress SKILL.md
// cannot decide whether this suite is green.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL, skillSource, skillBody, skillProse, citedGateKeys, directLinks, ownedEndpoints,
  invokedEndpoints, validatorSandbox, runValidator, linesFor, extractScript, SCRIPT_MARKER,
} from './helpers.mjs';
import { loadGates, gateValue, scanForBareNumbers } from '../../../_lib/gates.mjs';

const GATES = loadGates();
const body = skillBody();

test('the shipped SKILL.md draws no error or warning from the real validator', () => {
  const dir = validatorSandbox([SKILL]);
  const { out } = runValidator(dir);
  assert.deepEqual(linesFor(out, SKILL), [], `validator complained about ${SKILL}:\n${out}`);
});

test('the sole-writer rule is live — naming writeSenderExport here is a hard error', () => {
  // The rule this skill is most tempted to route around. A test that only ever sees the
  // compliant file proves nothing about the rule, so mutate the sandbox copy and check.
  const dir = validatorSandbox([SKILL]);
  const file = join(dir, 'skills', SKILL, 'SKILL.md');
  writeFileSync(file, readFileSync(file, 'utf8')
    + '\n\nSome later author writes the export with writeSenderExport() directly.\n', 'utf8');
  const { out } = runValidator(dir);
  assert.ok(linesFor(out, SKILL).some(l => /writeSenderExport/.test(l)),
    `the validator did not object to writeSenderExport in ${SKILL}:\n${out}`);
});

test('rule 1 — a `## Related` section, with every relative link resolving', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /^related\b/i.test(h)), 'no `## Related` heading');
  const links = directLinks(body);
  for (const must of ['launch', 'crm-sync-expert', 'comply', 'campaign-review']) {
    assert.ok(links.includes(must), `does not link to /${must}`);
  }
});

test('rule 2 — a boundary section exists and states the permanent ceiling', () => {
  const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map(h => h[1].trim());
  assert.ok(headings.some(h => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'no boundary section');
  assert.match(skillProse(), /No endpoint in this pack writes to one|will not sync/i,
    'true two-way CRM sync is blocked on API growth; an unstated ceiling reads as a promise');
});

test('rule 3 — it invokes no metered endpoint, and says why it needs no plan', () => {
  assert.deepEqual([...ownedEndpoints()], [], 'this skill owns no endpoints');
  assert.deepEqual([...invokedEndpoints(body)], [], 'this skill invokes no endpoints');
  assert.match(skillProse(), /makes no paid call|zero API calls/i);
});

test('rule 4 — every cited gate key resolves against the real gates.yaml', () => {
  const cited = [...citedGateKeys(body)];
  assert.ok(cited.length > 0, 'a skill that reports a quality floor must cite the key it comes from');
  for (const key of cited) {
    assert.doesNotThrow(() => gateValue(GATES, key), `gates.yaml:${key} does not resolve`);
  }
  assert.ok(cited.includes('quality_stops.coverage_min_pct'),
    'the coverage floor the script reports against must be cited in the prose too');
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

test('the gate the tests exercise is the one the skill ships', () => {
  const script = extractScript();
  assert.ok(script.split('\n', 1)[0].includes(SCRIPT_MARKER));
  // Pinned by structure, not by punctuation: the command, the variable name, and the
  // fail-closed `${VAR:?msg}` required form. The message text is prose and may be
  // reworded; the `:?` may not be dropped. A bare "$GTM_CRM_EXPORT" that is unset makes
  // `node --input-type=module -e ""` exit 0 with no output, so a copy-pasted fence
  // skips the export gate and reports success. See
  // tests/spend-gates/skill-inline-script-fail-closed.test.mjs for the tree-wide rule.
  assert.match(body, /node --input-type=module -e "\$\{GTM_CRM_EXPORT:\?[^}\n]+\}"/,
    'the SKILL.md must tell the user to run exactly what these tests run, in the '
    + 'fail-closed ${GTM_CRM_EXPORT:?...} form');
  assert.match(script, /exit 0 = written, 3 = refused .*, 2 = could not run/,
    'the exit-code contract must be documented where the user reads the script');
});

test('inference mode is stated, is local, and refuses the paid hop for a named reason', () => {
  const s = skillProse();
  assert.match(s, /Mode: local inference only/i);
  assert.ok(!body.includes('ai_enrich('), 'ai_enrich must never be invoked here');
  assert.match(s, /local-inference rule/i);
  assert.match(s, /Perplexity/i, 'name the first condition that would justify the paid hop');
  assert.match(s, /[Bb]atch scale/, 'name the second');
});
