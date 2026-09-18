// tests/skills/local-business-prospecting/skill-shape.test.mjs
//
// docs/skill-shape.md is FROZEN and enforced by scripts/validate-skills.mjs. This file
// runs the REAL validator over a sandbox holding only this suite's skill and the
// transitive closure of its links, so the suite is judged on its own output rather than
// on whether a neighbouring skill happens to have a half-written SKILL.md on disk.
//
// It then asserts the two things the validator deliberately does not: that the skill
// carries the reference spine (dry-run -> approve -> run -> report honestly) and that
// its inference mode is stated, because "we never called ai_enrich" is a claim
// nobody can check after the fact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  SKILL, REPO_ROOT, SKILL_MD, skillSource, skillBody, skillProse,
  linkClosure, validatorSandbox, runValidator,
} from './helpers.mjs';

const src = skillSource();
const body = skillBody();
const prose = skillProse();
const headings = [...body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((h) => h[1].trim());

test('the real validator passes over this skill and everything it links to', () => {
  const closure = linkClosure();
  const dir = validatorSandbox(closure);
  const { code, out } = runValidator(dir);
  assert.equal(code, 0, out);
  assert.ok(!/^\s*!\s/m.test(out) || !out.includes(SKILL),
    `the validator warned about ${SKILL}:\n${out}`);
});

test('frontmatter carries every required key, and the name matches the directory', () => {
  assert.ok(src.startsWith('---\n'), 'no frontmatter fence');
  const fm = src.slice(4, src.indexOf('\n---\n', 4));
  for (const key of ['name', 'version', 'description', 'allowed-tools', 'triggers']) {
    assert.match(fm, new RegExp('^' + key + ':', 'm'), `missing frontmatter key: ${key}`);
  }
  assert.match(fm, new RegExp('^name: ' + SKILL + '$', 'm'));
  assert.match(fm, /^version: \d+\.\d+\.\d+$/m);
});

test('rule 1 — the skill routes onward, and every link resolves', () => {
  assert.ok(headings.some((h) => /^related\b/i.test(h)), 'missing `## Related`');
  const links = [...body.matchAll(/\]\((\.\.\/[^)]+\/SKILL\.md)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 5, 'a sourcing skill that routes to fewer than five places is a dead end');
  for (const rel of links) {
    assert.ok(existsSync(join(REPO_ROOT, 'skills', SKILL, rel)), `broken link: ${rel}`);
  }
});

test('rule 2 — the ceiling is stated, and it includes the ones that are external forever', () => {
  assert.ok(headings.some((h) => /will not|won't do|not in scope|boundar|limitations/i.test(h)),
    'missing a boundary section');
  const boundary = body.slice(body.search(/^#{2,3}\s+.*will not/im));
  // Local outreach is exactly where somebody asks for the dialer and the SMS blast.
  for (const external of [/send/i, /dial/i, /LinkedIn/]) {
    assert.match(boundary, external,
      'the permanently-external list matters most in the skill whose users will ask for it');
  }
});

test('rule 3 — a metered call is preceded by a visible plan', () => {
  assert.match(body, /--dry-run/, 'the plan is shown as a command, not only promised in prose');
  assert.match(prose, /zero calls/i, 'say that a dry run spends nothing');
  assert.match(prose, /one approval for the whole plan/i,
    'the user approves the plan, not a nod per call');
});

test('the reference spine is present, in order', () => {
  const stages = [
    /richapi-skills-preflight/,                 // before anything else
    /--dry-run/,                                // plan
    /approval/i,                                // approve
    /suppress/i,                                // run, and write suppressed
    /[Rr]eport honestly|report it honestly/,    // report
  ];
  let at = -1;
  for (const re of stages) {
    const next = body.slice(at + 1).search(re);
    assert.ok(next > -1, `the spine stage ${re} is missing or out of order`);
    at = at + 1 + next;
  }
});

test('the preflight preamble is present and its keys are interpreted, not just printed', () => {
  assert.match(body, /richapi-skills-preflight/);
  for (const key of ['CATALOG_OK', 'API_KEY_SET', 'SUPPRESSION', 'BALANCE']) {
    assert.ok(prose.includes(key), `the preflight key ${key} is printed but never interpreted`);
  }
  assert.match(prose, /BALANCE: unknown[^.]*normal|unknown[^.]*not a blocker/i,
    'an unknown balance is the honest state, not a failure — say so');
});

test('the inference mode is stated, and both paid-hop conditions are addressed', () => {
  assert.ok(headings.some((h) => /inference mode/i.test(h)), 'the inference mode must be a section');
  assert.match(prose, /local inference/i);
  assert.match(prose, /never calls `?ai_enrich`?/i, 'state the negative explicitly');
  assert.match(prose, /Perplexity/, 'address the web-grounding case by name');
  assert.match(prose, /[Bb]atch scale/, 'address the batch-scale case by name');
  assert.ok(!/`ai_enrich\(/.test(body), 'ai_enrich() must not be invoked');
});

test('the output is suppression-gated and the PII law is named', () => {
  assert.match(prose, /suppress/i);
  assert.match(prose, /law 7|`gtm\/` is PII/i,
    'gtm/ is PII even when the fields look like business contact details');
  assert.match(prose, /not_found/, 'the explicit null enum must be used');
  assert.match(prose, /not_verifiable/);
  assert.match(prose, /not_applicable/);
});

test('the skill does not claim a CLI verb the runtime does not ship', () => {
  const verbs = [...body.matchAll(/`?richapi\s+([a-z-]+)/g)].map((m) => m[1]);
  const shipped = new Set(['enrich', 'call', 'search', 'preflight', 'catalog', 'gates', 'help']);
  for (const v of new Set(verbs)) {
    assert.ok(shipped.has(v), `\`richapi ${v}\` is not a verb the runtime ships`);
  }
  // And the CLI's own usage text must still agree with that set.
  const cli = readFileSync(join(REPO_ROOT, 'bin', 'richapi.mjs'), 'utf8');
  for (const v of shipped) assert.ok(cli.includes('richapi ' + v) || cli.includes(v + ' —') || cli.includes(v + ' |'),
    `the CLI no longer documents the ${v} verb`);
});

test('the file is prose a person can read, not a wall', () => {
  const lines = readFileSync(SKILL_MD, 'utf8').split('\n');
  assert.ok(lines.length > 150, 'a skill that spends on four unverifiable endpoints needs its reasons');
  const overlong = lines
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.length > 100 && !l.trim().startsWith('|') && !l.includes('http'));
  assert.deepEqual(overlong.map(([n]) => n), [], 'lines over 100 chars outside tables');
});
